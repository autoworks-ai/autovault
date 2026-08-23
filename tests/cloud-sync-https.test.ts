import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileHashesForSkillBundle,
  signSyncRelease,
  syncBundleHash,
  type SyncRelease,
  type SyncSkillBundle
} from "../src/sync/contract.js";
import { createSyncSigningKeypair } from "../src/sync/testing.js";
import { resetConfigCache } from "../src/config.js";
import {
  completeEnrollmentFromTarget,
  installSyncResource,
  listEnrolledUpstreams,
  listSyncUpdates,
  revokeEnrollment
} from "../src/sync/local.js";
import { readSkill } from "../src/storage/index.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

const DEVICE_HEADER = "x-autovault-device";
const TIMESTAMP_HEADER = "x-autovault-timestamp";
const SIGNATURE_HEADER = "x-autovault-signature";

type PublishedVault = {
  origin: string;
  vaultUrl: string;
  catalogUrl: string;
  bundleUrl: string;
  release: SyncRelease;
  close: () => Promise<void>;
  approve: (devicePublicKey: string) => void;
  replaceCatalog: (mutator: (catalog: Record<string, unknown>) => void) => void;
  requests: Array<{ method: string; pathname: string }>;
};

function skillMd(name: string, version: string, body: string): string {
  return `---
name: ${name}
description: ${name} test skill with enough description text.
tags: [cloud-sync]
agents: [codex]
metadata:
  version: "${version}"
capabilities:
  network: false
  filesystem: readonly
  tools: []
resources:
  - path: references/notes.md
    type: file
---

# ${name}

${body}
`;
}

function canonicalHttpsBundlePath(bundleHash: string): string {
  return `bundles/${bundleHash}.json`;
}

