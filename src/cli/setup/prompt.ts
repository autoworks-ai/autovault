import fs from "node:fs";
import readline from "node:readline";
import { Writable } from "node:stream";
import { colorsFor } from "./render.js";

export class NoTtyError extends Error {
  constructor() {
    super(
      "autovault setup requires an interactive terminal. Re-run from a TTY (or pass AUTOVAULT_YES=1 to install.sh and run setup later)."
    );
    this.name = "NoTtyError";
  }
}

function ttyAvailable(): boolean {
  if (process.stdin.isTTY) return true;
  let fd: number | undefined;
  try {
    fd = fs.openSync("/dev/tty", "r+");
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

type Stream = { input: NodeJS.ReadableStream; output: Writable; close: () => void };

function openTtyStreams(): Stream {
  if (process.stdin.isTTY) {
    return {
      input: process.stdin,
      output: process.stdout,
      close: () => {}
    };
  }
  // Piped stdin (curl | sh) — open /dev/tty directly so prompts still work.
  const fd = fs.openSync("/dev/tty", "r+");
  const input = fs.createReadStream("", { fd, autoClose: false });
  const output = fs.createWriteStream("", { fd, autoClose: false });
  return {
    input,
    output,
    close: () => {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  };
}

export type PromptResult<T> = { value: T };

function makeInterface(stream: Stream): readline.Interface {
  return readline.createInterface({
    input: stream.input,
    output: stream.output,
    terminal: true
  });
}

export async function ask(question: string): Promise<string> {
  if (!ttyAvailable()) throw new NoTtyError();
  const stream = openTtyStreams();
  const rl = makeInterface(stream);
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
    stream.close();
  }
}

export type Choice<T> = {
  key: string;
  label: string;
  value: T;
  applyToAllKey?: string;
};

export async function askChoice<T>(
  prompt: string,
  choices: Choice<T>[],
  options?: { applyToAllPrompt?: string }
): Promise<{ value: T; applyToAll: boolean }> {
  if (!ttyAvailable()) throw new NoTtyError();
  const stream = openTtyStreams();
  const c = colorsFor(stream.output as NodeJS.WriteStream);
  const rl = makeInterface(stream);
  try {
    while (true) {
      stream.output.write(`${prompt}\n`);
      for (const choice of choices) {
        const apply = choice.applyToAllKey
          ? `  ${c.dim}or ${choice.applyToAllKey} for all${c.reset}`
          : "";
        stream.output.write(`  [${c.bold}${choice.key}${c.reset}] ${choice.label}${apply}\n`);
      }
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${c.magenta}?${c.reset} choice: `, (a) => resolve(a.trim()));
      });
      if (answer.length === 0) {
        stream.output.write(`${c.yellow}!${c.reset} pick a letter from the list above\n`);
        continue;
      }
      const lowered = answer.toLowerCase();
      const direct = choices.find((choice) => choice.key.toLowerCase() === lowered);
      if (direct) return { value: direct.value, applyToAll: false };
      const allMatch = choices.find(
        (choice) =>
          choice.applyToAllKey !== undefined &&
          choice.applyToAllKey.toLowerCase() === lowered
      );
      if (allMatch) return { value: allMatch.value, applyToAll: true };
      stream.output.write(`${c.yellow}!${c.reset} unrecognized choice "${answer}"\n`);
    }
  } finally {
    rl.close();
    stream.close();
  }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${suffix} `)).toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

export function isTtyAvailable(): boolean {
  return ttyAvailable();
}
