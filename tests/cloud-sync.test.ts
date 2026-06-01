import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSyncSigningKeypair,
  createSignedSkillRelease,
  writeFakeUpstreamCatalog
} from "../src/sync/testing.js";
import {
  completeEnrollment,
  initEnrollment,
  installSyncResource,
  listEnrolledUpstreams,
  listSyncUpdates,
  revokeEnrollment
} from "../src/sync/local.js";
import { readSkill, writeSkill } from "../src/storage/index.js";
import { startLocalUiServer, type LocalUiServerHandle } from "../src/ui/local-server.js";
import { currentStorageRoot } from "./setup.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function skillMd(name: string, version: string, body = "Body", resources: string[] = []): string {
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
${resources.length > 0
    ? `resources:
${resources.map((resource) => `  - path: ${resource}\n    type: file`).join("\n")}`
    : ""}
---

# ${name}

${body}
`;
}

async function api(
  handle: LocalUiServerHandle,
  pathName: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${handle.token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${handle.url}${pathName}`, { ...init, headers });
}

describe("cloud sync foundation", () => {
  let handles: LocalUiServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.close()));
    handles = [];
  });

  async function start(): Promise<LocalUiServerHandle> {
    const handle = await startLocalUiServer({ port: 0, open: false });
    handles.push(handle);
    return handle;
  }

  it("enrolls a file upstream, checks metadata-only updates, and installs a verified skill release", async () => {
    await writeSkill("acme-helper", skillMd("acme-helper", "1.0.0", "Old body"));
    const upstreamDir = path.join(currentStorageRoot(), "fake-upstream");
    const signer = createSyncSigningKeypair();
    const release = createSignedSkillRelease({
      signer,
      resource: { id: "skill.acme-helper", kind: "skill", name: "acme-helper" },
      version: "1.1.0",
      channel: "stable",
      policy: "user_approve",
      changelog: "Improves the ACME onboarding instructions.",
      skillMd: skillMd("acme-helper", "1.1.0", "New body", ["references/acme.md"]),
      resources: [{ path: "references/acme.md", content: "ACME notes" }]
    });
    const catalogPath = await writeFakeUpstreamCatalog(upstreamDir, {
      id: "acme",
      name: "ACME Vault",
      publicKey: signer.publicKey,
      releases: [release]
    });

    const enrollment = await completeEnrollment({
      upstream: {
        id: "acme",
        name: "ACME Vault",
        type: "file",
        catalog_path: catalogPath,
        public_key: signer.publicKey
      }
    });
    expect(enrollment.enrollment.status).toBe("active");

    const updates = await listSyncUpdates();
    expect(updates.resources).toEqual([
      expect.objectContaining({
        id: "skill.acme-helper",
        upstream_id: "acme",
        kind: "skill",
        name: "acme-helper",
        installed_version: "1.0.0",
        available_version: "1.1.0",
        policy: "user_approve",
        policy_action: "user_approve",
        installable: true
      })
    ]);
    expect(updates.resources[0]).not.toHaveProperty("bundle");

    const result = await installSyncResource({
      resource_id: "skill.acme-helper",
      upstream_id: "acme",
      accept: true
    });
    expect(result).toMatchObject({
      installed: true,
      resource_id: "skill.acme-helper",
      version: "1.1.0",
      verification: { manifest: "valid", bundle: "valid" }
    });

    const installed = await readSkill("acme-helper");
    expect(installed?.version).toBe("1.1.0");
    expect(installed?.skillMd).toContain("New body");
    expect(installed?.resources).toEqual([{ path: "references/acme.md", type: "file" }]);
  });

  it("blocks admin-held updates and revoked enrollments", async () => {
    await writeSkill("held-helper", skillMd("held-helper", "1.0.0"));
    const upstreamDir = path.join(currentStorageRoot(), "held-upstream");
    const signer = createSyncSigningKeypair();
    const release = createSignedSkillRelease({
      signer,
      resource: { id: "skill.held-helper", kind: "skill", name: "held-helper" },
      version: "1.1.0",
      channel: "stable",
      policy: "admin_hold",
      changelog: "Held for administrator rollout.",
      skillMd: skillMd("held-helper", "1.1.0")
    });
    const catalogPath = await writeFakeUpstreamCatalog(upstreamDir, {
      id: "held",
      name: "Held Vault",
      publicKey: signer.publicKey,
      releases: [release]
    });
    await completeEnrollment({
      upstream: {
        id: "held",
        name: "Held Vault",
        type: "file",
        catalog_path: catalogPath,
        public_key: signer.publicKey
      }
    });

    const updates = await listSyncUpdates();
    expect(updates.resources[0]).toMatchObject({
      policy: "admin_hold",
      policy_action: "admin_hold",
      installable: false
    });
    await expect(
      installSyncResource({
        resource_id: "skill.held-helper",
        upstream_id: "held",
        accept: true
      })
    ).rejects.toThrow(/held for administrator review/i);

    await revokeEnrollment({ upstream_id: "held" });
    expect((await listEnrolledUpstreams()).upstreams[0]).toMatchObject({
      id: "held",
      enrollment: expect.objectContaining({ status: "revoked" })
    });
    const revokedUpdates = await listSyncUpdates();
    expect(revokedUpdates.resources).toEqual([]);
    expect(revokedUpdates.errors).toEqual([
      expect.objectContaining({
        upstream_id: "held",
        error: expect.stringMatching(/revoked/i)
      })
    ]);
  });

  it("blocks pending enrollments until completion", async () => {
    const upstreamDir = path.join(currentStorageRoot(), "pending-upstream");
    const signer = createSyncSigningKeypair();
    const release = createSignedSkillRelease({
      signer,
      resource: { id: "skill.pending-helper", kind: "skill", name: "pending-helper" },
      version: "1.0.0",
      channel: "stable",
      policy: "auto_apply",
      changelog: "Pending enrollment should not see this yet.",
      skillMd: skillMd("pending-helper", "1.0.0")
    });
    const catalogPath = await writeFakeUpstreamCatalog(upstreamDir, {
      id: "pending",
      name: "Pending Vault",
      publicKey: signer.publicKey,
      releases: [release]
    });
    await initEnrollment({
      upstream: {
        id: "pending",
        name: "Pending Vault",
        type: "file",
        catalog_path: catalogPath,
        public_key: signer.publicKey
      }
    });

    const updates = await listSyncUpdates();
    expect(updates.resources).toEqual([]);
    expect(updates.errors).toEqual([
      expect.objectContaining({
        upstream_id: "pending",
        error: expect.stringMatching(/pending/i)
      })
    ]);

    await expect(
      installSyncResource({
        resource_id: "skill.pending-helper",
        upstream_id: "pending"
      })
    ).rejects.toThrow(/pending/i);
  });

  it("allows auto-apply releases to install without an explicit approval flag", async () => {
    const upstreamDir = path.join(currentStorageRoot(), "auto-upstream");
    const signer = createSyncSigningKeypair();
    const release = createSignedSkillRelease({
      signer,
      resource: { id: "skill.auto-helper", kind: "skill", name: "auto-helper" },
      version: "1.0.0",
      channel: "stable",
      policy: "auto_apply",
      changelog: "Initial automatically approved release.",
      skillMd: skillMd("auto-helper", "1.0.0", "Auto body")
    });
    const catalogPath = await writeFakeUpstreamCatalog(upstreamDir, {
      id: "auto",
      name: "Auto Vault",
      publicKey: signer.publicKey,
      releases: [release]
    });
    await completeEnrollment({
      upstream: {
        id: "auto",
        name: "Auto Vault",
        type: "file",
        catalog_path: catalogPath,
        public_key: signer.publicKey
      }
    });

    const updates = await listSyncUpdates();
    expect(updates.resources[0]).toMatchObject({
      id: "skill.auto-helper",
      policy: "auto_apply",
      installable: true
    });

    const result = await installSyncResource({
      resource_id: "skill.auto-helper",
      upstream_id: "auto"
    });
    expect(result).toMatchObject({
      installed: true,
      verification: { manifest: "valid", bundle: "valid" }
    });
    expect((await readSkill("auto-helper"))?.skillMd).toContain("Auto body");
  });

  it("refuses to install tampered bundles", async () => {
    await writeSkill("tamper-helper", skillMd("tamper-helper", "1.0.0"));
    const upstreamDir = path.join(currentStorageRoot(), "tamper-upstream");
    const signer = createSyncSigningKeypair();
    const release = createSignedSkillRelease({
      signer,
      resource: { id: "skill.tamper-helper", kind: "skill", name: "tamper-helper" },
      version: "1.1.0",
      channel: "stable",
      policy: "user_approve",
      changelog: "Will be tampered after signing.",
      skillMd: skillMd("tamper-helper", "1.1.0", "Signed body")
    });
    const catalogPath = await writeFakeUpstreamCatalog(upstreamDir, {
      id: "tamper",
      name: "Tamper Vault",
      publicKey: signer.publicKey,
      releases: [release]
    });
    const bundlePath = path.join(upstreamDir, release.bundle_path);
    const bundle = JSON.parse(await fs.readFile(bundlePath, "utf-8")) as {
      skill_md: string;
      resources: Array<{ path: string; content: string }>;
    };
    bundle.skill_md = skillMd("tamper-helper", "1.1.0", "Tampered body");
    await fs.writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8");
    await completeEnrollment({
      upstream: {
        id: "tamper",
        name: "Tamper Vault",
        type: "file",
        catalog_path: catalogPath,
        public_key: signer.publicKey
      }
    });

    await expect(
      installSyncResource({
        resource_id: "skill.tamper-helper",
        upstream_id: "tamper",
        accept: true
      })
    ).rejects.toThrow(/bundle hash mismatch/i);
    expect((await readSkill("tamper-helper"))?.skillMd).toContain("Body");
  });

  it("exposes upstreams, sync updates, install, and revoke through the management API", async () => {
    await writeSkill("api-helper", skillMd("api-helper", "1.0.0"));
    const upstreamDir = path.join(currentStorageRoot(), "api-upstream");
    const signer = createSyncSigningKeypair();
    const release = createSignedSkillRelease({
      signer,
      resource: { id: "skill.api-helper", kind: "skill", name: "api-helper" },
      version: "1.1.0",
      channel: "stable",
      policy: "user_approve",
      changelog: "API-visible update.",
      skillMd: skillMd("api-helper", "1.1.0", "API body")
    });
    const catalogPath = await writeFakeUpstreamCatalog(upstreamDir, {
      id: "api",
      name: "API Vault",
      publicKey: signer.publicKey,
      releases: [release]
    });
    const handle = await start();

    const complete = await api(handle, "/api/v1/enrollments/complete", {
      method: "POST",
      headers: { origin: handle.url },
      body: JSON.stringify({
        upstream: {
          id: "api",
          name: "API Vault",
          type: "file",
          catalog_path: catalogPath,
          public_key: signer.publicKey
        }
      })
    });
    expect(complete.status).toBe(200);

    const upstreams = await api(handle, "/api/v1/upstreams");
    expect(upstreams.status).toBe(200);
    await expect(upstreams.json()).resolves.toMatchObject({
      upstreams: [
        expect.objectContaining({
          id: "api",
          enrollment: expect.objectContaining({ status: "active" })
        })
      ]
    });

    const updates = await api(handle, "/api/v1/updates");
    expect(updates.status).toBe(200);
    await expect(updates.json()).resolves.toMatchObject({
      sync: {
        resources: [
          expect.objectContaining({
            id: "skill.api-helper",
            available_version: "1.1.0",
            installable: true
          })
        ]
      }
    });

    const install = await api(handle, "/api/v1/resources/skill.api-helper/install", {
      method: "POST",
      headers: { origin: handle.url },
      body: JSON.stringify({ upstream_id: "api", accept: true })
    });
    expect(install.status).toBe(200);
    await expect(install.json()).resolves.toMatchObject({
      result: expect.objectContaining({ installed: true, version: "1.1.0" })
    });

    const revoke = await api(handle, "/api/v1/enrollments/revoke", {
      method: "POST",
      headers: { origin: handle.url },
      body: JSON.stringify({ upstream_id: "api" })
    });
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({
      enrollment: expect.objectContaining({
        enrollment: expect.objectContaining({ status: "revoked" })
      })
    });
  });

  it("enrolls an upstream through autovault init without exposing local credential material", async () => {
    const upstreamDir = path.join(currentStorageRoot(), "cli-upstream");
    const signer = createSyncSigningKeypair();
    await writeFakeUpstreamCatalog(upstreamDir, {
      id: "cli",
      name: "CLI Vault",
      publicKey: signer.publicKey,
      releases: []
    });

    const result = spawnSync(TSX_BIN, [CLI_PATH, "init", upstreamDir, "--json"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        AUTOVAULT_STORAGE_PATH: currentStorageRoot(),
        AUTOVAULT_LOG_LEVEL: "error",
        AUTOVAULT_SECURITY_STRICT: "true",
        AUTOVAULT_NO_UPDATE_CHECK: "1",
        NODE_NO_WARNINGS: "1"
      }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout) as {
      enrollment: {
        id: string;
        enrollment: { status: string; device_public_key: string };
      };
    };
    expect(body.enrollment).toMatchObject({
      id: "cli",
      enrollment: expect.objectContaining({
        status: "active",
        device_public_key: expect.any(String)
      })
    });
    expect(result.stdout).not.toContain("device_secret_key");
    expect(JSON.stringify(await listEnrolledUpstreams())).not.toContain("device_secret_key");
  });
});
