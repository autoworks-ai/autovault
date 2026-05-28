import { describe, expect, it } from "vitest";
import { compareVersions } from "../src/util/version-compare.js";

describe("compareVersions", () => {
  it("treats a stable release as newer than its prerelease", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
  });

  it("orders prerelease identifiers using semver precedence", () => {
    expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.10", "1.0.0-beta.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.1")).toBe(0);
  });

  it("ignores build metadata when comparing versions", () => {
    expect(compareVersions("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("returns null for unsupported version strings", () => {
    expect(compareVersions("main", "1.0.0")).toBeNull();
  });
});
