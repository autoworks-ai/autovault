import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "../util/version-compare.js";
import { writeJson } from "./ui/output.js";
import { makeTheme } from "./ui/theme.js";
import { badge } from "./ui/messages.js";
import { confirm as promptConfirm, isTtyAvailable } from "./setup/prompt.js";

const PACKAGE_NAME = "@autoworks-ai/autovault";
const REPO = "autoworks-ai/autovault";
const RELEASES_URL = `https://github.com/${REPO}/releases`;

type PackageMetadata = {
  root: string;
  version: string;
};

export type VersionInfo = {
  version: string;
  node: string;
  installPath: string;
  storagePath: string;
  installMethod: string;
};

type UpdateAvailability = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
};

export type UpdateRunnerCall = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export type UpdateRunner = (call: UpdateRunnerCall) => number | Promise<number>;

type UpdateCommandOptions = {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  versionInfo?: () => VersionInfo;
  latestVersion?: (currentVersion: string, options?: { timeoutMs?: number }) => string;
  runner?: UpdateRunner;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
};

function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
        if (parsed.name === PACKAGE_NAME) return dir;
      } catch {
        // Continue walking; a malformed nearby package.json is not our root.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate AutoVault package metadata.");
}

function readPackageMetadata(): PackageMetadata {
  const root = findPackageRoot();
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version?: string;
  };
  return { root, version: parsed.version ?? "0.0.0" };
}

function detectInstallMethod(packageRoot: string): string {
  const resolved = path.resolve(packageRoot);
  const sourceInstall = path.join(os.homedir(), ".autovault", "app");
  if (resolved === sourceInstall || resolved.endsWith(`${path.sep}.autovault${path.sep}app`)) {
    return "source";
  }
  if (
    resolved.includes(`${path.sep}node_modules${path.sep}@autoworks-ai${path.sep}autovault`)
  ) {
    return "npm";
  }
  if (
    resolved.includes(`${path.sep}Cellar${path.sep}autovault${path.sep}`) ||
    resolved.includes(`${path.sep}Homebrew${path.sep}Library${path.sep}Taps${path.sep}`)
  ) {
    return "homebrew";
  }
  if (fs.existsSync(path.join(resolved, "src", "cli.ts"))) return "source-tree";
  return "unknown";
}

function defaultStoragePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTOVAULT_STORAGE_PATH ?? path.join(os.homedir(), ".autovault");
}

export function versionInfo(env: NodeJS.ProcessEnv = process.env): VersionInfo {
  const metadata = readPackageMetadata();
  return {
    version: metadata.version,
    node: process.version,
    installPath: metadata.root,
    storagePath: defaultStoragePath(env),
    installMethod: detectInstallMethod(metadata.root)
  };
}

function latestStableVersion(
  currentVersion: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): string {
  const env = options.env ?? process.env;
  if (env.AUTOVAULT_LATEST_VERSION) return env.AUTOVAULT_LATEST_VERSION;
  const result = spawnSync("npm", ["view", PACKAGE_NAME, "version", "--silent"], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15_000
  });
  const latest = result.status === 0 ? result.stdout.trim() : "";
  return latest || currentVersion;
}

function updateAvailability(
  currentVersion: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; latestVersion?: UpdateCommandOptions["latestVersion"] } = {}
): UpdateAvailability {
  const latestVersion =
    options.latestVersion?.(currentVersion, { timeoutMs: options.timeoutMs }) ??
    latestStableVersion(currentVersion, { timeoutMs: options.timeoutMs, env: options.env });
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(currentVersion, latestVersion) === -1
  };
}

export function renderUpdateNotice(
  info: VersionInfo,
  options: {
    stdout?: NodeJS.WriteStream;
    env?: NodeJS.ProcessEnv;
    latestVersion?: UpdateCommandOptions["latestVersion"];
  } = {}
): string {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  if (env.AUTOVAULT_NO_UPDATE_CHECK === "1") return "";
  if (stdout.isTTY !== true && !env.AUTOVAULT_LATEST_VERSION) return "";
  const update = updateAvailability(info.version, {
    timeoutMs: 1_000,
    env,
    latestVersion: options.latestVersion
  });
  if (!update.updateAvailable) return "";
  const theme = makeTheme(stdout);
  return [
    `${badge("update", theme, "warn")} ${theme.style.yellow("Update available:")} AutoVault ${update.currentVersion} -> ${update.latestVersion}`,
    `  Run     ${theme.style.cyan("`autovault update`")}`,
    `  Disable ${theme.style.cyan("`AUTOVAULT_NO_UPDATE_CHECK=1`")}`
  ].join("\n") + "\n";
}

