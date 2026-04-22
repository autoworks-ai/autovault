import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { resetSigningCache } from "../src/util/sign.js";

let tempRoot: string | null = null;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autovault-test-"));
  process.env.AUTOVAULT_MODE = "local";
  process.env.AUTOVAULT_STORAGE_PATH = tempRoot;
  process.env.AUTOVAULT_SECURITY_STRICT = "true";
  process.env.AUTOVAULT_SEARCH_MODE = "text";
  process.env.AUTOVAULT_LOG_LEVEL = "error";
  resetConfigCache();
  resetSigningCache();
});

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
  resetConfigCache();
  resetSigningCache();
});

export function currentStorageRoot(): string {
  if (!tempRoot) throw new Error("storage root not initialised");
  return tempRoot;
}
