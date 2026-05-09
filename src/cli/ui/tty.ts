import fs from "node:fs";
import { Readable, Writable } from "node:stream";

export type TtyStreams = {
  input: Readable;
  output: Writable;
  close(): void;
};

export class NoTtyError extends Error {
  constructor() {
    super(
      "autovault setup requires an interactive terminal. Re-run from a TTY (or pass AUTOVAULT_YES=1 to install.sh and run setup later)."
    );
    this.name = "NoTtyError";
  }
}

export function isTtyAvailable(): boolean {
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

export function openTtyStreams(): TtyStreams {
  if (process.stdin.isTTY) {
    return {
      input: process.stdin,
      output: process.stdout,
      close: () => {}
    };
  }
  const fd = fs.openSync("/dev/tty", "r+");
  const input = fs.createReadStream("", { fd, autoClose: false });
  const output = fs.createWriteStream("", { fd, autoClose: false }) as unknown as NodeJS.WriteStream;
  output.isTTY = true;
  output.columns = process.stdout.columns ?? 80;
  output.rows = process.stdout.rows ?? 24;
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
