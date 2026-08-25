import { describe, expect, it } from "vitest";
import { renderSetupIntro } from "../src/cli/setup/render.js";
import { formatCliError } from "../src/cli/ui/errors.js";
import { sayVault } from "../src/cli/ui/animation.js";
import { renderVaultMark } from "../src/cli/ui/brand.js";
import { keyValueRows } from "../src/cli/ui/table.js";
import { makeTheme } from "../src/cli/ui/theme.js";
import { HttpsSyncError } from "../src/sync/https.js";

describe("CLI UI helpers", () => {
  it("renders ASCII fallback branding without ANSI", () => {
    const theme = makeTheme(process.stdout, { color: "never", symbols: "ascii", width: 60 });

    expect(renderVaultMark(theme)).toEqual([
      "  +----------+",
      "  |    ()    |",
      "  |    ||    |",
      "  +----------+",
      "     |    |"
    ]);
  });

  it("renders fixed-width scan/read/admit state frames", () => {
    const theme = makeTheme(process.stdout, { color: "never", symbols: "ascii", width: 60 });

    expect(renderVaultMark(theme, { state: "scan" })).toEqual([
      "  +----------+",
      "  |----------|",
      "  |    ()    |",
      "  +----------+",
      "     |    |"
    ]);
    expect(renderVaultMark(theme, { state: "read" })).toEqual([
      "  +----------+",
      "  |    ()    |",
      "  |----------|",
      "  +----------+",
      "     |    |"
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
    expect(theme.style.yellow("held")).toContain("\u001B[38;2;232;168;102m");
    expect(theme.style.red("blocked")).toContain("\u001B[38;2;217;113;113m");
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
    expect(output).toContain("[ADMIT] AutoVault:");
    expect(output).toContain("Welcome to AutoVault.");
    expect(output).not.toContain("+----------+");
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
    expect(output).toContain("[ADMIT] AutoVault:");
    expect(output).toContain("review, sign, and admit");
    expect(output).not.toContain("+----------+");
    expect(output).not.toContain("AutoVault validated");
  });

  it("formats Cloud HTTPS failures without Error wrappers or raw JSON", () => {
    const error = new HttpsSyncError(
      404,
      "Not Found",
      new URL("https://autovault.dev/v/missing-vault/catalog.json"),
      "No such vault."
    );
    const stream = {
      isTTY: false,
      columns: 72,
      write() {
        return true;
      }
    } as unknown as NodeJS.WriteStream;

    const output = formatCliError(error, stream);

    expect(output).toContain("No vault uses that slug");
    expect(output).toContain("missing-vault");
    expect(output).toContain("next");
    expect(output).not.toContain("autovault failed");
    expect(output).not.toContain("Error:");
    expect(output).not.toContain('{"error"');
  });

  it("strips terminal control characters from Cloud error messages", () => {
    const error = new HttpsSyncError(
      500,
      "Internal Server Error",
      new URL("https://autovault.dev/v/acme/catalog.json"),
      "boom\u001b[31mhacked",
    );
    const stream = {
      isTTY: false,
      columns: 72,
      write() {
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const output = formatCliError(error, stream);
    expect(output).toContain("boom");
    expect(output).not.toContain("\u001b");
    expect(error.serverMessage).toBe("boom[31mhacked");
  });
});
