import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express, type Request, type Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "../config.js";
import { createServer, type McpToolPolicy } from "../mcp/server.js";
import { ensureStorage, recoverOrphanBackups } from "../storage/index.js";
import { log } from "../util/log.js";
import { createRemoteAuthRouter, REMOTE_SCOPES, RemoteOAuthProvider } from "./auth.js";
import {
  assertCanReadSkill as assertRemoteSkillReadable,
  assertRemoteToolAllowed,
  filterCheckUpdatesForAuth,
  filterSearchResultsForAuth,
  filterSkillSummariesForAuth,
  filterSkillTransformsForAuth
} from "./policy.js";

type RemoteSession = {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
};

export type RemoteServerHandle = {
  app: Express;
  provider: RemoteOAuthProvider;
  server?: HttpServer;
  url?: string;
  close: () => Promise<void>;
};

export type StartRemoteServerOptions = {
  listen?: boolean;
  port?: number;
  host?: string;
};

function remotePolicy(): McpToolPolicy {
  return {
    assertToolAllowed: (toolName, _input, authInfo) => assertRemoteToolAllowed(toolName, authInfo),
    assertCanReadSkill: (skillName, authInfo, context) =>
      assertRemoteSkillReadable(skillName, authInfo, context?.toolName ?? skillName),
    filterListSkills: async (result, authInfo) => ({
      skills: await filterSkillSummariesForAuth(result.skills, authInfo)
    }),
    filterSearchSkills: async (result, authInfo, input) => ({
      matches: await filterSearchResultsForAuth(result.matches, authInfo, input.query)
    }),
    filterCheckUpdates: (result, authInfo, input) =>
      filterCheckUpdatesForAuth(result, authInfo, input.skill),
    filterListSkillTransforms: (result, authInfo, input) =>
      filterSkillTransformsForAuth(result, authInfo, input.base)
  };
}

function allowedHostsFor(config: Config): string[] {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (config.publicUrl) hosts.add(new URL(config.publicUrl).hostname);
  return [...hosts];
}

function originAllowed(config: Config, origin: string | undefined): boolean {
  if (!origin || config.allowedOrigins.length === 0) return true;
  return config.allowedOrigins.includes(origin);
}

function originMiddleware(config: Config) {
  return (req: Request, res: Response, next: () => void): void => {
    const origin = req.headers.origin;
    if (!originAllowed(config, origin)) {
      res.status(403).json({ error: "Origin is not allowed" });
      return;
    }
    if (origin) {
      res.vary("Origin");
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "authorization,content-type,mcp-session-id,mcp-protocol-version"
      );
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id,www-authenticate");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(204).send();
      return;
    }
    next();
  };
}

function publicMcpUrl(config: Config): URL {
  if (!config.publicUrl) {
    throw new Error("AUTOVAULT_PUBLIC_URL is required in remote mode");
  }
  return new URL("/mcp", config.publicUrl);
}

function installMcpRoutes(app: Express, provider: RemoteOAuthProvider, config: Config): void {
  const sessions = new Map<string, RemoteSession>();
  const mcpUrl = publicMcpUrl(config);
  const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["autovault:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl)
  });

  async function closeSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await Promise.allSettled([session.transport.close(), session.mcpServer.close()]);
  }

  async function handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    try {
      if (typeof sessionId === "string" && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: no valid MCP session ID provided"
          },
          id: null
        });
        return;
      }

      let createdSession: RemoteSession | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          if (createdSession) sessions.set(newSessionId, createdSession);
        },
        onsessionclosed: (closedSessionId) => {
          void closeSession(closedSessionId).catch((error) => {
            log.warn("remote_mcp.close_failed", {
              sessionId: closedSessionId,
              error: String(error)
            });
          });
        }
      });
      const mcpServer = createServer({ policy: remotePolicy() });
      createdSession = { transport, mcpServer };
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log.error("remote_mcp.request_failed", { error: String(error) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  }

  async function handleGet(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing MCP session ID");
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
  }

  async function handleDelete(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing MCP session ID");
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
  }

  app.post("/mcp", authMiddleware, (req, res) => {
    void handlePost(req, res);
  });
  app.get("/mcp", authMiddleware, (req, res) => {
    void handleGet(req, res);
  });
  app.delete("/mcp", authMiddleware, (req, res) => {
    void handleDelete(req, res);
  });

  app.set("closeMcpSessions", async () => {
    await Promise.allSettled([...sessions.keys()].map((sessionId) => closeSession(sessionId)));
  });
}

function listen(app: Express, port: number, host: string): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

export async function startRemoteServer(
  options: StartRemoteServerOptions = {}
): Promise<RemoteServerHandle> {
  const config = loadConfig();
  await ensureStorage();
  await recoverOrphanBackups();

  const provider = await RemoteOAuthProvider.create(config);
  const app = createMcpExpressApp({
    host: options.host ?? "0.0.0.0",
    allowedHosts: allowedHostsFor(config)
  });
  app.use(originMiddleware(config));
  app.use(express.json({ limit: "4mb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "autovault", mode: "remote" });
  });
  app.use(providerAuthRoutes(provider, config));
  installMcpRoutes(app, provider, config);

  const shouldListen = options.listen ?? true;
  let server: HttpServer | undefined;
  let url: string | undefined;
  if (shouldListen) {
    const port = options.port ?? Number(process.env.PORT ?? config.httpPort);
    const host = options.host ?? "0.0.0.0";
    server = await listen(app, port, host);
    const address = server.address() as AddressInfo;
    url = `http://localhost:${address.port}`;
    log.info("autovault.remote_ready", {
      storagePath: config.storagePath,
      publicUrl: config.publicUrl,
      bind: `${host}:${address.port}`
    });
  }

  return {
    app,
    provider,
    server,
    url,
    close: async () => {
      const closer = app.get("closeMcpSessions") as (() => Promise<void>) | undefined;
      await closer?.();
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

function providerAuthRoutes(provider: RemoteOAuthProvider, config: Config): express.RequestHandler {
  const baseUrl = new URL(config.publicUrl!);
  return express.Router().use(
    createRemoteAuthRouter(provider),
    mcpAuthRouter({
      provider,
      issuerUrl: baseUrl,
      baseUrl,
      resourceServerUrl: publicMcpUrl(config),
      scopesSupported: [...REMOTE_SCOPES],
      resourceName: "AutoVault"
    })
  );
}
