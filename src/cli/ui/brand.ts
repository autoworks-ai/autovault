import { badge } from "./messages.js";
import { makeTheme, repeatVisible, type Theme } from "./theme.js";

export function renderVaultMark(theme: Theme): string[] {
  if (!theme.unicode) {
    return [
      theme.style.mint(" .----. "),
      theme.style.mint(" |  | | "),
      theme.style.mint(" | O  | "),
      theme.style.mint(" '+--+' "),
      theme.style.mint("  |  |  ")
    ];
  }
  return [
    theme.style.mint(" ╓─────╖ "),
    theme.style.mint(" ║  ╷  ║ "),
    theme.style.mint(" ║ ⊙   ║ "),
    theme.style.mint(" ╙┬───┬╜ "),
    theme.style.mint("  ╵   ╵  ")
  ];
}

export function renderBrandHeader(
  stream: NodeJS.WriteStream = process.stdout,
  options: { compact?: boolean } = {}
): string {
  const theme = makeTheme(stream);
  const tagline = `validated ${theme.symbol.arrow} signed ${theme.symbol.arrow} vaulted`;
  if (options.compact || theme.width < 72) {
    return `${badge("vault", theme)} ${theme.style.bold("AutoVault")} ${theme.style.dim(tagline)}\n`;
  }

  const mark = renderVaultMark(theme);
  return [
    "",
    `${mark[0]}  ${theme.style.bold("AutoVault")}`,
    `${mark[1]}  ${tagline}`,
    `${mark[2]}  ${theme.style.dim("curated skill vault for Claude Code, Codex, and Cursor")}`,
    `${mark[3]}`,
    `${mark[4]}`,
    ""
  ].join("\n");
}

export function renderSuccessOutro(
  title: string,
  lines: string[],
  stream: NodeJS.WriteStream = process.stdout
): string {
  const theme = makeTheme(stream);
  const rule = theme.style.mint(repeatVisible(theme.symbol.line, Math.min(theme.width, 68)));
  return [
    "",
    rule,
    `${theme.style.green(theme.symbol.check)} ${theme.style.bold(title)}`,
    ...lines.map((line) => `  ${line}`),
    rule,
    ""
  ].join("\n");
}
