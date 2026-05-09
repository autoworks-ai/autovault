import { describe, expect, it } from "vitest";
import { renderSetupIntro } from "../src/cli/setup/render.js";
import { sayVault } from "../src/cli/ui/animation.js";
import { renderVaultMark } from "../src/cli/ui/brand.js";
import { keyValueRows } from "../src/cli/ui/table.js";
import { makeTheme } from "../src/cli/ui/theme.js";

describe("CLI UI helpers", () => {
  it("renders ASCII fallback branding without ANSI", () => {
    const theme = makeTheme(process.stdout, { color: "never", symbols: "ascii", width: 60 });

    expect(renderVaultMark(theme)).toEqual([
      " .----. ",
      " |  | | ",
      " | O  | ",
      " '+--+' ",
      "  |  |  "
    ]);
  });

  it("formats deterministic narrow key/value rows", () => {
    const theme = makeTheme(process.stdout, { color: "never", symbols: "ascii", width: 48 });

    expect(
      keyValueRows(
        [
          { label: "scan", value: "/tmp/skill", status: "muted" },
          { label: "validate", value: "passed", status: "ok" },
          { label: "warning", value: "needs attention", status: "warn" }
        ],
        theme
      )
    ).toMatchInlineSnapshot(`
"  - scan     /tmp/skill
  + validate passed
  ! warning  needs attention"
`);
  });

  it("can force truecolor mint styling", () => {
    const theme = makeTheme(process.stdout, { color: "always", symbols: "ascii" });

    expect(theme.style.mint("vault")).toContain("\u001B[38;2;90;214;192m");
  });

  it("prints a stable non-TTY vault message", async () => {
    const chunks: string[] = [];
    const stream = {
      isTTY: false,
      columns: 60,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      }
    } as NodeJS.WriteStream;

    await sayVault("Welcome to AutoVault.", stream);

    const output = chunks.join("");
    expect(output).toContain("[vault] Vault:");
    expect(output).toContain("Welcome to AutoVault.");
    expect(output).not.toContain(" .----. ");
    expect(output).not.toContain(" | () | ");
    expect(output).not.toContain("'-||-'");
    expect(output).not.toContain("\u001B[");
  });

  it("keeps setup intro to one compact badge line", async () => {
    const chunks: string[] = [];
    const stream = {
      isTTY: false,
      columns: 80,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      }
    } as NodeJS.WriteStream;

    await renderSetupIntro(stream);

    const output = chunks.join("");
    expect(output).toContain("[vault] Vault:");
    expect(output).not.toContain(" .----. ");
    expect(output).not.toContain("AutoVault validated");
  });
});
