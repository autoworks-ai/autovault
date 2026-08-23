import { spawn } from "node:child_process";

export function openBrowser(url: string): boolean {
  try {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", () => {
      // Fire-and-forget: the caller already printed the URL.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function shouldOpenBrowser(input: {
  json?: boolean;
  noBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
} = {}): boolean {
  if (input.json) return false;
  if (input.noBrowser) return false;
  const env = input.env ?? process.env;
  if (env.CI) return false;
  if (env.AUTOVAULT_NO_BROWSER === "1") return false;
  const stdinIsTty = input.stdinIsTty ?? process.stdin.isTTY === true;
  const stdoutIsTty = input.stdoutIsTty ?? process.stdout.isTTY === true;
  return stdinIsTty && stdoutIsTty;
}
