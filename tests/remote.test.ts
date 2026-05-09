import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resetConfigCache } from "../src/config.js";
import { openCapabilityDb } from "../src/capabilities/db.js";
import { saveCapabilityConfig } from "../src/capabilities/resolver.js";
import { proposeSkill } from "../src/tools/propose-skill.js";
import {
  startRemoteServer,
  type RemoteServerHandle
} from "../src/remote/server.js";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "admin-password-123";
const VIEWER_EMAIL = "viewer@example.com";
const VIEWER_PASSWORD = "viewer-password-123";
const QUERY_VIEWER_EMAIL = "query-viewer@example.com";
const QUERY_VIEWER_PASSWORD = "query-viewer-password-123";
const REDIRECT_URI = "http://localhost/callback";

type TokenBundle = {
  access_token: string;
  refresh_token: string;
  client_id: string;
};

let handle: RemoteServerHandle | null = null;

beforeEach(() => {
  process.env.AUTOVAULT_MODE = "remote";
  process.env.AUTOVAULT_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.AUTOVAULT_ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.AUTOVAULT_ADMIN_PASSWORD = ADMIN_PASSWORD;
  resetConfigCache();
});

afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe("remote MCP server", () => {
  it("serves health, OAuth metadata, and protected resource metadata", async () => {
    const base = await start();

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, name: "autovault", mode: "remote" });

    const oauth = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(oauth.status).toBe(200);
    const oauthBody = await oauth.json() as Record<string, unknown>;
    expect(oauthBody.authorization_endpoint).toBe("http://127.0.0.1:3000/authorize");
    expect(oauthBody.registration_endpoint).toBe("http://127.0.0.1:3000/register");
    expect(oauthBody.scopes_supported).toContain("autovault:write");

    const protectedResource = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(protectedResource.status).toBe(200);
    const protectedBody = await protectedResource.json() as Record<string, unknown>;
    expect(protectedBody.resource).toBe("http://127.0.0.1:3000/mcp");
    expect(protectedBody.authorization_servers).toEqual(["http://127.0.0.1:3000/"]);
  });

  it("supports dynamic registration, login, code exchange, refresh, and revoke", async () => {
    const base = await start();
    const tokens = await oauthToken(base, ADMIN_EMAIL, ADMIN_PASSWORD);

    expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokens.refresh_token).toMatch(/^[A-Za-z0-9_-]+$/);

    const refreshed = await tokenRequest(base, {
      grant_type: "refresh_token",
      client_id: tokens.client_id,
      refresh_token: tokens.refresh_token
    });
    expect(refreshed.status).toBe(200);
    const refreshedBody = await refreshed.json() as Record<string, string>;
    expect(refreshedBody.access_token).toBeTruthy();
    expect(refreshedBody.refresh_token).toBeTruthy();
    expect(refreshedBody.access_token).not.toBe(tokens.access_token);

    const revoked = await tokenRequest(base, {
      token: refreshedBody.access_token,
      client_id: tokens.client_id
    }, "/revoke");
    expect(revoked.status).toBe(200);

    const denied = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${refreshedBody.access_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(initializeRequest())
    });
    expect(denied.status).toBe(401);
  });

  it("issues server-owned dynamic registration client IDs", async () => {
    const base = await start();
    const requestedClientId = "caller-controlled-client-id";
    const first = await registerClient(base, requestedClientId);
    const second = await registerClient(base, requestedClientId);

    expect(first.client_id).not.toBe(requestedClientId);
    expect(second.client_id).not.toBe(requestedClientId);
    expect(second.client_id).not.toBe(first.client_id);
  });

  it("requires an owner session for remote admin routes", async () => {
    const base = await start();
    const noSession = await fetch(`${base}/admin/users`);
    expect(noSession.status).toBe(403);

    await handle!.provider.createUser({
      email: VIEWER_EMAIL,
      password: VIEWER_PASSWORD,
      role: "viewer",
      callerId: "remote:viewer"
    });
    const viewerCookie = await loginCookie(base, VIEWER_EMAIL, VIEWER_PASSWORD);
    const viewer = await fetch(`${base}/admin/users`, { headers: { cookie: viewerCookie } });
    expect(viewer.status).toBe(403);

    const ownerCookie = await loginCookie(base, ADMIN_EMAIL, ADMIN_PASSWORD);
    const owner = await fetch(`${base}/admin/users`, { headers: { cookie: ownerCookie } });
    expect(owner.status).toBe(200);
    const body = await owner.json() as { users: Array<{ email: string; role: string }> };
    expect(body.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: ADMIN_EMAIL, role: "owner" }),
        expect.objectContaining({ email: VIEWER_EMAIL, role: "viewer" })
      ])
    );
  });

  it("requires bearer auth for MCP and lets an owner initialize and search skills", async () => {
    const base = await start();
    await seedSkills();

    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(initializeRequest())
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      ".well-known/oauth-protected-resource/mcp"
    );

    const tokens = await oauthToken(base, ADMIN_EMAIL, ADMIN_PASSWORD);
    const client = await connectClient(base, tokens.access_token);
    try {
      const result = await client.callTool({
        name: "get_skill",
        arguments: { query: "remote", top_k: 5 }
      });
      const text = textContent(result);
      expect(JSON.parse(text)).toMatchObject({
        matches: expect.arrayContaining([
          expect.objectContaining({ name: "public-remote-skill" }),
          expect.objectContaining({ name: "secret-remote-skill" })
        ]),
        skill: expect.objectContaining({ skill_md: expect.stringContaining("#") })
      });
    } finally {
      await client.close();
    }
  });

  it("denies viewer writes and hides ungranted skill resources", async () => {
    const base = await start();
    await seedSkills();
    await handle!.provider.createUser({
      email: VIEWER_EMAIL,
      password: VIEWER_PASSWORD,
      role: "viewer",
      callerId: "remote:viewer"
    });

    const viewerTokens = await oauthToken(base, VIEWER_EMAIL, VIEWER_PASSWORD);
    const viewer = await connectClient(base, viewerTokens.access_token);
    try {
      const listed = await viewer.callTool({
        name: "get_skill",
        arguments: { query: "remote", top_k: 5 }
      });
      expect(JSON.parse(textContent(listed))).toMatchObject({
        matches: [expect.objectContaining({ name: "public-remote-skill" })]
      });

      const hidden = await viewer.callTool({
        name: "get_skill",
        arguments: { name: "secret-remote-skill", include_resources: true }
      });
      expect(hidden.isError).toBe(true);
      expect(textContent(hidden)).toContain("Permission denied");

      const write = await viewer.callTool({
        name: "propose_skill",
        arguments: {
          skill_md: skillMd("viewer-created-skill")
        }
      });
      expect(write.isError).toBe(true);
      expect(textContent(write)).toContain("autovault:write");
    } finally {
      await viewer.close();
    }
  });

  it("authorizes query-mode get_skill reads using the user's query", async () => {
    const base = await start();
    seedQueryScopedCapabilities();
    const result = await proposeSkill({
      skill_md: `---
name: query-gated-remote-skill
description: A description that is intentionally long enough to satisfy the schema check threshold.
agents: [codex]
metadata:
  version: "1.0.0"
capabilities:
  tools:
    - mcp__secret__tool
---

# Query Gated Remote Skill

This skill is readable only when the query grants the matching tool group.
`
    });
    expect(result.outcome).toBe("accepted");
    await handle!.provider.createUser({
      email: QUERY_VIEWER_EMAIL,
      password: QUERY_VIEWER_PASSWORD,
      role: "viewer",
      callerId: "remote:query-viewer"
    });

    const tokens = await oauthToken(base, QUERY_VIEWER_EMAIL, QUERY_VIEWER_PASSWORD);
    const viewer = await connectClient(base, tokens.access_token);
    try {
      const loaded = await viewer.callTool({
        name: "get_skill",
        arguments: { query: "query-gated", top_k: 5 }
      });
      expect(loaded.isError).not.toBe(true);
      expect(JSON.parse(textContent(loaded))).toMatchObject({
        skill: expect.objectContaining({ name: "query-gated-remote-skill" })
      });
    } finally {
      await viewer.close();
    }
  });

  it("allows owners to write through remote MCP", async () => {
    const base = await start();
    const tokens = await oauthToken(base, ADMIN_EMAIL, ADMIN_PASSWORD);
    const owner = await connectClient(base, tokens.access_token);
    try {
      const result = await owner.callTool({
        name: "propose_skill",
        arguments: { skill_md: skillMd("owner-created-remote-skill") }
      });
      expect(JSON.parse(textContent(result))).toMatchObject({
        outcome: "accepted",
        name: "owner-created-remote-skill"
      });
    } finally {
      await owner.close();
    }
  });

  it("honors configured Origin restrictions", async () => {
    process.env.AUTOVAULT_ALLOWED_ORIGINS = "https://allowed.example";
    resetConfigCache();
    const base = await start();

    const blocked = await fetch(`${base}/healthz`, {
      headers: { origin: "https://blocked.example" }
    });
    expect(blocked.status).toBe(403);

    const allowed = await fetch(`${base}/healthz`, {
      headers: { origin: "https://allowed.example" }
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://allowed.example");

    const preflight = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://allowed.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,mcp-session-id"
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(preflight.headers.get("access-control-expose-headers")).toContain("mcp-session-id");
  });
});

