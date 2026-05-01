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

const schema = z.object({
  AUTOVAULT_MODE: z.enum(["local"]).default("local"),
  AUTOVAULT_STORAGE_PATH: z.string().min(1).default("~/.autovault"),
  AUTOVAULT_DB_PATH: z.string().min(1).optional(),
  AUTOVAULT_SECURITY_STRICT: booleanish.default(true),
  AUTOVAULT_SEARCH_MODE: z.enum(["text"]).default("text"),
  AUTOVAULT_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

export type Config = {
  mode: "local";
  storagePath: string;
  dbPath: string;
  strictSecurity: boolean;
  searchMode: "text";
  logLevel: "debug" | "info" | "warn" | "error";
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
    AUTOVAULT_SECURITY_STRICT: process.env.AUTOVAULT_SECURITY_STRICT,
    AUTOVAULT_SEARCH_MODE: process.env.AUTOVAULT_SEARCH_MODE,
    AUTOVAULT_LOG_LEVEL: process.env.AUTOVAULT_LOG_LEVEL
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid AutoVault configuration: ${issues}`);
  }
  const storagePath = expandHome(parsed.data.AUTOVAULT_STORAGE_PATH);
  cached = {
    mode: parsed.data.AUTOVAULT_MODE,
    storagePath,
    dbPath: parsed.data.AUTOVAULT_DB_PATH
      ? expandHome(parsed.data.AUTOVAULT_DB_PATH)
      : path.join(storagePath, "autovault.sqlite"),
    strictSecurity: parsed.data.AUTOVAULT_SECURITY_STRICT,
    searchMode: parsed.data.AUTOVAULT_SEARCH_MODE,
    logLevel: parsed.data.AUTOVAULT_LOG_LEVEL
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
