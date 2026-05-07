import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../src/config.js";

describe("loadConfig", () => {
  it("returns a typed config object with sane defaults under setup env", () => {
    const cfg = loadConfig();
    expect(cfg.mode).toBe("local");
    expect(cfg.searchMode).toBe("text");
    expect(cfg.strictSecurity).toBe(true);
    expect(cfg.logLevel).toBe("error");
    expect(cfg.profileRoots).toEqual({});
    expect(cfg.httpPort).toBe(3000);
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.publicUrl).toBeUndefined();
  });

  it("parses AUTOVAULT_PROFILE_LINKS and expands home paths", () => {
    const previous = process.env.AUTOVAULT_PROFILE_LINKS;
    process.env.AUTOVAULT_PROFILE_LINKS =
      "codex=~/.codex/skills, claude-code=/tmp/claude-skills";
    resetConfigCache();
    try {
      expect(loadConfig().profileRoots).toEqual({
        codex: path.join(os.homedir(), ".codex/skills"),
        "claude-code": "/tmp/claude-skills"
      });
    } finally {
      if (previous === undefined) delete process.env.AUTOVAULT_PROFILE_LINKS;
      else process.env.AUTOVAULT_PROFILE_LINKS = previous;
      resetConfigCache();
    }
  });

  it("fails fast on malformed AUTOVAULT_PROFILE_LINKS", () => {
    const previous = process.env.AUTOVAULT_PROFILE_LINKS;
    process.env.AUTOVAULT_PROFILE_LINKS = "codex";
    resetConfigCache();
    try {
      expect(() => loadConfig()).toThrow(/Invalid AutoVault configuration/);
      expect(() => loadConfig()).toThrow(/AUTOVAULT_PROFILE_LINKS/);
    } finally {
      if (previous === undefined) delete process.env.AUTOVAULT_PROFILE_LINKS;
      else process.env.AUTOVAULT_PROFILE_LINKS = previous;
      resetConfigCache();
    }
  });

  it("fails fast on invalid AUTOVAULT_SEARCH_MODE", () => {
    const previous = process.env.AUTOVAULT_SEARCH_MODE;
    process.env.AUTOVAULT_SEARCH_MODE = "embeddings";
    resetConfigCache();
    try {
      expect(() => loadConfig()).toThrow(/Invalid AutoVault configuration/);
    } finally {
      if (previous === undefined) delete process.env.AUTOVAULT_SEARCH_MODE;
      else process.env.AUTOVAULT_SEARCH_MODE = previous;
      resetConfigCache();
    }
  });

  it("requires AUTOVAULT_PUBLIC_URL in remote mode", () => {
    const previousMode = process.env.AUTOVAULT_MODE;
    process.env.AUTOVAULT_MODE = "remote";
    delete process.env.AUTOVAULT_PUBLIC_URL;
    resetConfigCache();
    try {
      expect(() => loadConfig()).toThrow(/AUTOVAULT_PUBLIC_URL is required/);
    } finally {
      if (previousMode === undefined) delete process.env.AUTOVAULT_MODE;
      else process.env.AUTOVAULT_MODE = previousMode;
      resetConfigCache();
    }
  });

  it("parses remote HTTP settings", () => {
    const previous = {
      mode: process.env.AUTOVAULT_MODE,
      publicUrl: process.env.AUTOVAULT_PUBLIC_URL,
      port: process.env.AUTOVAULT_HTTP_PORT,
      origins: process.env.AUTOVAULT_ALLOWED_ORIGINS,
      email: process.env.AUTOVAULT_ADMIN_EMAIL,
      password: process.env.AUTOVAULT_ADMIN_PASSWORD
    };
    process.env.AUTOVAULT_MODE = "remote";
    process.env.AUTOVAULT_PUBLIC_URL = "https://vault.example.com/";
    process.env.AUTOVAULT_HTTP_PORT = "4000";
    process.env.AUTOVAULT_ALLOWED_ORIGINS = "https://client.example, https://other.example";
    process.env.AUTOVAULT_ADMIN_EMAIL = "admin@example.com";
    process.env.AUTOVAULT_ADMIN_PASSWORD = "a-strong-test-password";
    resetConfigCache();
    try {
      const cfg = loadConfig();
      expect(cfg.mode).toBe("remote");
      expect(cfg.publicUrl).toBe("https://vault.example.com");
      expect(cfg.httpPort).toBe(4000);
      expect(cfg.allowedOrigins).toEqual(["https://client.example", "https://other.example"]);
      expect(cfg.adminEmail).toBe("admin@example.com");
      expect(cfg.adminPassword).toBe("a-strong-test-password");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        const envKey = {
          mode: "AUTOVAULT_MODE",
          publicUrl: "AUTOVAULT_PUBLIC_URL",
          port: "AUTOVAULT_HTTP_PORT",
          origins: "AUTOVAULT_ALLOWED_ORIGINS",
          email: "AUTOVAULT_ADMIN_EMAIL",
          password: "AUTOVAULT_ADMIN_PASSWORD"
        }[key]!;
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
      resetConfigCache();
    }
  });

  it("rejects AUTOVAULT_PUBLIC_URL with a path, query, or fragment", () => {
    const previous = {
      mode: process.env.AUTOVAULT_MODE,
      publicUrl: process.env.AUTOVAULT_PUBLIC_URL
    };
    process.env.AUTOVAULT_MODE = "remote";
    process.env.AUTOVAULT_PUBLIC_URL = "https://vault.example.com/autovault";
    resetConfigCache();
    try {
      expect(() => loadConfig()).toThrow(/AUTOVAULT_PUBLIC_URL must be an origin/);
    } finally {
      if (previous.mode === undefined) delete process.env.AUTOVAULT_MODE;
      else process.env.AUTOVAULT_MODE = previous.mode;
      if (previous.publicUrl === undefined) delete process.env.AUTOVAULT_PUBLIC_URL;
      else process.env.AUTOVAULT_PUBLIC_URL = previous.publicUrl;
      resetConfigCache();
    }
  });

  it("fails fast on typo'd AUTOVAULT_SECURITY_STRICT instead of silently coercing to false", () => {
    const previous = process.env.AUTOVAULT_SECURITY_STRICT;
    process.env.AUTOVAULT_SECURITY_STRICT = "treu";
    resetConfigCache();
    try {
      expect(() => loadConfig()).toThrow(/Invalid AutoVault configuration/);
    } finally {
      if (previous === undefined) delete process.env.AUTOVAULT_SECURITY_STRICT;
      else process.env.AUTOVAULT_SECURITY_STRICT = previous;
      resetConfigCache();
    }
  });

  it("coerces booleanish values for AUTOVAULT_SECURITY_STRICT", () => {
    const previous = process.env.AUTOVAULT_SECURITY_STRICT;
    for (const [value, expected] of [
      ["true", true],
      ["false", false],
      ["1", true],
      ["0", false],
      ["yes", true],
      ["no", false]
    ] as const) {
      process.env.AUTOVAULT_SECURITY_STRICT = value;
      resetConfigCache();
      expect(loadConfig().strictSecurity).toBe(expected);
    }
    if (previous === undefined) delete process.env.AUTOVAULT_SECURITY_STRICT;
    else process.env.AUTOVAULT_SECURITY_STRICT = previous;
    resetConfigCache();
  });
});