async function start(): Promise<string> {
  handle = await startRemoteServer({ port: 0, host: "127.0.0.1" });
  if (!handle.url) throw new Error("Remote server did not return a test URL");
  return handle.url;
}

async function loginCookie(base: string, email: string, password: string): Promise<string> {
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, return_to: "/" }),
    redirect: "manual"
  });
  expect(login.status).toBe(302);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

async function seedSkills(): Promise<void> {
  const publicResult = await proposeSkill({ skill_md: skillMd("public-remote-skill") });
  expect(publicResult.outcome).toBe("accepted");
  const secretResult = await proposeSkill({
    skill_md: `---
name: secret-remote-skill
description: A description that is intentionally long enough to satisfy the schema check threshold.
agents: [codex]
metadata:
  version: "1.0.0"
capabilities:
  tools:
    - mcp__secret__tool
resources:
  - path: notes.txt
---

# Secret Remote Skill

This skill requires a tool pattern the viewer is not granted.
`,
    resources: [{ path: "notes.txt", content: "secret notes" }]
  });
  expect(secretResult.outcome).toBe("accepted");
}

function seedQueryScopedCapabilities(): void {
  saveCapabilityConfig({
    activeProfile: "auto",
    profiles: {
      auto: { description: "Remote viewer profile", groups: [] }
    },
    toolGroups: {
      query_scoped_remote: ["mcp__secret__tool"]
    },
    toolGroupMeta: {
      query_scoped_remote: {
        description: "Secret remote tool access for query-mode read checks.",
        tags: ["remote"]
      }
    },
    contextRules: [
      {
        id: "query-gated-remote",
        pattern: "\\bquery-gated\\b",
        profiles: ["auto"],
        enableGroups: ["query_scoped_remote"],
        priority: 10
      }
    ]
  });
  openCapabilityDb()
    .prepare("INSERT OR REPLACE INTO callers(id, profile_id, role) VALUES (?, ?, ?)")
    .run("remote:query-viewer", "auto", "user");
}

