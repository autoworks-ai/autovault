import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startRemoteServer } from "../dist/remote/server.js";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "admin-password-123";
const REDIRECT_URI = "http://localhost/callback";

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

async function main() {
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
  let client;
  try {
    server = await startRemoteServer({ port, host: "127.0.0.1" });
    banner(`Remote URL: ${base}/mcp`);

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

    banner("list_skills");
    const list = unwrap(await client.callTool({ name: "list_skills", arguments: {} }));
    process.stdout.write(`${pretty(list)}\n`);

    banner("Remote smoke test completed");
  } finally {
    await client?.close();
    await server?.close();
    await fs.rm(tempStorage, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Remote smoke test failed: ${String(error)}\n`);
  process.exit(1);
});
