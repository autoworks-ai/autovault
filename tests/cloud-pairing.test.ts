import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_CODE_GRANT_TYPE,
  SYNC_DEVICE_PAIR_PATH,
  SYNC_DEVICE_TOKEN_PATH,
} from "../src/sync/contract.js";
import {
  HttpsSyncError,
  pollDevicePairing,
  startDevicePairing,
} from "../src/sync/https.js";
import {
  completeCloudPairing,
  ensureCloudPairing,
  progressCloudPairing,
  startCloudPairing,
} from "../src/sync/local.js";
import { createSyncSigningKeypair } from "../src/sync/testing.js";
import { cloudApiUrl, cloudPairUrl } from "../src/sync/target.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

const DEVICE_HEADER = "x-autovault-device";
const TIMESTAMP_HEADER = "x-autovault-timestamp";
const SIGNATURE_HEADER = "x-autovault-signature";

type PairingCloud = {
  origin: string;
  slug: string;
  catalogUrl: string;
  requests: Array<{ method: string; pathname: string }>;
  confirm: (publicKey: string) => void;
  deny: (publicKey: string) => void;
  expire: (publicKey: string) => void;
  userCodeFor: (publicKey: string) => string;
  close: () => Promise<void>;
};

async function publishPairingCloud(input?: {
  slug?: string;
  unpublished?: boolean;
  interval?: number;
  omitInterval?: boolean;
  slowDown?: number;
}): Promise<PairingCloud> {
  const slug = input?.slug ?? "acme";
  const catalogPath = `/v/${slug}/catalog.json`;
  const catalogBody = `${JSON.stringify({
    schema_version: 1,
    id: slug,
    name: "ACME Cloud",
    public_key: createSyncSigningKeypair().publicKey,
    releases: [],
  })}\n`;
  const objects = new Map<string, string>();
  if (!input?.unpublished) objects.set(catalogPath, catalogBody);

  const devices = new Map<
    string,
    { device_id: string; status: "pending" | "active" | "revoked" }
  >();
  const pairings = new Map<
    string,
    {
      publicKey: string;
      userCode: string;
      deviceCode: string;
      confirmed: boolean;
      denied: boolean;
      expiresAt: number;
    }
  >();
  const requests: PairingCloud["requests"] = [];
  let pairCount = 0;
  let slowDownRemaining = input?.slowDown ?? 0;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? "/", origin);
    const method = (req.method ?? "GET").toUpperCase();
    requests.push({ method, pathname: url.pathname });
    try {
      const devicePublicKey = requireDeviceSignature(req, method, url.pathname);
      if (method === "POST" && url.pathname === SYNC_DEVICE_PAIR_PATH) {
        const body = JSON.parse(await readRequestBody(req)) as {
          public_key?: string;
        };
        if (body.public_key !== devicePublicKey) {
          throw httpError(400, "device public key mismatch");
        }
        pairCount += 1;
        const userCode = pairCount === 1 ? "WDJB-MJHT" : `CODE-${pairCount}`;
        const deviceCode = `devicecode${String(pairCount).padStart(16, "0")}`;
        pairings.set(deviceCode, {
          publicKey: devicePublicKey,
          userCode,
          deviceCode,
          confirmed: false,
          denied: false,
          expiresAt: Date.now() + 15 * 60 * 1000,
        });
        writeJson(res, 200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${origin}/cloud/pair`,
          verification_uri_complete: `${origin}/cloud/pair?code=${encodeURIComponent(userCode)}`,
          expires_in: 900,
          ...(input?.omitInterval ? {} : { interval: input?.interval ?? 0 }),
        });
        return;
      }
      if (method === "POST" && url.pathname === SYNC_DEVICE_TOKEN_PATH) {
        const body = JSON.parse(await readRequestBody(req)) as {
          device_code?: string;
          grant_type?: string;
        };
        if (body.grant_type !== DEVICE_CODE_GRANT_TYPE) {
          throw httpError(400, "invalid_grant");
        }
        const pairing = body.device_code
          ? pairings.get(body.device_code)
          : undefined;
        if (!pairing || pairing.publicKey !== devicePublicKey) {
          writeJson(res, 400, { error: "invalid_grant" });
          return;
        }
        if (slowDownRemaining > 0) {
          slowDownRemaining -= 1;
          writeJson(res, 400, { error: "slow_down" });
          return;
        }
        if (pairing.denied) {
          writeJson(res, 400, { error: "access_denied" });
          return;
        }
        if (Date.now() >= pairing.expiresAt) {
          writeJson(res, 400, { error: "expired_token" });
          return;
        }
        if (!pairing.confirmed) {
          writeJson(res, 400, { error: "authorization_pending" });
          return;
        }
        const existing = devices.get(devicePublicKey) ?? {
          device_id: `device-${devices.size + 1}`,
          status: "active" as const,
        };
        devices.set(devicePublicKey, existing);
        writeJson(res, 200, {
          slug,
          catalog_url: `${origin}/v/${slug}/catalog.json`,
          device_id: existing.device_id,
          status: existing.status,
        });
        return;
      }
      const vaultPrefix = `/v/${slug}`;
      if (
        url.pathname !== vaultPrefix &&
        !url.pathname.startsWith(`${vaultPrefix}/`)
      ) {
        throw httpError(404, "No such vault.");
      }
      if (method === "POST" && url.pathname === `/v/${slug}/devices`) {
        const body = JSON.parse(await readRequestBody(req)) as {
          public_key?: string;
        };
        if (body.public_key !== devicePublicKey) {
          throw httpError(400, "device public key mismatch");
        }
        const existing = devices.get(devicePublicKey) ?? {
          device_id: `device-${devices.size + 1}`,
          status: "pending" as const,
        };
        devices.set(devicePublicKey, existing);
        writeJson(res, 200, existing);
        return;
      }
      const device = devices.get(devicePublicKey);
      if (!device) throw httpError(401, "unknown device");
      if (
        method === "GET" &&
        url.pathname === `/v/${slug}/devices/current`
      ) {
        writeJson(res, 200, device);
        return;
      }
      if (method === "GET" && objects.has(url.pathname)) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(objects.get(url.pathname));
        return;
      }
      if (method === "GET" && url.pathname === catalogPath) {
        throw httpError(404, "This vault has no published catalog yet.");
      }
      throw httpError(404, `not found: ${url.pathname}`);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      writeJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    slug,
    catalogUrl: `${origin}/v/${slug}/catalog.json`,
    requests,
    confirm(publicKey: string) {
      const pairing = [...pairings.values()].find(
        (entry) => entry.publicKey === publicKey,
      );
      if (!pairing) throw new Error(`unknown pairing ${publicKey}`);
      pairing.confirmed = true;
    },
    deny(publicKey: string) {
      const pairing = [...pairings.values()].find(
        (entry) => entry.publicKey === publicKey,
      );
      if (!pairing) throw new Error(`unknown pairing ${publicKey}`);
      pairing.denied = true;
    },
    expire(publicKey: string) {
      const pairing = [...pairings.values()].find(
        (entry) => entry.publicKey === publicKey,
      );
      if (!pairing) throw new Error(`unknown pairing ${publicKey}`);
      pairing.expiresAt = Date.now() - 1;
    },
    userCodeFor(publicKey: string) {
      const pairing = [...pairings.values()].find(
        (entry) => entry.publicKey === publicKey,
      );
      if (!pairing) throw new Error(`unknown pairing ${publicKey}`);
      return pairing.userCode;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function httpError(status: number, message: string): HttpError {
  return new HttpError(status, message);
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store, private");
  res.end(`${JSON.stringify(body)}\n`);
}

function requireDeviceSignature(
  req: http.IncomingMessage,
  method: string,
  pathname: string,
): string {
  const device = header(req, DEVICE_HEADER);
  const timestamp = header(req, TIMESTAMP_HEADER);
  const signature = header(req, SIGNATURE_HEADER);
  if (!device || !timestamp || !signature) {
    throw httpError(401, "missing AutoVault device headers");
  }
  const message = new TextEncoder().encode(
    `${method}\n${pathname}\n${timestamp}`,
  );
  const ok = nacl.sign.detached.verify(
    message,
    new Uint8Array(Buffer.from(signature, "base64url")),
    new Uint8Array(Buffer.from(device, "base64url")),
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
  extraEnv: Record<string, string> = {},
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
        ...extraEnv,
      },
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

describe("device pairing (RFC 8628-shaped)", () => {
  const clouds: PairingCloud[] = [];

  afterEach(async () => {
    await Promise.all(clouds.splice(0).map((cloud) => cloud.close()));
    delete process.env.AUTOVAULT_CLOUD_ORIGIN;
  });

  it("builds slug-less pairing URLs on the Cloud origin", () => {
    process.env.AUTOVAULT_CLOUD_ORIGIN = "https://autovault.dev";
    expect(cloudApiUrl(SYNC_DEVICE_PAIR_PATH).href).toBe(
      "https://autovault.dev/api/devices/pair",
    );
    expect(cloudApiUrl(SYNC_DEVICE_TOKEN_PATH).href).toBe(
      "https://autovault.dev/api/devices/token",
    );
    expect(cloudPairUrl("WDJB-MJHT")).toBe(
      "https://autovault.dev/cloud/pair?code=WDJB-MJHT",
    );
  });

  it("starts pairing with a self-signed POST to /api/devices/pair", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const device = createSyncSigningKeypair();

    const started = await startDevicePairing(device);

    expect(started).toMatchObject({
      user_code: "WDJB-MJHT",
      verification_uri: `${cloud.origin}/cloud/pair`,
      verification_uri_complete: `${cloud.origin}/cloud/pair?code=WDJB-MJHT`,
      expires_in: 900,
      interval: 0,
    });
    expect(started.device_code.length).toBeGreaterThanOrEqual(16);
    expect(cloud.requests).toEqual([
      { method: "POST", pathname: "/api/devices/pair" },
    ]);
  });

  it("defaults an omitted pairing interval to five seconds", async () => {
    const cloud = await publishPairingCloud({ omitInterval: true });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const started = await startDevicePairing(createSyncSigningKeypair());
    expect(started.interval).toBe(5);
    const pairing = await startCloudPairing();
    expect(pairing.interval).toBe(5);
  });

  it("polls authorization_pending until the owner confirms the code", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const device = createSyncSigningKeypair();
    const started = await startDevicePairing(device);

    await expect(pollDevicePairing(device, started.device_code)).resolves.toEqual(
      { state: "pending" },
    );

    cloud.confirm(device.publicKey);
    await expect(pollDevicePairing(device, started.device_code)).resolves.toEqual(
      {
        state: "authorized",
        result: {
          slug: "acme",
          catalog_url: cloud.catalogUrl,
          device_id: "device-1",
          status: "active",
        },
      },
    );
  });

  it("fails pairing on access_denied and expired_token", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const denied = createSyncSigningKeypair();
    const expired = createSyncSigningKeypair();
    const deniedStart = await startDevicePairing(denied);
    const expiredStart = await startDevicePairing(expired);
    cloud.deny(denied.publicKey);
    cloud.expire(expired.publicKey);

    await expect(
      pollDevicePairing(denied, deniedStart.device_code),
    ).rejects.toMatchObject({
      name: "HttpsSyncError",
      status: 400,
      serverMessage: "access_denied",
    });
    await expect(
      pollDevicePairing(expired, expiredStart.device_code),
    ).rejects.toMatchObject({
      name: "HttpsSyncError",
      status: 400,
      serverMessage: "expired_token",
    });
    expect(HttpsSyncError).toBeDefined();
  });

  it("clears pairing state after access_denied so retry mints a new code", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const first = await startCloudPairing();
    cloud.deny(await pairingPublicKey());

    await expect(
      completeCloudPairing({ sleep: async () => {} }),
    ).rejects.toMatchObject({
      name: "HttpsSyncError",
      serverMessage: "access_denied",
    });
    await expect(
      fs.stat(path.join(currentStorageRoot(), "cloud-sync", "pairing.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const retry = await ensureCloudPairing();
    expect(retry.user_code).not.toBe(first.user_code);
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_PAIR_PATH),
    ).toHaveLength(2);
  });

  it("persists slow_down backoff for the next JSON poll", async () => {
    const cloud = await publishPairingCloud({ interval: 1, slowDown: 1 });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    await backdatePairingClock(2_000);
    const progressed = await progressCloudPairing({
      wait: false,
      sleep: async () => {},
    });
    expect(progressed).toMatchObject({
      status: "pending",
      pairing: { interval: 6 },
    });
    const tokenPolls = cloud.requests.filter(
      (request) => request.pathname === SYNC_DEVICE_TOKEN_PATH,
    ).length;
    const skipped = await progressCloudPairing({
      wait: false,
      sleep: async () => {},
    });
    expect(skipped).toMatchObject({
      status: "pending",
      pairing: { interval: 6 },
    });
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_TOKEN_PATH),
    ).toHaveLength(tokenPolls);
  });

  it("skips the first JSON token poll until the advertised interval elapses", async () => {
    const cloud = await publishPairingCloud({ interval: 5 });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    const skipped = await progressCloudPairing({
      wait: false,
      sleep: async () => {},
    });
    expect(skipped).toMatchObject({
      status: "pending",
      pairing: { interval: 5 },
    });
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_TOKEN_PATH),
    ).toHaveLength(0);
  });

  it("waits the advertised interval before the first interactive token poll", async () => {
    const cloud = await publishPairingCloud({ interval: 5 });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    const sleeps: number[] = [];
    const pending = progressCloudPairing({
      wait: true,
      sleep: async (ms) => {
        sleeps.push(ms);
        cloud.confirm(await pairingPublicKey());
      },
    });
    await expect(pending).resolves.toMatchObject({
      status: "complete",
      enrollment: { catalog_url: cloud.catalogUrl },
    });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(4_000);
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_TOKEN_PATH),
    ).toHaveLength(1);
  });

  it("clears pairing state after invalid_grant so retry mints a new code", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    await patchPairingState({ device_code: "unknown-device-code" });
    await expect(
      progressCloudPairing({ wait: false, sleep: async () => {} }),
    ).rejects.toMatchObject({
      name: "HttpsSyncError",
      serverMessage: "invalid_grant",
    });
    await expect(fs.stat(pairingStatePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
    const retry = await ensureCloudPairing();
    expect(retry.verification_uri).toBe(`${cloud.origin}/cloud/pair`);
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_PAIR_PATH),
    ).toHaveLength(2);
  });

  it("clamps a zero pairing interval before the interactive wait sleeps", async () => {
    const cloud = await publishPairingCloud({ interval: 0 });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    const sleeps: number[] = [];
    const pending = progressCloudPairing({
      wait: true,
      sleep: async (ms) => {
        sleeps.push(ms);
        cloud.confirm(await pairingPublicKey());
      },
    });
    await expect(pending).resolves.toMatchObject({
      status: "complete",
      enrollment: { catalog_url: cloud.catalogUrl },
    });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(4_000);
  });

  it("discards a cached pairing when AUTOVAULT_CLOUD_ORIGIN changes", async () => {
    const first = await publishPairingCloud({ slug: "one" });
    const second = await publishPairingCloud({ slug: "two" });
    clouds.push(first, second);
    process.env.AUTOVAULT_CLOUD_ORIGIN = first.origin;
    await startCloudPairing();
    process.env.AUTOVAULT_CLOUD_ORIGIN = second.origin;
    const resumed = await ensureCloudPairing();
    expect(resumed.verification_uri).toBe(`${second.origin}/cloud/pair`);
    expect(
      first.requests.filter((request) => request.pathname === SYNC_DEVICE_PAIR_PATH),
    ).toHaveLength(1);
    expect(
      second.requests.filter((request) => request.pathname === SYNC_DEVICE_PAIR_PATH),
    ).toHaveLength(1);
  });

  it("treats a pairing cache without origin as stale", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    const pairingPath = path.join(
      currentStorageRoot(),
      "cloud-sync",
      "pairing.json",
    );
    const stored = JSON.parse(await fs.readFile(pairingPath, "utf8")) as {
      origin?: string;
    };
    delete stored.origin;
    await fs.writeFile(pairingPath, `${JSON.stringify(stored, null, 2)}\n`);
    const resumed = await ensureCloudPairing();
    expect(resumed.verification_uri).toBe(`${cloud.origin}/cloud/pair`);
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_PAIR_PATH),
    ).toHaveLength(2);
  });

  it("stores a Cloud enrollment from pairing without posting /v/<slug>/devices", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;

    const pairing = await startCloudPairing();
    expect(pairing.user_code).toBe("WDJB-MJHT");
    expect(pairing.fingerprint.length).toBeGreaterThan(4);

    cloud.confirm(await pairingPublicKey());

    const enrollment = await completeCloudPairing({
      sleep: async () => {},
    });
    expect(enrollment).toMatchObject({
      id: "acme",
      type: "https",
      catalog_url: cloud.catalogUrl,
      catalog_status: "ready",
      enrollment: expect.objectContaining({ status: "active" }),
    });
    expect(JSON.stringify(enrollment)).not.toContain("device_secret_key");
    expect(cloud.requests).toEqual(
      expect.arrayContaining([
        { method: "POST", pathname: "/api/devices/pair" },
        { method: "POST", pathname: "/api/devices/token" },
        { method: "GET", pathname: "/v/acme/catalog.json" },
      ]),
    );
    expect(cloud.requests).not.toEqual(
      expect.arrayContaining([
        { method: "POST", pathname: "/v/acme/devices" },
      ]),
    );
  });

  it("resumes an in-flight pairing instead of minting a second code", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const first = await startCloudPairing();
    const second = await ensureCloudPairing();
    expect(second.user_code).toBe(first.user_code);
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_PAIR_PATH),
    ).toHaveLength(1);
  });

  it("serializes concurrent ensureCloudPairing so only one code is minted", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const [first, second] = await Promise.all([
      ensureCloudPairing(),
      ensureCloudPairing(),
    ]);
    expect(second.user_code).toBe(first.user_code);
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_PAIR_PATH),
    ).toHaveLength(1);
  });

  it("serializes concurrent JSON token polls onto one request", async () => {
    const cloud = await publishPairingCloud({ interval: 1 });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    await backdatePairingClock(2_000);
    const [first, second] = await Promise.all([
      progressCloudPairing({ wait: false, sleep: async () => {} }),
      progressCloudPairing({ wait: false, sleep: async () => {} }),
    ]);
    expect(first.status).toBe("pending");
    expect(second.status).toBe("pending");
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_TOKEN_PATH),
    ).toHaveLength(1);
  });

  it("raises a local expiry without polling an already-expired pairing", async () => {
    const cloud = await publishPairingCloud({ interval: 0 });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    await patchPairingState({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(
      progressCloudPairing({ wait: false, sleep: async () => {} }),
    ).rejects.toThrow(/expired/i);
    expect(
      cloud.requests.filter((request) => request.pathname === SYNC_DEVICE_TOKEN_PATH),
    ).toHaveLength(0);
  });

  it("clears an exactly-due pairing under the lock without sleeping", async () => {
    const cloud = await publishPairingCloud({ interval: 5 });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    await patchPairingState({
      expires_at: new Date().toISOString(),
    });
    await expect(
      progressCloudPairing({
        wait: true,
        sleep: async () => {
          throw new Error("should not sleep past a due pairing deadline");
        },
      }),
    ).rejects.toThrow(/expired/i);
    await expect(fs.stat(pairingStatePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reclaims a leftover file lock from the previous protocol", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const lockPath = path.join(
      currentStorageRoot(),
      "cloud-sync",
      "pairing.lock",
    );
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "999999\ndead-token\n");
    const pairing = await ensureCloudPairing();
    expect(pairing.verification_uri).toBe(`${cloud.origin}/cloud/pair`);
  });

  it("reclaims a leftover mkdir lock from the previous protocol", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const lockPath = path.join(currentStorageRoot(), "cloud-sync", "pairing.lock");
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, "pid"), "999999\ndead-token\n");
    const pairing = await ensureCloudPairing();
    expect(pairing.verification_uri).toBe(`${cloud.origin}/cloud/pair`);
  });

  it("lets concurrent waiters share one pairing past a leftover lock artifact", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const lockPath = path.join(
      currentStorageRoot(),
      "cloud-sync",
      "pairing.lock",
    );
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, "pid"), "999999\ndead-token\n");
    const [first, second] = await Promise.all([
      ensureCloudPairing(),
      ensureCloudPairing(),
    ]);
    expect(second.user_code).toBe(first.user_code);
    expect(
      cloud.requests.filter(
        (request) => request.pathname === SYNC_DEVICE_PAIR_PATH,
      ),
    ).toHaveLength(1);
  });

  it("waits on a live flock and proceeds after the holder dies", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    const holder = await holdPairingFlockUntilKilled();
    try {
      const pending = ensureCloudPairing();
      await defaultSleep(200);
      expect(
        cloud.requests.filter(
          (request) => request.pathname === SYNC_DEVICE_PAIR_PATH,
        ),
      ).toHaveLength(0);
      holder.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        holder.once("close", () => resolve()),
      );
      const pairing = await pending;
      expect(pairing.verification_uri).toBe(`${cloud.origin}/cloud/pair`);
      expect(
        cloud.requests.filter(
          (request) => request.pathname === SYNC_DEVICE_PAIR_PATH,
        ),
      ).toHaveLength(1);
    } finally {
      if (!holder.killed && holder.exitCode === null) {
        holder.kill("SIGKILL");
      }
    }
  });

  it("pairs an unpublished vault and keeps catalog_status unpublished", async () => {
    const cloud = await publishPairingCloud({ unpublished: true });
    clouds.push(cloud);
    process.env.AUTOVAULT_CLOUD_ORIGIN = cloud.origin;
    await startCloudPairing();
    cloud.confirm(await pairingPublicKey());
    const enrollment = await completeCloudPairing({ sleep: async () => {} });
    expect(enrollment).toMatchObject({
      id: "cloud:acme",
      catalog_status: "unpublished",
      enrollment: expect.objectContaining({ status: "active" }),
    });
  });

  it("lets autovault link with no argument start pairing", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    const result = await runCli(["link", "--json"], {
      AUTOVAULT_CLOUD_ORIGIN: cloud.origin,
      CI: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout) as {
      pairing: {
        user_code: string;
        verification_uri_complete: string;
        fingerprint: string;
      };
    };
    expect(body.pairing.user_code).toBe("WDJB-MJHT");
    expect(body.pairing.verification_uri_complete).toContain("/cloud/pair?code=");
    expect(result.stdout).not.toContain("device_secret_key");
    expect(result.stdout).not.toContain("device_code");
    expect(cloud.requests).toEqual([
      { method: "POST", pathname: "/api/devices/pair" },
      { method: "POST", pathname: "/api/devices/token" },
    ]);
  });

  it("lets autovault link --json finish pairing after the owner confirms", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    const started = await runCli(["link", "--json"], {
      AUTOVAULT_CLOUD_ORIGIN: cloud.origin,
      CI: "1",
    });
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({
      pairing: { user_code: "WDJB-MJHT" },
    });

    cloud.confirm(await pairingPublicKey());
    const finished = await runCli(["link", "--json"], {
      AUTOVAULT_CLOUD_ORIGIN: cloud.origin,
      CI: "1",
    });
    expect(finished.status).toBe(0);
    expect(JSON.parse(finished.stdout)).toMatchObject({
      enrollment: {
        type: "https",
        catalog_url: cloud.catalogUrl,
        enrollment: expect.objectContaining({ status: "active" }),
      },
    });
    expect(finished.stdout).not.toContain("device_secret_key");
    expect(finished.stdout).not.toContain('"pairing"');
  });

  it("prints usage for autovault link --help without contacting Cloud", async () => {
    const result = await runCli(["link", "--help"], {
      CI: "1",
      NO_COLOR: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("autovault link");
    expect(result.stdout).not.toContain("WDJB-MJHT");
  });

  it("rejects unknown autovault link options instead of starting pairing", async () => {
    const result = await runCli(["link", "--jsno"], {
      CI: "1",
      NO_COLOR: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option: --jsno");
    expect(result.stdout).not.toContain("WDJB-MJHT");
  });

  it("prints the user code from autovault link with no argument", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    const result = await runCli(["link"], {
      AUTOVAULT_CLOUD_ORIGIN: cloud.origin,
      CI: "1",
      NO_COLOR: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WDJB-MJHT");
    expect(result.stdout).toContain("/cloud/pair?code=");
    expect(result.stdout).not.toContain("Usage:");
  });

  it("keeps autovault link <slug> on the existing enrollment path", async () => {
    const cloud = await publishPairingCloud();
    clouds.push(cloud);
    const result = await runCli(["link", "acme", "--json"], {
      AUTOVAULT_CLOUD_ORIGIN: cloud.origin,
      CI: "1",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      enrollment: {
        type: "https",
        catalog_url: cloud.catalogUrl,
        enrollment: expect.objectContaining({ status: "pending" }),
      },
    });
    expect(cloud.requests).toEqual(
      expect.arrayContaining([
        { method: "POST", pathname: "/v/acme/devices" },
        { method: "GET", pathname: "/v/acme/catalog.json" },
      ]),
    );
    expect(cloud.requests).not.toEqual(
      expect.arrayContaining([
        { method: "POST", pathname: "/api/devices/pair" },
      ]),
    );
  });
});

async function pairingPublicKey(): Promise<string> {
  const stored = await readPairingStateFile();
  return stored.device_public_key;
}

function pairingStatePath(): string {
  return path.join(currentStorageRoot(), "cloud-sync", "pairing.json");
}

async function readPairingStateFile(): Promise<{
  device_public_key: string;
  device_code: string;
  started_at: string;
  last_polled_at?: string;
}> {
  const raw = await fs.readFile(pairingStatePath(), "utf8");
  return JSON.parse(raw) as {
    device_public_key: string;
    device_code: string;
    started_at: string;
    last_polled_at?: string;
  };
}

async function patchPairingState(patch: Record<string, unknown>): Promise<void> {
  const stored = {
    ...(await readPairingStateFile()),
    ...patch,
  };
  await fs.writeFile(pairingStatePath(), `${JSON.stringify(stored, null, 2)}\n`);
}

async function backdatePairingClock(ms: number): Promise<void> {
  const stored = await readPairingStateFile();
  const shift = (iso: string) => new Date(Date.parse(iso) - ms).toISOString();
  await patchPairingState({
    started_at: shift(stored.started_at),
    ...(stored.last_polled_at
      ? { last_polled_at: shift(stored.last_polled_at) }
      : {}),
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function holdPairingFlockUntilKilled() {
  const lockPath = path.join(
    currentStorageRoot(),
    "cloud-sync",
    "pairing.lock",
  );
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
      const Database = require("better-sqlite3");
      const db = new Database(${JSON.stringify(lockPath)}, { timeout: 0 });
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1 << 30);
      `,
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += String(chunk);
      if (buf.includes("locked")) resolve();
    });
    child.stderr.on("data", (chunk) => {
      buf += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      reject(
        new Error(
          `flock holder exited before locking (${code ?? signal}): ${buf}`,
        ),
      );
    });
  });
  child.removeAllListeners("exit");
  return child;
}
