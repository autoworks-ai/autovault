import { describe, expect, it } from "vitest";
import { shouldOpenBrowser } from "../src/util/open-browser.js";

describe("shouldOpenBrowser", () => {
  const tty = { stdinIsTty: true, stdoutIsTty: true, env: {} };

  it("opens only on an interactive TTY", () => {
    expect(shouldOpenBrowser(tty)).toBe(true);
    expect(shouldOpenBrowser({ ...tty, stdinIsTty: false })).toBe(false);
    expect(shouldOpenBrowser({ ...tty, stdoutIsTty: false })).toBe(false);
  });

  it("stays closed for JSON, CI, and explicit opt-outs", () => {
    expect(shouldOpenBrowser({ ...tty, json: true })).toBe(false);
    expect(shouldOpenBrowser({ ...tty, noBrowser: true })).toBe(false);
    expect(shouldOpenBrowser({ ...tty, env: { CI: "1" } })).toBe(false);
    expect(shouldOpenBrowser({ ...tty, env: { AUTOVAULT_NO_BROWSER: "1" } })).toBe(
      false
    );
  });
});
