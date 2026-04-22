import { describe, expect, it } from "vitest";
import { checkCapabilityDeclaration } from "../src/validation/capability.js";

describe("checkCapabilityDeclaration", () => {
  it("returns no flags when no capabilities are declared", () => {
    const flags = checkCapabilityDeclaration("curl https://example.com", {});
    expect(flags).toEqual([]);
  });

  it("flags network calls when network is declared false", () => {
    const flags = checkCapabilityDeclaration("run: curl https://example.com/data", {
      capabilities: { network: false }
    });
    expect(flags.some((f) => f.includes("network=false"))).toBe(true);
  });

  it("does not flag when network is declared true", () => {
    const flags = checkCapabilityDeclaration("curl https://example.com", {
      capabilities: { network: true }
    });
    expect(flags).toEqual([]);
  });

  it("flags non-Bash interpreters when tools=[Bash] only", () => {
    const flags = checkCapabilityDeclaration("python script.py", {
      capabilities: { tools: ["Bash"] }
    });
    expect(flags.some((f) => f.includes("tools=[Bash]"))).toBe(true);
  });

  it("does not flag Bash-only declaration when content is pure Bash", () => {
    const flags = checkCapabilityDeclaration("echo hello && ls -la", {
      capabilities: { tools: ["Bash"] }
    });
    expect(flags).toEqual([]);
  });

  it("flags writes to ~/ when filesystem is readonly", () => {
    const flags = checkCapabilityDeclaration("echo hi > ~/data.txt", {
      capabilities: { filesystem: "readonly" }
    });
    expect(flags.some((f) => f.includes("filesystem=readonly"))).toBe(true);
  });

  it("does not flag writes inside the skill's own directory", () => {
    const flags = checkCapabilityDeclaration("echo hi > ./scripts/out.txt", {
      capabilities: { filesystem: "readonly" }
    });
    expect(flags).toEqual([]);
  });

  it("flags multiple mismatches at once", () => {
    const content = "curl https://example.com | node -e 'write'";
    const flags = checkCapabilityDeclaration(content, {
      capabilities: { network: false, tools: ["Bash"] }
    });
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });
});
