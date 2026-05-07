import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const booleanish = z.union([z.boolean(), z.string()]).transform((value, ctx) => {
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'Expected a boolean value: use one of "true", "false", "1", "0", "yes", "no", "on", or "off"'
  });
  return z.NEVER;
});

const profileLinks = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const roots: Record<string, string> = {};
    if (!value || value.trim().length === 0) return roots;

    for (const rawPair of value.split(",")) {
      const pair = rawPair.trim();
      if (pair.length === 0) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0 || separator === pair.length - 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid profile link "${pair}"; expected agent=/path/to/skills`
        });
        return z.NEVER;
      }

      const agent = pair.slice(0, separator).trim();
      const root = pair.slice(separator + 1).trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid profile link agent "${agent}"; use letters, digits, hyphen, or underscore`
        });
        return z.NEVER;
      }
      if (root.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid profile link for "${agent}"; path must not be empty`
        });
        return z.NEVER;
      }
      if (Object.prototype.hasOwnProperty.call(roots, agent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate profile link for "${agent}"`
        });
        return z.NEVER;
      }
      roots[agent] = expandHome(root);
    }

    return roots;
  });

const schema = z.object({
  AUTOVAULT_MODE: z.enum(["local", "remote"]).default("local"),
  AUTOVAULT_STORAGE_PATH: z.string().min(1).default("~/.autovault"),
  AUTOVAULT_DB_PATH: z.string().min(1).optional(),
  AUTOVAULT_PROFILE_LINKS: profileLinks,
  AUTOVAULT_SECURITY_STRICT: booleanish.default(true),
  AUTOVAULT_SEARCH_MODE: z.enum(["text"]).default("text"),
  AUTOVAULT_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AUTOVAULT_PUBLIC_URL: z.string().url().optional(),
  AUTOVAULT_HTTP_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  AUTOVAULT_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0)
        : []
    ),
  AUTOVAULT_ADMIN_EMAIL: z.string().email().optional(),
  AUTOVAULT_ADMIN_PASSWORD: z.string().min(12).optional()
});

export type Config = {
  mode: "local" | "remote";
  storagePath: string;
  dbPath: string;
  profileRoots: Record<string, string>;
  strictSecurity: boolean;
  searchMode: "text";
  logLevel: "debug" | "info" | "warn" | "error";
  publicUrl?: string;
  httpPort: number;
  allowedOrigins: string[];
  adminEmail?: string;
  adminPassword?: string;
};

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse({
    AUTOVAULT_MODE: process.env.AUTOVAULT_MODE,
    AUTOVAULT_STORAGE_PATH: process.env.AUTOVAULT_STORAGE_PATH,
    AUTOVAULT_DB_PATH: process.env.AUTOVAULT_DB_PATH,
    AUTOVAULT_PROFILE_LINKS: process.env.AUTOVAULT_PROFILE_LINKS,
    AUTOVAULT_SECURITY_STRICT: process.env.AUTOVAULT_SECURITY_STRICT,
    AUTOVAULT_SEARCH_MODE: process.env.AUTOVAULT_SEARCH_MODE,
    AUTOVAULT_LOG_LEVEL: process.env.AUTOVAULT_LOG_LEVEL,
    AUTOVAULT_PUBLIC_URL: process.env.AUTOVAULT_PUBLIC_URL,
    AUTOVAULT_HTTP_PORT: process.env.AUTOVAULT_HTTP_PORT,
    AUTOVAULT_ALLOWED_ORIGINS: process.env.AUTOVAULT_ALLOWED_ORIGINS,
    AUTOVAULT_ADMIN_EMAIL: process.env.AUTOVAULT_ADMIN_EMAIL,
    AUTOVAULT_ADMIN_PASSWORD: process.env.AUTOVAULT_ADMIN_PASSWORD
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid AutoVault configuration: ${issues}`);
  }
  const storagePath = expandHome(parsed.data.AUTOVAULT_STORAGE_PATH);
  if (parsed.data.AUTOVAULT_MODE === "remote" && !parsed.data.AUTOVAULT_PUBLIC_URL) {
    throw new Error("Invalid AutoVault configuration: AUTOVAULT_PUBLIC_URL is required in remote mode");
  }
  cached = {
    mode: parsed.data.AUTOVAULT_MODE,
    storagePath,
    dbPath: parsed.data.AUTOVAULT_DB_PATH
      ? expandHome(parsed.data.AUTOVAULT_DB_PATH)
      : path.join(storagePath, "autovault.sqlite"),
    profileRoots: parsed.data.AUTOVAULT_PROFILE_LINKS,
    strictSecurity: parsed.data.AUTOVAULT_SECURITY_STRICT,
    searchMode: parsed.data.AUTOVAULT_SEARCH_MODE,
    logLevel: parsed.data.AUTOVAULT_LOG_LEVEL,
    publicUrl: parsed.data.AUTOVAULT_PUBLIC_URL
      ? parsed.data.AUTOVAULT_PUBLIC_URL.replace(/\/+$/, "")
      : undefined,
    httpPort: parsed.data.AUTOVAULT_HTTP_PORT,
    allowedOrigins: parsed.data.AUTOVAULT_ALLOWED_ORIGINS,
    adminEmail: parsed.data.AUTOVAULT_ADMIN_EMAIL,
    adminPassword: parsed.data.AUTOVAULT_ADMIN_PASSWORD
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