function skillMd(name: string): string {
  return `---
name: ${name}
description: A description that is intentionally long enough to satisfy the schema check threshold.
agents: [codex]
metadata:
  version: "1.0.0"
---

# ${name}

Use this skill for remote MCP tests.
`;
}

async function connectClient(base: string, token: string): Promise<Client> {
  const client = new Client({ name: "autovault-remote-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
}

async function oauthToken(base: string, email: string, password: string): Promise<TokenBundle> {
  const client = await registerClient(base);
  const verifier = `verifier-${crypto.randomBytes(24).toString("base64url")}`;
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client.client_id);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set(
    "scope",
    "mcp:tools autovault:read autovault:write autovault:admin"
  );

  const first = await fetch(authorize, { redirect: "manual" });
  expect(first.status).toBe(302);
  const loginUrl = new URL(first.headers.get("location")!, base);
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email,
      password,
      return_to: loginUrl.searchParams.get("return_to") ?? ""
    }),
    redirect: "manual"
  });
  expect(login.status).toBe(302);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();

  const second = await fetch(new URL(login.headers.get("location")!, base), {
    headers: { cookie: cookie! },
    redirect: "manual"
  });
  expect(second.status).toBe(302);
  const callback = new URL(second.headers.get("location")!);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const token = await tokenRequest(base, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: code!,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI
  });
  expect(token.status).toBe(200);
  const body = await token.json() as Record<string, string>;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    client_id: client.client_id
  };
}

async function registerClient(
  base: string,
  requestedClientId?: string
): Promise<{ client_id: string }> {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: requestedClientId,
      client_name: "AutoVault remote test",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:tools autovault:read autovault:write autovault:admin"
    })
  });
  expect(response.status).toBe(201);
  const body = await response.json() as Record<string, string>;
  expect(body.client_id).toBeTruthy();
  return { client_id: body.client_id };
}

async function tokenRequest(
  base: string,
  values: Record<string, string>,
  path = "/token"
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values)
  });
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "autovault-test", version: "1.0.0" }
    }
  };
}

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Expected text result");
  return text;
}
