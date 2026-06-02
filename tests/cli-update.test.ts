import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  it("does not prompt when stdout is redirected even if stdin is interactive", async () => {
    const stdout = captureStream();
    const runner = vi.fn();
    const confirm = vi.fn();
    const code = await runUpdateCommand([], {
      stdout: stdout.stream,
      stderr: captureStream().stream,
      env: { AUTOVAULT_LATEST_VERSION: "1.4.0" },
      isTty: true,
      versionInfo: () => ({
        version: "1.1.1",
        node: "v24.0.0",
        installPath: "/tmp/autovault",
        storagePath: "/tmp/autovault-storage",
        installMethod: "npm"
      }),
      runner,
      confirm
    });

    expect(code).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(stdout.output()).toContain("Run autovault update --yes to apply.");
  });

  it("quotes displayed update commands when paths contain spaces", async () => {
    const stdout = captureStream();
    const installPath = await fs.mkdtemp(path.join(os.tmpdir(), "autovault update "));
    await fs.mkdir(path.join(installPath, "scripts"));
    await fs.writeFile(path.join(installPath, "scripts", "install.sh"), "#!/bin/sh\n");

    const code = await runUpdateCommand(["--dry-run"], {
      stdout: stdout.stream,
      stderr: captureStream().stream,
      env: { AUTOVAULT_LATEST_VERSION: "1.4.0" },
      isTty: false,
      versionInfo: () => ({
        version: "1.1.1",
        node: "v24.0.0",
        installPath,
        storagePath: "/tmp/autovault-storage",
        installMethod: "source-tree"
      })
    });

    expect(code).toBe(0);
    expect(stdout.output()).toContain(
      `Command: AUTOVAULT_REF=v1.4.0 AUTOVAULT_YES=1 sh '${installPath}/scripts/install.sh'`
    );
  });
});
