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
