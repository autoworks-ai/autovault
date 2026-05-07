import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  AuthorizationParams,
  OAuthServerProvider
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { loadConfig, type Config } from "../config.js";
import { openCapabilityDb, parseJsonArray, type CapabilityDb } from "../capabilities/db.js";
import { log } from "../util/log.js";

const SESSION_COOKIE = "autovault_session";
const SESSION_SECRET_FILE = ".autovault-remote-session-secret";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_CODE_TTL_SECONDS = 10 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_CLEANUP_INTERVAL_SECONDS = 5 * 60;

export const REMOTE_SCOPES = [
  "mcp:tools",
  "autovault:read",
  "autovault:write",
  "autovault:admin"
] as const;

export type RemoteRole = "viewer" | "editor" | "owner";

export type RemoteAuthContext = {
  user_id: string;
  email: string;
  caller_id: string;
  role: RemoteRole;
};

type RemoteUserRow = {
  id: string;
  email: string;
  caller_id: string;
  role: RemoteRole;
  password_salt: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
};

type CodeRow = {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes_json: string;
  resource: string | null;
  expires_at: number;
};

type TokenRow = {
  token: string;
  client_id: string;
  user_id: string;
  type: "access" | "refresh";
  scopes_json: string;
  resource: string | null;
  expires_at: number;
  revoked_at: number | null;
};

export function scopesForRole(role: RemoteRole): string[] {
  switch (role) {
    case "owner":
      return [...REMOTE_SCOPES];
    case "editor":
      return ["mcp:tools", "autovault:read", "autovault:write"];
    case "viewer":
    default:
      return ["mcp:tools", "autovault:read"];
  }
}

export function remoteAuthContext(authInfo: AuthInfo | undefined): RemoteAuthContext | null {
  const extra = authInfo?.extra;
  if (!extra) return null;
  const role = extra.role;
  if (role !== "viewer" && role !== "editor" && role !== "owner") return null;
  if (
    typeof extra.user_id !== "string" ||
    typeof extra.email !== "string" ||
    typeof extra.caller_id !== "string"
  ) {
    return null;
  }
  return {
    user_id: extra.user_id,
    email: extra.email,
    caller_id: extra.caller_id,
    role
  };
}

export function isOwner(authInfo: AuthInfo | undefined): boolean {
  return remoteAuthContext(authInfo)?.role === "owner";
}

export function hasScope(authInfo: AuthInfo | undefined, scope: string): boolean {
  return isOwner(authInfo) || Boolean(authInfo?.scopes.includes(scope));
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeRole(role: unknown): RemoteRole {
  if (role === "owner" || role === "editor" || role === "viewer") return role;
  return "viewer";
}

function passwordHash(password: string, salt = crypto.randomBytes(16).toString("base64url")): {
  salt: string;
  hash: string;
} {
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return { salt, hash };
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function loadOrCreateSessionSecret(config: Config): Promise<Buffer> {
  const secretPath = path.join(config.storagePath, SESSION_SECRET_FILE);
  try {
    const raw = await fs.readFile(secretPath, "utf-8");
    return Buffer.from(raw.trim(), "base64url");
  } catch {
    const secret = crypto.randomBytes(32);
    await fs.mkdir(config.storagePath, { recursive: true });
    const tmp = `${secretPath}.tmp.${crypto.randomUUID()}`;
    await fs.writeFile(tmp, secret.toString("base64url"), { mode: 0o600 });
    try {
      await fs.rename(tmp, secretPath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      const raw = await fs.readFile(secretPath, "utf-8").catch(() => null);
      if (raw) return Buffer.from(raw.trim(), "base64url");
      throw error;
    }
    await fs.chmod(secretPath, 0o600).catch(() => {});
    return secret;
  }
}

function signSession(payload: string, secret: Buffer): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function encodeSession(userId: string, secret: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify({ user_id: userId, exp: Date.now() + SESSION_TTL_MS }),
    "utf-8"
  ).toString("base64url");
  return `${payload}.${signSession(payload, secret)}`;
}

function decodeSession(cookie: string | undefined, secret: Buffer): { user_id: string } | null {
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".", 2);
  if (!payload || !signature) return null;
  const expected = signSession(payload, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
      user_id?: unknown;
      exp?: unknown;
    };
    if (typeof decoded.user_id !== "string" || typeof decoded.exp !== "number") return null;
    if (decoded.exp < Date.now()) return null;
    return { user_id: decoded.user_id };
  } catch {
    return null;
  }
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  if (!value.startsWith("/authorize")) return "/";
  if (value.startsWith("//")) return "/";
  return value;
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font: 16px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; color: #172033; }
    label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
    input, select, button { font: inherit; width: 100%; box-sizing: border-box; padding: .7rem .8rem; }
    button { margin-top: 1.2rem; cursor: pointer; }
    .error { color: #9f1d1d; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

class RemoteClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: CapabilityDb) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = this.db
      .prepare("SELECT client_json FROM remote_oauth_clients WHERE client_id = ?")
      .get(clientId) as { client_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.client_json) as OAuthClientInformationFull;
  }

  async registerClient(
    input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): Promise<OAuthClientInformationFull> {
    const client: OAuthClientInformationFull = {
      ...input,
      client_id: crypto.randomUUID(),
      client_id_issued_at: nowSeconds()
    };
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO remote_oauth_clients(client_id, client_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(client.client_id, JSON.stringify(client), timestamp, timestamp);
    return client;
  }
}

