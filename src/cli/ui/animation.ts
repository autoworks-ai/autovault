import { badge } from "./messages.js";
import type { VaultMarkState } from "./brand.js";
import { makeTheme, type Theme } from "./theme.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldAnimate(stream: NodeJS.WriteStream): boolean {
  if (process.env.CI) return false;
  if (process.env.AUTOVAULT_ANIMATION === "0") return false;
  if (process.env.AUTOVAULT_ANIMATION === "1") return true;
  return stream.isTTY === true;
}

function renderStateLine(theme: Theme, state: VaultMarkState, message: string): string {
  const tone = state === "held" ? "warn" : "mint";
  return `${badge(state.toUpperCase(), theme, tone)} ${theme.style.bold("AutoVault:")} ${message}`;
}

function erasePreviousBlock(stream: NodeJS.WriteStream, lineCount: number): void {
  if (lineCount <= 0) return;
  stream.write(`\x1b[${lineCount}A`);
  for (let i = 0; i < lineCount; i += 1) {
    stream.write("\x1b[2K");
    if (i < lineCount - 1) stream.write("\x1b[1B");
  }
  if (lineCount > 1) stream.write(`\x1b[${lineCount - 1}A`);
}

export async function sayVault(
  message: string,
  stream: NodeJS.WriteStream = process.stdout
): Promise<void> {
  const theme = makeTheme(stream);
  const words = message.split(/\s+/).filter(Boolean);

  if (!shouldAnimate(stream)) {
    stream.write(`${renderStateLine(theme, "admit", message)}\n`);
    return;
  }

  let lines = 0;
  const states: VaultMarkState[] = ["scan", "read", "admit"];
  stream.write("\x1b[?25l");
  try {
    for (let i = 0; i <= words.length; i += 1) {
      const current = words.slice(0, i).join(" ");
      erasePreviousBlock(stream, lines);
      const state = i === words.length ? "admit" : states[i % states.length];
      const block = renderStateLine(theme, state, current);
      stream.write(`${block}\n`);
      lines = block.split("\n").length;
      await sleep(i === 0 ? 160 : 120 + (i % 3) * 30);
    }
    await sleep(260);
  } finally {
    stream.write("\x1b[?25h");
  }
}
