// Remote MCP smoke test.
//
// Default mode: spins up a fresh local AutoVault remote server in /tmp,
// exercises OAuth + propose_skill + get_skill end-to-end, then tears down.
//
// Live-target mode: set AUTOVAULT_REMOTE_URL=https://<your-deployment> and
// AUTOVAULT_ADMIN_EMAIL / AUTOVAULT_ADMIN_PASSWORD to point the same flow
// at a deployed server (no local boot, no temp storage). Useful for
// validating a Railway / Docker-Compose deploy after configuration.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REMOTE_URL = process.env.AUTOVAULT_REMOTE_URL?.replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.AUTOVAULT_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.AUTOVAULT_ADMIN_PASSWORD ?? "admin-password-123";
const REDIRECT_URI = "http://localhost/callback";

if (REMOTE_URL && (!process.env.AUTOVAULT_ADMIN_EMAIL || !process.env.AUTOVAULT_ADMIN_PASSWORD)) {
  process.stderr.write(
    "AUTOVAULT_REMOTE_URL is set, but AUTOVAULT_ADMIN_EMAIL and/or AUTOVAULT_ADMIN_PASSWORD are missing. " +
      "Set both to match the credentials configured on the deployment.\n"
  );
  process.exit(2);
}

const SAMPLE_SKILL = `---
name: remote-smoke-skill
description: Smoke-test skill for AutoVault remote MCP mode. Long enough to satisfy schema checks.
tags:
  - smoke
metadata:
  version: "0.1.0"
---

# Remote Smoke Skill

This skill exists only to verify the remote AutoVault MCP server end-to-end.
`;

function banner(label) {
  process.stdout.write(`\n=== ${label} ===\n`);
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function unwrap(result) {
  const text = result?.content?.find?.((entry) => entry.type === "text")?.text;
  return typeof text === "string" ? JSON.parse(text) : result;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function registerClient(base) {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "AutoVault remote smoke",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:tools autovault:read autovault:write autovault:admin"
    })
  });
  if (response.status !== 201) throw new Error(`client registration failed: ${await response.text()}`);
  return response.json();
}

async function oauthToken(base) {
  const client = await registerClient(base);
  const verifier = `verifier-${crypto.randomBytes(24).toString("base64url")}`;
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client.client_id);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("scope", "mcp:tools autovault:read autovault:write autovault:admin");

  const first = await fetch(authorize, { redirect: "manual" });
  const loginUrl = new URL(first.headers.get("location"), base);
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      return_to: loginUrl.searchParams.get("return_to") ?? ""
    }),
    redirect: "manual"
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("login did not return a session cookie");

  const second = await fetch(new URL(login.headers.get("location"), base), {
    headers: { cookie },
    redirect: "manual"
  });
  const callback = new URL(second.headers.get("location"));
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("authorization did not return a code");

  const token = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI
    })
  });
  if (token.status !== 200) throw new Error(`token exchange failed: ${await token.text()}`);
  return token.json();
}

async function bootLocalServer() {
  const tempStorage = await fs.mkdtemp(path.join(os.tmpdir(), "autovault-remote-smoke-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  process.env.AUTOVAULT_MODE = "remote";
  process.env.AUTOVAULT_STORAGE_PATH = tempStorage;
  process.env.AUTOVAULT_PUBLIC_URL = base;
  process.env.AUTOVAULT_ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.AUTOVAULT_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.AUTOVAULT_LOG_LEVEL = "info";

  let server;
  try {
    const { startRemoteServer } = await import("../dist/remote/server.js");
    server = await startRemoteServer({ port, host: "127.0.0.1" });
    return { base, server, tempStorage };
  } catch (error) {
    await server?.close();
    await fs.rm(tempStorage, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  let base;
  let server;
  let tempStorage;
  if (REMOTE_URL) {
    base = REMOTE_URL;
    banner(`Targeting deployed server: ${base}`);
  } else {
    ({ base, server, tempStorage } = await bootLocalServer());
    banner(`Spawned local server: ${base}/mcp`);
  }

  let client;
  try {
    const health = await fetch(`${base}/healthz`);
    process.stdout.write(`${pretty(await health.json())}\n`);

    const tokens = await oauthToken(base);
    client = new Client({ name: "autovault-remote-smoke", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } }
      })
    );

    banner("propose_skill");
    const proposal = unwrap(
      await client.callTool({ name: "propose_skill", arguments: { skill_md: SAMPLE_SKILL } })
    );
    process.stdout.write(`${pretty(proposal)}\n`);

    banner("get_skill query");
    const found = unwrap(await client.callTool({ name: "get_skill", arguments: { query: "remote smoke" } }));
    process.stdout.write(`${pretty({
      ...found,
      skill: found.skill ? { ...found.skill, skill_md: `<${found.skill.skill_md.length} chars>` } : null
    })}\n`);

    banner("Remote smoke test completed");
  } finally {
    await client?.close();
    await server?.close();
    if (tempStorage) await fs.rm(tempStorage, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Remote smoke test failed: ${String(error)}\n`);
  process.exit(1);
});