export class RemoteOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly publicUrl: URL;
  private readonly secureCookies: boolean;
  private lastCleanupAt = 0;

  private constructor(
    private readonly db: CapabilityDb,
    private readonly sessionSecret: Buffer,
    config: Config
  ) {
    if (!config.publicUrl) {
      throw new Error("AUTOVAULT_PUBLIC_URL is required for remote OAuth");
    }
    this.publicUrl = new URL(config.publicUrl);
    this.secureCookies = this.publicUrl.protocol === "https:";
    this.clientsStore = new RemoteClientsStore(db);
  }

  static async create(config = loadConfig(), db = openCapabilityDb()): Promise<RemoteOAuthProvider> {
    const provider = new RemoteOAuthProvider(db, await loadOrCreateSessionSecret(config), config);
    await provider.seedAdmin(config);
    provider.cleanupExpired(true);
    return provider;
  }

  async seedAdmin(config: Config): Promise<void> {
    const owner = this.db
      .prepare("SELECT id FROM remote_users WHERE role = 'owner' LIMIT 1")
      .get() as { id: string } | undefined;
    if (owner) return;
    if (!config.adminEmail || !config.adminPassword) {
      throw new Error(
        "Remote mode requires AUTOVAULT_ADMIN_EMAIL and AUTOVAULT_ADMIN_PASSWORD until an owner user exists"
      );
    }
    await this.createUser({
      email: config.adminEmail,
      password: config.adminPassword,
      role: "owner",
      callerId: `owner:${normalizeEmail(config.adminEmail)}`
    });
    log.info("remote_auth.owner_seeded", { email: normalizeEmail(config.adminEmail) });
  }

  async createUser(input: {
    email: string;
    password: string;
    role?: RemoteRole;
    callerId?: string;
  }): Promise<RemoteAuthContext> {
    const email = normalizeEmail(input.email);
    if (!email || !email.includes("@")) throw new Error("Valid email is required");
    if (input.password.length < 12) throw new Error("Password must be at least 12 characters");
    const role = input.role ?? "viewer";
    const callerId = input.callerId?.trim() || `remote:${email}`;
    const { salt, hash } = passwordHash(input.password);
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO remote_users(
           id, email, password_salt, password_hash, role, caller_id, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, email, salt, hash, role, callerId, timestamp, timestamp);
    return { user_id: id, email, caller_id: callerId, role };
  }

  userById(userId: string): RemoteUserRow | null {
    const row = this.db.prepare("SELECT * FROM remote_users WHERE id = ?").get(userId) as
      | RemoteUserRow
      | undefined;
    return row ?? null;
  }

  sessionUser(req: Request): RemoteAuthContext | null {
    const session = decodeSession(parseCookie(req.headers.cookie, SESSION_COOKIE), this.sessionSecret);
    if (!session) return null;
    const row = this.userById(session.user_id);
    if (!row) return null;
    return {
      user_id: row.id,
      email: row.email,
      caller_id: row.caller_id,
      role: row.role
    };
  }

  async authenticate(email: string, password: string): Promise<RemoteAuthContext | null> {
    const row = this.db
      .prepare("SELECT * FROM remote_users WHERE email = ?")
      .get(normalizeEmail(email)) as RemoteUserRow | undefined;
    if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) return null;
    return {
      user_id: row.id,
      email: row.email,
      caller_id: row.caller_id,
      role: row.role
    };
  }

  setSessionCookie(res: Response, userId: string): void {
    res.cookie(SESSION_COOKIE, encodeSession(userId, this.sessionSecret), {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: "lax",
      maxAge: SESSION_TTL_MS,
      path: "/"
    });
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    this.cleanupExpired();
    const req = res.req as Request;
    const user = this.sessionUser(req);
    if (!user) {
      const returnTo = encodeURIComponent(req.originalUrl || req.url || "/authorize");
      res.redirect(`/login?return_to=${returnTo}`);
      return;
    }

    if (!client.redirect_uris.some((registered) => redirectUriMatches(params.redirectUri, registered))) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }

    const grantedScopes = this.grantedScopesFor(user.role, params.scopes);
    const code = randomToken();
    const expiresAt = nowSeconds() + AUTH_CODE_TTL_SECONDS;
    this.db
      .prepare(
        `INSERT INTO remote_oauth_codes(
           code, client_id, user_id, redirect_uri, code_challenge,
           scopes_json, resource, expires_at, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        code,
        client.client_id,
        user.user_id,
        params.redirectUri,
        params.codeChallenge,
        JSON.stringify(grantedScopes),
        params.resource?.href ?? null,
        expiresAt,
        nowIso()
      );

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(target.href);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const row = this.readValidCode(authorizationCode);
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    this.cleanupExpired();
    const row = this.readValidCode(authorizationCode);
    if (row.client_id !== client.client_id) {
      throw new InvalidGrantError("Authorization code was not issued to this client");
    }
    if (redirectUri && row.redirect_uri !== redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match authorization request");
    }
    if (resource && row.resource && resource.href !== row.resource) {
      throw new InvalidGrantError("resource does not match authorization request");
    }
    this.db.prepare("DELETE FROM remote_oauth_codes WHERE code = ?").run(authorizationCode);
    const scopes = parseJsonArray(row.scopes_json);
    return this.issueTokens(client.client_id, row.user_id, scopes, row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.cleanupExpired();
    const row = this.readValidToken(refreshToken, "refresh");
    if (row.client_id !== client.client_id) {
      throw new InvalidGrantError("Refresh token was not issued to this client");
    }
    if (resource && row.resource && resource.href !== row.resource) {
      throw new InvalidGrantError("resource does not match refresh token");
    }
    const originalScopes = parseJsonArray(row.scopes_json);
    const requested = scopes && scopes.length > 0
      ? scopes.filter((scope) => originalScopes.includes(scope))
      : originalScopes;
    this.db
      .prepare("UPDATE remote_oauth_tokens SET revoked_at = ? WHERE token = ?")
      .run(nowSeconds(), refreshToken);
    return this.issueTokens(client.client_id, row.user_id, requested, row.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let row: TokenRow;
    try {
      row = this.readValidToken(token, "access");
    } catch {
      throw new InvalidTokenError("Invalid or expired token");
    }
    const user = this.userById(row.user_id);
    if (!user) throw new InvalidTokenError("Token user no longer exists");
    return {
      token,
      clientId: row.client_id,
      scopes: parseJsonArray(row.scopes_json),
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: {
        user_id: user.id,
        email: user.email,
        caller_id: user.caller_id,
        role: user.role
      }
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.db
      .prepare(
        "UPDATE remote_oauth_tokens SET revoked_at = ? WHERE token = ? AND client_id = ?"
      )
      .run(nowSeconds(), request.token, client.client_id);
    this.cleanupExpired(true);
  }

  private grantedScopesFor(role: RemoteRole, requested: string[] | undefined): string[] {
    const allowed = scopesForRole(role);
    if (!requested || requested.length === 0) return allowed;
    return requested.filter((scope) => allowed.includes(scope));
  }

  private readValidCode(code: string): CodeRow {
    const row = this.db
      .prepare("SELECT * FROM remote_oauth_codes WHERE code = ?")
      .get(code) as CodeRow | undefined;
    if (!row || row.expires_at < nowSeconds()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return row;
  }

  private readValidToken(token: string, type: "access" | "refresh"): TokenRow {
    const row = this.db
      .prepare("SELECT * FROM remote_oauth_tokens WHERE token = ? AND type = ?")
      .get(token, type) as TokenRow | undefined;
    if (!row || row.revoked_at || row.expires_at < nowSeconds()) {
      throw new InvalidGrantError("Invalid or expired token");
    }
    return row;
  }

  private issueTokens(
    clientId: string,
    userId: string,
    scopes: string[],
    resource: string | null
  ): OAuthTokens {
    this.cleanupExpired();
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const timestamp = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO remote_oauth_tokens(
         token, client_id, user_id, type, scopes_json, resource, expires_at, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      accessToken,
      clientId,
      userId,
      "access",
      JSON.stringify(scopes),
      resource,
      nowSeconds() + ACCESS_TOKEN_TTL_SECONDS,
      timestamp
    );
    insert.run(
      refreshToken,
      clientId,
      userId,
      "refresh",
      JSON.stringify(scopes),
      resource,
      nowSeconds() + REFRESH_TOKEN_TTL_SECONDS,
      timestamp
    );
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(" ")
    };
  }

  private cleanupExpired(force = false): void {
    const now = nowSeconds();
    if (!force && now - this.lastCleanupAt < OAUTH_CLEANUP_INTERVAL_SECONDS) return;
    this.lastCleanupAt = now;
    this.db.prepare("DELETE FROM remote_oauth_codes WHERE expires_at < ?").run(now);
    this.db
      .prepare("DELETE FROM remote_oauth_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL")
      .run(now);
  }

  listUsers(): Array<Omit<RemoteUserRow, "password_salt" | "password_hash">> {
    return (
      this.db.prepare("SELECT * FROM remote_users ORDER BY created_at ASC").all() as RemoteUserRow[]
    ).map(({ password_hash: _hash, password_salt: _salt, ...row }) => row);
  }
}

export function createRemoteAuthRouter(provider: RemoteOAuthProvider): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/login", (req, res) => {
    const returnTo = safeReturnTo(req.query.return_to);
    res
      .status(200)
      .type("html")
      .send(
        htmlPage(
          "Sign in to AutoVault",
          `<h1>Sign in to AutoVault</h1>
          <form method="post" action="/login">
            <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
            <label>Email</label>
            <input required type="email" name="email" autocomplete="username">
            <label>Password</label>
            <input required type="password" name="password" autocomplete="current-password">
            <button type="submit">Sign in</button>
          </form>`
        )
      );
  });

  router.post("/login", async (req, res) => {
    const email = typeof req.body.email === "string" ? req.body.email : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const returnTo = safeReturnTo(req.body.return_to);
    const user = await provider.authenticate(email, password);
    if (!user) {
      res
        .status(401)
        .type("html")
        .send(
          htmlPage(
            "Sign in failed",
            `<h1>Sign in to AutoVault</h1>
            <p class="error">Invalid email or password.</p>
            <form method="post" action="/login">
              <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
              <label>Email</label>
              <input required type="email" name="email" value="${escapeHtml(email)}">
              <label>Password</label>
              <input required type="password" name="password">
              <button type="submit">Sign in</button>
            </form>`
          )
        );
      return;
    }
    provider.setSessionCookie(res, user.user_id);
    res.redirect(returnTo);
  });

  router.post("/logout", (_req, res) => {
    provider.clearSessionCookie(res);
    res.redirect("/login");
  });

  router.get("/admin/users", requireOwnerSession(provider), (_req, res) => {
    const users = provider.listUsers().map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      caller_id: row.caller_id,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));
    res.json({ users });
  });

  router.post("/admin/users", requireOwnerSession(provider), async (req, res) => {
    try {
      const user = await provider.createUser({
        email: String(req.body.email ?? ""),
        password: String(req.body.password ?? ""),
        role: normalizeRole(req.body.role),
        callerId: typeof req.body.caller_id === "string" ? req.body.caller_id : undefined
      });
      res.status(201).json({ user });
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  return router;
}

function requireOwnerSession(provider: RemoteOAuthProvider) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = provider.sessionUser(req);
    if (user?.role !== "owner") {
      res.status(403).json({ error: "Owner session required" });
      return;
    }
    next();
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
