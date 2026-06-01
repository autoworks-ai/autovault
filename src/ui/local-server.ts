import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import {
  createManagementApiRouter,
  localManagementAuthContext,
  type ManagementAuthAdapter,
  type ManagementAuthResult
} from "./management-api.js";
import {
  DEFAULT_UI_CHANNEL,
  PINNED_UI_PUBLISHER_PUBLIC_KEY,
  resolveUiBundleAssets,
  type ResolvedUiBundleAssets
} from "./bundle.js";
import { ensureStorage, recoverOrphanBackups } from "../storage/index.js";

const SESSION_COOKIE = "autovault_ui_session";
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

export type StartLocalUiServerOptions = {
  port?: number;
  host?: string;
  open?: boolean;
  token?: string;
  offline?: boolean;
  uiBundleManifestUrl?: string;
  uiChannel?: string;
  bundledRoot?: string;
  cacheRoot?: string;
  publisherPublicKey?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  devStaticRoot?: string;
};

export type LocalUiServerHandle = {
  app: Express;
  server: HttpServer;
  url: string;
  browserUrl: string;
  token: string;
  close: () => Promise<void>;
};

export async function startLocalUiServer(
  options: StartLocalUiServerOptions = {}
): Promise<LocalUiServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? crypto.randomBytes(32).toString("base64url");
  if (!SAFE_TOKEN_PATTERN.test(token)) {
    throw new Error("Local UI token must be a base64url-style random token");
  }

  await ensureStorage();
  await recoverOrphanBackups();
  const uiAssets = await resolveUiBundleAssets({
    bundledRoot: options.bundledRoot,
    cacheRoot: options.cacheRoot,
    manifestUrl:
      options.uiBundleManifestUrl ??
      process.env.AUTOVAULT_UI_BUNDLE_MANIFEST_URL ??
      process.env.AUTOVAULT_UI_BUNDLE_URL,
    publisherPublicKey: options.publisherPublicKey ?? PINNED_UI_PUBLISHER_PUBLIC_KEY,
    channel: options.uiChannel ?? process.env.AUTOVAULT_UI_BUNDLE_CHANNEL ?? DEFAULT_UI_CHANNEL,
    offline: options.offline ?? booleanEnv(process.env.AUTOVAULT_UI_OFFLINE),
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
    devStaticRoot: options.devStaticRoot ?? process.env.AUTOVAULT_UI_DEV_STATIC_ROOT
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "autovault", mode: "ui" });
  });

  const server = await listen(app, options.port ?? 0, host);
  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;
  const allowedOrigins = new Set([url, `http://localhost:${address.port}`]);
  const auth = localTokenAuth(token);

  app.use("/api/v1", localOriginGuard(allowedOrigins), createManagementApiRouter({
    auth,
    mode: "local",
    ui: uiAssets
  }));
  installStaticRoutes(app, token, uiAssets);

  const browserUrl = `${url}/?token=${encodeURIComponent(token)}`;
  if (options.open ?? true) {
    openBrowser(browserUrl);
  }

  return {
    app,
    server,
    url,
    browserUrl,
    token,
    close: () => closeServer(server)
  };
}

function localTokenAuth(token: string): ManagementAuthAdapter {
  const check = (req: Request): ManagementAuthResult => {
    const candidate = bearerToken(req) ?? cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!candidate || !timingSafeStringEqual(candidate, token)) {
      return { ok: false, status: 401, error: "Local UI session token required" };
    }
    return { ok: true, context: localManagementAuthContext() };
  };
  return {
    read: check,
    write: check
  };
}

function localOriginGuard(allowedOrigins: Set<string>) {
  return (req: Request, res: Response, next: () => void): void => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "Origin is not allowed for local UI writes" });
      return;
    }
    next();
  };
}

function installStaticRoutes(
  app: Express,
  token: string,
  uiAssets: ResolvedUiBundleAssets
): void {
  app.use((req, res, next) => {
    const tokenParam = typeof req.query.token === "string" ? req.query.token : "";
    if (req.method === "GET" && tokenParam && timingSafeStringEqual(tokenParam, token)) {
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/"
      });
      res.redirect(303, "/");
      return;
    }
    next();
  });

  const staticRoot = uiAssets.root;
  const entrypoint = path.join(staticRoot, uiAssets.entrypoint);
  if (fs.existsSync(entrypoint)) {
    const indexHtml = fs.readFileSync(entrypoint, "utf8");
    app.use(express.static(staticRoot, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== "GET" || !acceptsHtml(req)) {
        next();
        return;
      }
      res.type("html").send(indexHtml);
    });
    return;
  }

  app.get("/", (_req, res) => {
    res.type("html").send(fallbackHtml());
  });
}

function acceptsHtml(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept !== "string" || accept.includes("text/html") || accept.includes("*/*");
}

function fallbackHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AutoVault</title>
  <style>
    body { margin: 0; font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #18202f; background: #f6f7f9; }
    main { max-width: 42rem; margin: 12vh auto; padding: 0 1.25rem; }
    h1 { font-size: 1.8rem; margin: 0 0 .75rem; }
    p { color: #4f5b6d; }
    code { background: #e8ebef; border-radius: 4px; padding: .15rem .3rem; }
  </style>
</head>
<body>
  <main>
    <h1>AutoVault UI assets are not built yet.</h1>
    <p>Run <code>npm run build:ui</code> from the AutoVault project and restart <code>autovault ui</code>.</p>
  </main>
</body>
</html>`;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !value) return undefined;
  return value;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function booleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function listen(app: Express, port: number, host: string): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
