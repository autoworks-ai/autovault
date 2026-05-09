import { badge } from "./messages.js";
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

function renderSpeechLine(theme: Theme, message: string): string {
  return `${badge("vault", theme)} ${theme.style.bold("Vault:")} ${message}`;
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
    stream.write(`${renderSpeechLine(theme, message)}\n`);
    return;
  }

  let lines = 0;
  stream.write("\x1b[?25l");
  try {
    for (let i = 0; i <= words.length; i += 1) {
      const current = words.slice(0, i).join(" ");
      erasePreviousBlock(stream, lines);
      const block = renderSpeechLine(theme, current);
      stream.write(`${block}\n`);
      lines = block.split("\n").length;
      await sleep(i === 0 ? 120 : 55 + (i % 4) * 20);
    }
    await sleep(260);
  } finally {
    stream.write("\x1b[?25h");
  }
}