export function renderOptionalUpdateNotice(
  options: {
    stdout?: NodeJS.WriteStream;
    env?: NodeJS.ProcessEnv;
    versionInfo?: () => VersionInfo;
    latestVersion?: UpdateCommandOptions["latestVersion"];
  } = {}
): string {
  try {
    const env = options.env ?? process.env;
    const info = options.versionInfo?.() ?? versionInfo(env);
    return renderUpdateNotice(info, {
      stdout: options.stdout,
      env,
      latestVersion: options.latestVersion
    });
  } catch {
    return "";
  }
}

export function writeOptionalUpdateNotice(
  options: {
    stdout?: NodeJS.WriteStream;
    env?: NodeJS.ProcessEnv;
    versionInfo?: () => VersionInfo;
    latestVersion?: UpdateCommandOptions["latestVersion"];
  } = {}
): void {
  const stdout = options.stdout ?? process.stdout;
  const notice = renderOptionalUpdateNotice({ ...options, stdout });
  if (notice) stdout.write(notice);
}

export function printVersion(args: string[]): void {
  const info = versionInfo();
  if (args.includes("--json")) {
    writeJson(info);
    return;
  }
  process.stdout.write(`autovault ${info.version}\n`);
  process.stdout.write(renderUpdateNotice(info));
}

type ParsedUpdateArgs = {
  dryRun: boolean;
  notes: boolean;
  yes: boolean;
  target?: string;
};

function parseUpdateArgs(args: string[]): ParsedUpdateArgs | string {
  let dryRun = false;
  let notes = false;
  let yes = false;
  let target: string | undefined;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--notes") {
      notes = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg.startsWith("-")) return `Unknown autovault update flag: ${arg}`;
    if (target) return "autovault update accepts at most one target.";
    target = arg;
  }

  return { dryRun, notes, yes, target };
}

function normalizeUpdateTarget(
  target: string | undefined,
  currentVersion: string,
  options: {
    env: NodeJS.ProcessEnv;
    latestVersion?: UpdateCommandOptions["latestVersion"];
  }
): { ref: string; latestVersion: string; stableTarget: boolean } | string {
  const requested = target ?? "latest";
  const stableTarget = requested === "latest" || requested === "stable";
  const latest =
    options.latestVersion?.(currentVersion) ??
    latestStableVersion(currentVersion, { env: options.env });
  if (stableTarget) return { ref: `v${latest.replace(/^v/, "")}`, latestVersion: latest, stableTarget };
  if (requested === "main") return { ref: "main", latestVersion: latest, stableTarget: false };
  if (/^\d+\.\d+\.\d+/.test(requested)) {
    return { ref: `v${requested}`, latestVersion: latest, stableTarget: false };
  }
  if (/^v\d+\.\d+\.\d+/.test(requested)) {
    return { ref: requested, latestVersion: latest, stableTarget: false };
  }
  return `Unsupported update target: ${requested}`;
}

function updateNotesUrl(ref: string): string {
  return ref === "main" ? `${RELEASES_URL}/latest` : `${RELEASES_URL}/tag/${ref}`;
}

function npmUpdateCommand(ref: string): UpdateRunnerCall {
  if (ref === "main") {
    return {
      command: "npm",
      args: ["install", "-g", `github:${REPO}#main`],
      env: process.env
    };
  }
  const version = ref.replace(/^v/, "");
  return {
    command: "npm",
    args: ["install", "-g", `${PACKAGE_NAME}@${version}`],
    env: process.env
  };
}

function updateCallFor(info: VersionInfo, ref: string, env: NodeJS.ProcessEnv): UpdateRunnerCall | string {
  if (info.installMethod === "npm") {
    return { ...npmUpdateCommand(ref), env };
  }
  if (info.installMethod === "homebrew" && ref === "main") {
    return {
      command: "brew",
      args: ["reinstall", "--HEAD", "autoworks-ai/tap/autovault"],
      env
    };
  }
  if (info.installMethod === "homebrew") {
    return {
      command: "brew",
      args: ["upgrade", "autoworks-ai/tap/autovault"],
      env
    };
  }
  if (info.installMethod === "source" || info.installMethod === "source-tree") {
    const scriptPath = path.join(info.installPath, "scripts", "install.sh");
    if (!fs.existsSync(scriptPath)) {
      return (
        `Cannot update this AutoVault install automatically; installer not found at ${scriptPath}.\n` +
        `Install manually with: ${formatCommand(npmUpdateCommand(ref))}`
      );
    }
    return {
      command: "sh",
      args: [scriptPath],
      env: {
        ...env,
        AUTOVAULT_REF: ref,
        AUTOVAULT_YES: "1"
      }
    };
  }
  return `Cannot update this AutoVault install automatically. Install manually with: ${formatCommand(npmUpdateCommand(ref))}`;
}

