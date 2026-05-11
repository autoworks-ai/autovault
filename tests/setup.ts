import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { resetCapabilityDbForTests } from "../src/capabilities/db.js";
import { resetSigningCache } from "../src/util/sign.js";

let tempRoot: string | null = null;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autovault-test-"));
  process.env.AUTOVAULT_MODE = "local";
  process.env.AUTOVAULT_STORAGE_PATH = tempRoot;
  delete process.env.AUTOVAULT_DB_PATH;
  delete process.env.AUTOVAULT_PROFILE_LINKS;
  delete process.env.AUTOVAULT_PROFILE_CONFIG_PATH;
  delete process.env.AUTOVAULT_PUBLIC_URL;
  delete process.env.AUTOVAULT_HTTP_PORT;
  delete process.env.AUTOVAULT_ALLOWED_ORIGINS;
  delete process.env.AUTOVAULT_ADMIN_EMAIL;
  delete process.env.AUTOVAULT_ADMIN_PASSWORD;
  process.env.AUTOVAULT_SECURITY_STRICT = "true";
  process.env.AUTOVAULT_SEARCH_MODE = "text";
  process.env.AUTOVAULT_LOG_LEVEL = "error";
  resetConfigCache();
  resetCapabilityDbForTests();
  resetSigningCache();
});

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
  process.env.AUTOVAULT_MODE = "local";
  delete process.env.AUTOVAULT_PROFILE_CONFIG_PATH;
  delete process.env.AUTOVAULT_PUBLIC_URL;
  delete process.env.AUTOVAULT_HTTP_PORT;
  delete process.env.AUTOVAULT_ALLOWED_ORIGINS;
  delete process.env.AUTOVAULT_ADMIN_EMAIL;
  delete process.env.AUTOVAULT_ADMIN_PASSWORD;
  resetConfigCache();
  resetCapabilityDbForTests();
  resetSigningCache();
});

export function currentStorageRoot(): string {
  if (!tempRoot) throw new Error("storage root not initialised");
  return tempRoot;
}
