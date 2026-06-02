import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { runUpdateCommand, type UpdateRunnerCall } from "../src/cli/update.js";

function captureStream(): { stream: NodeJS.WriteStream; output: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    }
  }) as NodeJS.WriteStream;
  return { stream, output: () => output };
}

describe("CLI update helper", () => {
  it("runs npm updates through an injected runner when --yes is supplied", async () => {
    const stdout = captureStream();
    const calls: UpdateRunnerCall[] = [];
    const code = await runUpdateCommand(["--yes"], {
      stdout: stdout.stream,
      stderr: captureStream().stream,
      env: { AUTOVAULT_LATEST_VERSION: "1.4.0" },
      isTty: false,
      versionInfo: () => ({
        version: "1.1.1",
        node: "v24.0.0",
        installPath: "/tmp/autovault",
        storagePath: "/tmp/autovault-storage",
        installMethod: "npm"
      }),
      runner: vi.fn(async (call) => {
        calls.push(call);
        return 0;
      })
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["install", "-g", "@autoworks-ai/autovault@1.4.0"],
        env: expect.objectContaining({ AUTOVAULT_LATEST_VERSION: "1.4.0" })
      }
    ]);
    expect(stdout.output()).toContain("Successfully updated to 1.4.0");
    expect(stdout.output()).toContain("hash -r");
  });
});