function formatCommand(call: Pick<UpdateRunnerCall, "command" | "args">): string {
  return [call.command, ...call.args].join(" ");
}

function formatPlanCommand(call: UpdateRunnerCall, ref: string): string {
  if (call.command === "sh") {
    return `AUTOVAULT_REF=${ref} AUTOVAULT_YES=1 ${formatCommand(call)}`;
  }
  return formatCommand(call);
}

function targetVersion(ref: string): string {
  return ref === "main" ? "main" : ref.replace(/^v/, "");
}

function changelogSection(version: string, packageRoot: string): string | null {
  const changelogPath = path.join(packageRoot, "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) return null;
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^## \\[?v?${escaped}\\]?[^\\n]*\\n`, "m");
  const match = pattern.exec(changelog);
  if (!match) return null;
  const start = match.index;
  const next = changelog.slice(start + match[0].length).search(/^## /m);
  const end = next === -1 ? changelog.length : start + match[0].length + next;
  return changelog.slice(start, end).trim();
}

function printUpdateNotes(ref: string, info: VersionInfo, stdout: NodeJS.WriteStream): void {
  const version = ref.replace(/^v/, "");
  const section = ref === "main"
    ? changelogSection("Unreleased", info.installPath)
    : changelogSection(version, info.installPath);
  if (section) {
    stdout.write(`\n${section}\n`);
  } else {
    stdout.write(`\nRelease notes: ${updateNotesUrl(ref)}\n`);
  }
}

function defaultRunner(call: UpdateRunnerCall): number {
  const result = spawnSync(call.command, call.args, {
    env: call.env,
    stdio: "inherit"
  });
  return result.status ?? 1;
}

function shouldReportUpToDate(
  currentVersion: string,
  ref: string,
  latestVersion: string,
  stableTarget: boolean
): boolean {
  if (ref === "main") return false;
  const requestedVersion = targetVersion(ref);
  const stableComparison = compareVersions(currentVersion, latestVersion);
  if (stableTarget && stableComparison !== null && stableComparison >= 0) return true;
  return compareVersions(currentVersion, requestedVersion) === 0;
}

export async function runUpdateCommand(
  args: string[],
  options: UpdateCommandOptions = {}
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = { ...process.env, ...options.env };
  const parsed = parseUpdateArgs(args);
  if (typeof parsed === "string") {
    stderr.write(`${parsed}\n`);
    return 2;
  }

  const info = options.versionInfo?.() ?? versionInfo(env);
  const normalized = normalizeUpdateTarget(parsed.target, info.version, {
    env,
    latestVersion: options.latestVersion
  });
  if (typeof normalized === "string") {
    stderr.write(`${normalized}\n`);
    return 2;
  }

  const call = updateCallFor(info, normalized.ref, env);
  if (typeof call === "string") {
    stderr.write(`${call}\n`);
    return 2;
  }

  const theme = makeTheme(stdout);
  stdout.write(`${badge("update", theme)} ${theme.style.bold("AutoVault update")}\n`);
  stdout.write("Checking for updates\n");
  stdout.write(`  Current: ${info.version}\n`);
  stdout.write(`  Latest:  ${normalized.latestVersion}\n`);
  stdout.write(`  Target:  ${normalized.ref}\n`);
  stdout.write(`  Method:  ${info.installMethod}\n`);
  stdout.write(`  Command: ${formatPlanCommand(call, normalized.ref)}\n`);

  if (parsed.notes) printUpdateNotes(normalized.ref, info, stdout);

  if (
    shouldReportUpToDate(
      info.version,
      normalized.ref,
      normalized.latestVersion,
      normalized.stableTarget
    )
  ) {
    stdout.write("\nAutoVault is already up to date.\n");
    return 0;
  }

  if (parsed.dryRun) return 0;

  const tty = options.isTty ?? isTtyAvailable();
  if (!parsed.yes) {
    if (!tty) {
      stdout.write("\nRun autovault update --yes to apply.\n");
      return 0;
    }
    const ok = await (options.confirm ?? promptConfirm)(
      `Update AutoVault ${info.version} -> ${targetVersion(normalized.ref)}?`,
      true
    );
    if (!ok) {
      stdout.write("Update canceled.\n");
      return 0;
    }
  }

  const status = await (options.runner ?? defaultRunner)(call);
  if (status !== 0) return status;
  if (info.installMethod === "npm" || info.installMethod === "homebrew") {
    stdout.write(
      "\nIf autovault still points to the old binary, run `hash -r` or open a new shell.\n"
    );
  }
  stdout.write(`Successfully updated to ${targetVersion(normalized.ref)}\n`);
  return 0;
}
