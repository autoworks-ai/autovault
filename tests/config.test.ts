import { describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config.js";

describe("loadConfig", () => {
  it("returns a typed config object with sane defaults under setup env", () => {
    const cfg = loadConfig();
    expect(cfg.mode).toBe("local");
    expect(cfg.searchMode).toBe("text");
    expect(cfg.strictSecurity).toBe(true);
    expect(cfg.logLevel).toBe("error");
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
