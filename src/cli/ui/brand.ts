import { badge } from "./messages.js";
import { makeTheme, repeatVisible, type Theme } from "./theme.js";

export type VaultMarkState = "locked" | "scan" | "read" | "admit" | "held";
export type VaultMarkTone = "mint" | "warn" | "error" | "muted";

const ASCII_MARK: Record<VaultMarkState, string[]> = {
  locked: [
    "  +----------+",
    "  |    ()    |",
    "  |    ||    |",
    "  +----------+",
    "     |    |"
  ],
  scan: [
    "  +----------+",
    "  |----------|",
    "  |    ()    |",
    "  +----------+",
    "     |    |"
  ],
  read: [
    "  +----------+",
    "  |    ()    |",
    "  |----------|",
    "  +----------+",
    "     |    |"
  ],
  admit: [
    "  +----------+",
    "  |    ()    |",
    "  |    ||    |",
    "  +----------+",
    "     |    |"
  ],
  held: [
    "  +----------+",
    "  |    ()    |",
    "  |    ||    |",
    "  +----------+",
    "     |    |"
  ]
};

const UNICODE_MARK: Record<VaultMarkState, string[]> = {
  locked: [
    "  ╭──────────╮",
    "  │    ()    │",
    "  │    ||    │",
    "  ╰──┬────┬──╯",
    "     │    │"
  ],
  scan: [
    "  ╭──────────╮",
    "  │──────────│",
    "  │    ()    │",
    "  ╰──┬────┬──╯",
    "     │    │"
  ],
  read: [
    "  ╭──────────╮",
    "  │    ()    │",
    "  │──────────│",
    "  ╰──┬────┬──╯",
    "     │    │"
  ],
  admit: [
    "  ╭──────────╮",
    "  │    ()    │",
    "  │    ||    │",
    "  ╰──┬────┬──╯",
    "     │    │"
  ],
  held: [
    "  ╭──────────╮",
    "  │    ()    │",
    "  │    ||    │",
    "  ╰──┬────┬──╯",
    "     │    │"
  ]
};

function styleForTone(theme: Theme, tone: VaultMarkTone): (text: string) => string {
  switch (tone) {
    case "warn":
      return theme.style.yellow;
    case "error":
      return theme.style.red;
    case "muted":
      return theme.style.dim;
    case "mint":
      return theme.style.mint;
  }
}

export function renderVaultMark(
  theme: Theme,
  options: { state?: VaultMarkState; tone?: VaultMarkTone } = {}
): string[] {
  const state = options.state ?? "locked";
  const tone = options.tone ?? (state === "held" ? "warn" : "mint");
  const mark = theme.unicode ? UNICODE_MARK[state] : ASCII_MARK[state];
  const style = styleForTone(theme, tone);
  return mark.map((line) => style(line));
}

export function renderBrandHeader(
  stream: NodeJS.WriteStream = process.stdout,
  options: { compact?: boolean } = {}
): string {
  const theme = makeTheme(stream);
  const tagline = `reviewed ${theme.symbol.arrow} signed ${theme.symbol.arrow} admitted`;
  if (options.compact || theme.width < 72) {
    return `${badge("vault", theme)} ${theme.style.bold("AutoVault")} ${theme.style.dim(tagline)}\n`;
  }

  const mark = renderVaultMark(theme);
  return [
    "",
    `${mark[0]}  ${theme.style.bold("AutoVault")}`,
    `${mark[1]}  ${tagline}`,
    `${mark[2]}  ${theme.style.dim("reviewed skill vault for Claude Code, Codex, and Cursor")}`,
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
    `${theme.style.mint(theme.symbol.check)} ${theme.style.bold(title)}`,
    ...lines.map((line) => `  ${line}`),
    rule,
    ""
  ].join("\n");
}
