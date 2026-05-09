export const MINT = "#5ad6c0";

export type ColorMode = "auto" | "always" | "never";
export type SymbolMode = "auto" | "unicode" | "ascii";

export type ThemeOptions = {
  color?: ColorMode;
  symbols?: SymbolMode;
  width?: number;
};

export type Theme = {
  color: boolean;
  unicode: boolean;
  width: number;
  style: {
    bold(text: string): string;
    dim(text: string): string;
    red(text: string): string;
    green(text: string): string;
    yellow(text: string): string;
    blue(text: string): string;
    magenta(text: string): string;
    cyan(text: string): string;
    mint(text: string): string;
    inverseMint(text: string): string;
  };
  symbol: {
    check: string;
    cross: string;
    warn: string;
    info: string;
    bullet: string;
    arrow: string;
    line: string;
  };
};

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  black: "\x1b[30m",
  mint: "\x1b[38;2;90;214;192m",
  mintBg: "\x1b[48;2;90;214;192m"
};

export function streamWidth(stream: NodeJS.WriteStream = process.stdout): number {
  return Math.max(40, Math.min(stream.columns ?? 80, 120));
}

function shouldColor(stream: NodeJS.WriteStream, mode: ColorMode): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return stream.isTTY === true;
}

function shouldUseUnicode(mode: SymbolMode): boolean {
  if (mode === "unicode") return true;
  if (mode === "ascii") return false;
  if (process.env.AUTOVAULT_ASCII === "1") return false;
  if (process.env.TERM === "dumb") return false;
  return process.platform !== "win32" || Boolean(process.env.WT_SESSION);
}

function wrap(enabled: boolean, open: string): (text: string) => string {
  return (text) => (enabled && text.length > 0 ? `${open}${text}${ANSI.reset}` : text);
}

export function makeTheme(
  stream: NodeJS.WriteStream = process.stdout,
  options: ThemeOptions = {}
): Theme {
  const color = shouldColor(stream, options.color ?? "auto");
  const unicode = shouldUseUnicode(options.symbols ?? "auto");
  return {
    color,
    unicode,
    width: options.width ?? streamWidth(stream),
    style: {
      bold: wrap(color, ANSI.bold),
      dim: wrap(color, ANSI.dim),
      red: wrap(color, ANSI.red),
      green: wrap(color, ANSI.green),
      yellow: wrap(color, ANSI.yellow),
      blue: wrap(color, ANSI.blue),
      magenta: wrap(color, ANSI.magenta),
      cyan: wrap(color, ANSI.cyan),
      mint: wrap(color, ANSI.mint),
      inverseMint: (text) =>
        color && text.length > 0
          ? `${ANSI.mintBg}${ANSI.black}${text}${ANSI.reset}`
          : `[${text.trim()}]`
    },
    symbol: {
      check: unicode ? "✓" : "+",
      cross: unicode ? "✗" : "x",
      warn: unicode ? "▲" : "!",
      info: unicode ? "●" : "*",
      bullet: unicode ? "•" : "-",
      arrow: unicode ? "→" : "->",
      line: unicode ? "─" : "-"
    }
  };
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

export function padEndVisible(value: string, target: number): string {
  const length = visibleLength(value);
  if (length >= target) return value;
  return `${value}${" ".repeat(target - length)}`;
}

export function repeatVisible(char: string, count: number): string {
  return Array.from({ length: Math.max(0, count) }, () => char).join("");
}