async function publishHttpsVault(input: {
  slug: string;
  id: string;
  name: string;
  skillName: string;
  version: string;
  body: string;
  bundlePath?: string;
}): Promise<PublishedVault> {
  const signer = createSyncSigningKeypair();
  const bundle: SyncSkillBundle = {
    skill_md: skillMd(input.skillName, input.version, input.body),
    resources: [{ path: "references/notes.md", content: "published notes" }]
  };
  const bundleHash = syncBundleHash(bundle);
  const bundlePath = input.bundlePath ?? canonicalHttpsBundlePath(bundleHash);
  const release = signSyncRelease({
    id: `skill.${input.skillName}`,
    kind: "skill",
    name: input.skillName,
    version: input.version,
    channel: "stable",
    changelog: "Published through the HTTPS catalog layout.",
    policy: "auto_apply",
    file_hashes: fileHashesForSkillBundle(bundle),
    bundle_hash: bundleHash,
    bundle_path: bundlePath
  }, signer);

  const objects = new Map<string, string>([
    [`/v/${input.slug}/catalog.json`, `${JSON.stringify({
      schema_version: 1,
      id: input.id,
      name: input.name,
      public_key: signer.publicKey,
      releases: [release]
    }, null, 2)}\n`],
    [`/v/${input.slug}/${bundlePath}`, `${JSON.stringify(bundle, null, 2)}\n`]
  ]);
  const devices = new Map<string, { device_id: string; status: "pending" | "active" | "revoked" }>();
  const requests: PublishedVault["requests"] = [];

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? "/", origin);
    const method = (req.method ?? "GET").toUpperCase();
    requests.push({ method, pathname: url.pathname });
    try {
      const devicePublicKey = requireDeviceSignature(req, method, url.pathname);
      if (method === "POST" && url.pathname === `/v/${input.slug}/devices`) {
        const body = JSON.parse(await readRequestBody(req)) as { public_key?: string };
        if (body.public_key !== devicePublicKey) {
          throw httpError(400, "device public key mismatch");
        }
        const existing = devices.get(devicePublicKey) ?? {
          device_id: `device-${devices.size + 1}`,
          status: "pending" as const
        };
        devices.set(devicePublicKey, existing);
        writeJson(res, 200, existing);
        return;
      }
      const device = devices.get(devicePublicKey);
      if (!device) throw httpError(401, "unknown device");
      if (device.status === "revoked") throw httpError(403, "Enrollment revoked");
      if (method === "GET" && url.pathname === `/v/${input.slug}/devices/current`) {
        writeJson(res, 200, device);
        return;
      }
      if (method === "GET" && objects.has(url.pathname)) {
        if (url.pathname.includes("/bundles/") && device.status !== "active") {
          throw httpError(403, `Enrollment ${device.status}`);
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(objects.get(url.pathname));
        return;
      }
      throw httpError(404, `not found: ${url.pathname}`);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      writeJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const vaultUrl = `${origin}/v/${input.slug}`;
  return {
    origin,
    vaultUrl,
    catalogUrl: `${vaultUrl}/catalog.json`,
    bundleUrl: `${vaultUrl}/${bundlePath}`,
    release,
    requests,
    approve(devicePublicKey: string) {
      const device = devices.get(devicePublicKey);
      if (!device) throw new Error(`unknown device ${devicePublicKey}`);
      device.status = "active";
    },
    replaceCatalog(mutator) {
      const catalogPath = `/v/${input.slug}/catalog.json`;
      const catalog = JSON.parse(objects.get(catalogPath) ?? "null") as Record<string, unknown>;
      mutator(catalog);
      objects.set(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function httpError(status: number, message: string): HttpError {
  return new HttpError(status, message);
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(body)}\n`);
}

function requireDeviceSignature(req: http.IncomingMessage, method: string, pathname: string): string {
  const device = header(req, DEVICE_HEADER);
  const timestamp = header(req, TIMESTAMP_HEADER);
  const signature = header(req, SIGNATURE_HEADER);
  if (!device || !timestamp || !signature) {
    throw httpError(401, "missing AutoVault device headers");
  }
  const message = new TextEncoder().encode(`${method}\n${pathname}\n${timestamp}`);
  const ok = nacl.sign.detached.verify(
    message,
    new Uint8Array(Buffer.from(signature, "base64url")),
    new Uint8Array(Buffer.from(device, "base64url"))
  );
  if (!ok) throw httpError(401, "invalid device signature");
  return device;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true",
        AUTOVAULT_NO_UPDATE_CHECK: "1",
        NODE_NO_WARNINGS: "1",
        ...extraEnv
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("cloud sync HTTPS upstream", () => {
  const vaults: PublishedVault[] = [];

  afterEach(async () => {
    await Promise.all(vaults.splice(0).map((vault) => vault.close()));
  });

  it("publishes and installs a signed release through catalog.json + bundles/<bundle_hash>.json", async () => {
    const vault = await publishHttpsVault({
      slug: "acme",
      id: "acme",
      name: "ACME Cloud",
      skillName: "https-helper",
      version: "1.2.0",
      body: "HTTPS body"
    });
    vaults.push(vault);

    expect(vault.release.bundle_path).toBe(`bundles/${vault.release.bundle_hash}.json`);
    expect(vault.bundleUrl).toBe(`${vault.vaultUrl}/bundles/${vault.release.bundle_hash}.json`);

    const enrollment = await completeEnrollmentFromTarget(vault.vaultUrl);
    expect(enrollment).toMatchObject({
      id: "acme",
      type: "https",
      catalog_url: vault.catalogUrl,
      enrollment: expect.objectContaining({ status: "pending" })
    });
    expect(enrollment).not.toHaveProperty("device_secret_key");
    expect(JSON.stringify(enrollment)).not.toContain("device_secret_key");

    const pending = await listSyncUpdates();
    expect(pending.resources).toEqual([]);
    expect(pending.errors).toEqual([
      expect.objectContaining({
        upstream_id: "acme",
        error: expect.stringMatching(/pending/i)
      })
    ]);

    vault.approve(enrollment.enrollment.device_public_key);

    const updates = await listSyncUpdates();
    expect(updates.errors).toEqual([]);
    expect(updates.resources).toEqual([
      expect.objectContaining({
        id: "skill.https-helper",
        available_version: "1.2.0",
        policy: "auto_apply"
      })
    ]);

    const result = await installSyncResource({
      resource_id: "skill.https-helper",
      upstream_id: "acme"
    });
    expect(result).toMatchObject({
      installed: true,
      version: "1.2.0",
      verification: { manifest: "valid", bundle: "valid" }
    });
    expect((await readSkill("https-helper"))?.skillMd).toContain("HTTPS body");

    expect(vault.requests).toEqual(expect.arrayContaining([
      { method: "POST", pathname: "/v/acme/devices" },
      { method: "GET", pathname: "/v/acme/catalog.json" },
      { method: "GET", pathname: `/v/acme/bundles/${vault.release.bundle_hash}.json` }
    ]));
    expect(vault.requests.some((request) => request.pathname.includes("bundles/") && !request.pathname.endsWith(`/${vault.release.bundle_hash}.json`))).toBe(false);
  });

  it.each([
    ["https://evil.example/bundles/not-from-this-catalog.json"],
    ["../stolen.json"]
  ])("refuses HTTPS bundle URLs that escape the catalog origin or path prefix (%s)", async (bundlePath) => {
    const slug = bundlePath.startsWith("https:") ? "jail-origin" : "jail-prefix";
    const vault = await publishHttpsVault({
      slug,
      id: slug,
      name: "Jail Cloud",
      skillName: `${slug}-helper`,
      version: "1.0.0",
      body: "Jail body",
      bundlePath
    });
    vaults.push(vault);

    const enrollment = await completeEnrollmentFromTarget(vault.vaultUrl);
    vault.approve(enrollment.enrollment.device_public_key);
    await listSyncUpdates();

    await expect(
      installSyncResource({
        resource_id: `skill.${slug}-helper`,
        upstream_id: slug
      })
    ).rejects.toThrow(/escapes upstream catalog/i);
  });

  it("hard-fails when the live catalog public key drifts from the enrollment pin", async () => {
    const vault = await publishHttpsVault({
      slug: "rotate",
      id: "rotate",
      name: "Rotate Cloud",
      skillName: "rotate-helper",
      version: "1.0.0",
      body: "Rotate body"
    });
    vaults.push(vault);
    const enrollment = await completeEnrollmentFromTarget(vault.vaultUrl);
    vault.approve(enrollment.enrollment.device_public_key);
    expect((await listEnrolledUpstreams()).upstreams[0]?.public_key).toBe(enrollment.public_key);

    // Beta limitation: rotating the publishing key without re-enrollment is a hard fail.
    vault.replaceCatalog((catalog) => {
      catalog.public_key = createSyncSigningKeypair().publicKey;
    });

    const updates = await listSyncUpdates();
    expect(updates.resources).toEqual([]);
    expect(updates.errors).toEqual([
      expect.objectContaining({
        upstream_id: "rotate",
        error: expect.stringMatching(/public key mismatch/i)
      })
    ]);
  });

  it("enrolls an HTTPS vault through autovault init against the live URL shape", async () => {
    const vault = await publishHttpsVault({
      slug: "cli",
      id: "cli",
      name: "CLI Cloud",
      skillName: "cli-https-helper",
      version: "1.0.0",
      body: "CLI body"
    });
    vaults.push(vault);

    const result = await runCli(["init", vault.vaultUrl, "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      enrollment: {
        type: "https",
        catalog_url: vault.catalogUrl,
        enrollment: expect.objectContaining({ status: "pending" })
      }
    });
    expect(result.stdout).not.toContain("device_secret_key");
    expect(vault.requests).toEqual(expect.arrayContaining([
      { method: "POST", pathname: "/v/cli/devices" },
      { method: "GET", pathname: "/v/cli/catalog.json" }
    ]));
  });

  it("refuses loopback HTTP catalogs in remote mode", async () => {
    process.env.AUTOVAULT_MODE = "remote";
    process.env.AUTOVAULT_PUBLIC_URL = "https://example.test";
    resetConfigCache();
    await expect(
      completeEnrollmentFromTarget("http://127.0.0.1:9/v/ssrf")
    ).rejects.toThrow(/Only https catalog URLs are supported/);
  });

  it("refuses loopback HTTPS catalogs in remote mode", async () => {
    process.env.AUTOVAULT_MODE = "remote";
    process.env.AUTOVAULT_PUBLIC_URL = "https://example.test";
    resetConfigCache();
    await expect(
      completeEnrollmentFromTarget("https://127.0.0.1/v/ssrf")
    ).rejects.toThrow(/private catalog host/);
  });

  it("keeps a locally revoked HTTPS enrollment revoked after status refresh", async () => {
    const vault = await publishHttpsVault({
      slug: "revoked",
      id: "revoked",
      name: "Revoked Cloud",
      skillName: "revoked-helper",
      version: "1.0.0",
      body: "Revoked body"
    });
    vaults.push(vault);
    const enrollment = await completeEnrollmentFromTarget(vault.vaultUrl);
    vault.approve(enrollment.enrollment.device_public_key);
    await revokeEnrollment({ upstream_id: "revoked" });

    const updates = await listSyncUpdates();
    expect(updates.resources).toEqual([]);
    expect(updates.errors).toEqual([
      expect.objectContaining({
        upstream_id: "revoked",
        error: expect.stringMatching(/revoked/i)
      })
    ]);
    expect((await listEnrolledUpstreams()).upstreams[0]?.enrollment.status).toBe("revoked");
  });
});

