import { describe, expect, it } from "vitest";
import { canonicalRelPath } from "../src/util/path.js";

describe("canonicalRelPath", () => {
  it("normalizes safe relative paths", () => {
    expect(canonicalRelPath("./examples\\guide.md")).toBe("examples/guide.md");
    expect(canonicalRelPath("bin/./setup")).toBe("bin/setup");
  });

  it("rejects absolute, traversal, UNC, and Windows drive paths", () => {
    expect(canonicalRelPath("/etc/passwd")).toBe("");
    expect(canonicalRelPath("../escape.txt")).toBe("");
    expect(canonicalRelPath("\\\\server\\share\\file")).toBe("");
    expect(canonicalRelPath("C:\\temp\\setup.sh")).toBe("");
    expect(canonicalRelPath("C:/temp/setup.sh")).toBe("");
    expect(canonicalRelPath("C:temp/setup.sh")).toBe("");
  });
});
