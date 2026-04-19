import { describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { log } from "../src/util/log.js";

function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("log level filtering", () => {
  it("suppresses lower-severity records when AUTOVAULT_LOG_LEVEL=error", () => {
    process.env.AUTOVAULT_LOG_LEVEL = "error";
    resetConfigCache();
    const lines = captureStderr(() => {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    expect(lines.join("")).not.toMatch(/"msg":"d"/);
    expect(lines.join("")).not.toMatch(/"msg":"i"/);
    expect(lines.join("")).not.toMatch(/"msg":"w"/);
    expect(lines.join("")).toMatch(/"msg":"e"/);
  });

  it("emits info+ when AUTOVAULT_LOG_LEVEL=info", () => {
    process.env.AUTOVAULT_LOG_LEVEL = "info";
    resetConfigCache();
    const lines = captureStderr(() => {
      log.debug("d");
      log.info("i");
      log.warn("w");
    });
    const joined = lines.join("");
    expect(joined).not.toMatch(/"msg":"d"/);
    expect(joined).toMatch(/"msg":"i"/);
    expect(joined).toMatch(/"msg":"w"/);
  });

  it("emits debug when AUTOVAULT_LOG_LEVEL=debug", () => {
    process.env.AUTOVAULT_LOG_LEVEL = "debug";
    resetConfigCache();
    const lines = captureStderr(() => {
      log.debug("d");
    });
    expect(lines.join("")).toMatch(/"msg":"d"/);
  });
});
