import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";

describe("setup prompt helpers", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("treats Enter on selectKey as the initial choice", async () => {
    vi.doMock("@clack/prompts", () => ({
      cancel: vi.fn(),
      confirm: vi.fn(),
      isCancel: () => false,
      select: vi.fn(),
      selectKey: vi.fn(async () => undefined),
      text: vi.fn()
    }));
    vi.doMock("../src/cli/ui/tty.js", () => ({
      NoTtyError: class NoTtyError extends Error {
        constructor() {
          super("no tty");
          this.name = "NoTtyError";
        }
      },
      isTtyAvailable: () => true,
      openTtyStreams: () => ({
        input: new Readable({ read() {} }),
        output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        close: vi.fn()
      })
    }));

    const { askChoice } = await import("../src/cli/setup/prompt.js");
    const choice = await askChoice("Review now?", [
      { key: "f", label: "finish install", value: "finish" },
      { key: "r", label: "review now", value: "review" }
    ]);

    expect(choice).toEqual({ value: "finish", applyToAll: false });
  });
});
