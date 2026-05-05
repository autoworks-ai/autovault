import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import {
  asBinBlock,
  ensureStorage,
  listInstalledSkillNames,
  readSkill,
  readSkillManifest,
  recoverOrphanBackups,
  skillDir
} from "../storage/index.js";
import { parseFrontmatter } from "../validation/frontmatter.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { verifyFile } from "../util/sign.js";
import { canonicalRelPath } from "../util/path.js";
import type { SkillBinAction } from "../types.js";

const RESERVED_ACTIONS = new Set(["list", "which"]);
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage(): never {
  process.stderr.write(`Usage:
  autovault skill <action> <name>     # run bin.<action> declared by skill <name>
  autovault skill list                # list installed skills and their declared bin actions
  autovault skill which <name> [<action>]
                                       # print resolved script path(s) without running
`);
  process.exit(1);
}

export async function runSkillCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") usage();

  // Round-44 fix: writeSkill stages live → bak → live; if the process dies
  // between rename(live, bak) and rename(tmp, live) the skill is only on
  // disk under `<name>.bak.*`. Recovery rolls that backup forward, but it
  // was previously only wired into MCP server startup. A user invoking
  // `autovault skill list/which/<action>` after exactly the crash this
  // recovery is for would see the skill as missing — stranding the backup
  // on the primary user-facing surface. ensureStorage + recoverOrphanBackups
  // here mirror what src/index.ts does at MCP boot. Both are storage-locked
  // and safe to call concurrently with a running MCP server.
  await ensureStorage();
  await recoverOrphanBackups();

  if (sub === "list") {
    await listAction();
    return;
  }

  if (sub === "which") {
    const [name, action] = rest;
    if (!name) usage();
    await whichAction(name, action);
    return;
  }

  if (!ACTION_NAME_PATTERN.test(sub) || RESERVED_ACTIONS.has(sub)) {
    fail(`Invalid action name: ${sub}`);
  }

  const [name] = rest;
  if (!name) usage();
  await runAction(sub, name, rest.slice(1));
}

async function listAction(): Promise<void> {
  await ensureStorage();
  const names = await listInstalledSkillNames();
  if (names.length === 0) {
    process.stdout.write("No skills installed.\n");
    return;
  }
  for (const name of names.sort()) {
    const skill = await readSkill(name);
    const actions = skill ? Object.keys(skill.bin) : [];
    if (actions.length === 0) {
      process.stdout.write(`${name}\n`);
      continue;
    }
    process.stdout.write(`${name}: ${actions.sort().join(", ")}\n`);
  }
}

async function whichAction(name: string, action?: string): Promise<void> {
  assertSafeSkillName(name);

  // `which` is documented as a way to inspect what would be exec'd. If we read
  // SKILL.md without verifying it against the manifest, post-install tampering
  // can make this print an attacker-controlled path — and a user piping that
  // path into `bash` or sourcing it would step around the signed-exec path.
  // Apply the same hard verification as runAction so `which` is safe to trust.
  const manifest = await readSkillManifest(name);
  if (!manifest) {
    fail(
      `Refusing to print: no signed manifest for skill '${name}'. Reinstall the skill.`
    );
  }
  const skillMdPath = path.join(skillDir(name), "SKILL.md");
  let skillMdContent: string;
  try {
    skillMdContent = await fs.readFile(skillMdPath, "utf-8");
  } catch (error) {
    fail(`Skill not installed: ${name} (${String(error)})`);
  }
  const skillMdResult = await verifyFile(manifest!, name, "SKILL.md", skillMdContent!);
  if (!skillMdResult.present || !skillMdResult.valid) {
    fail(
      `Refusing to print: SKILL.md signature mismatch for skill '${name}'. The skill metadata may have been tampered with — reinstall the skill.`
    );
  }

  // Parse bin metadata from the verified bytes. A second on-disk read here
  // (e.g. readSkill) opens a race: an attacker swapping SKILL.md between the
  // verify and the re-read can substitute attacker-controlled command/args
  // while the body still verifies. `which` would then print a path derived
  // from tampered bin metadata.
  let bin: Record<string, SkillBinAction>;
  try {
    const { data } = parseFrontmatter(skillMdContent!);
    bin = asBinBlock((data as Record<string, unknown>).bin);
  } catch (error) {
    fail(`Refusing to print: SKILL.md frontmatter unparseable (${String(error)})`);
  }
  const storageRoot = loadConfig().storagePath;

  async function verifiedPathOrFail(act: string, entry: SkillBinAction): Promise<string> {
    const resolved = resolveCommandPath(name, entry);
    await assertWithinStorage(resolved, storageRoot);
    const manifestKey = canonicalRelPath(entry.command);
    let body: string;
    try {
      body = await fs.readFile(resolved, "utf-8");
    } catch (error) {
      fail(`Refusing to print: ${resolved} is not accessible (${String(error)})`);
    }
    // verifyFile does both the manifest-coverage check and the bound
    // (skill, path, content) signature check. The two-stage error reporting
    // distinguishes "not covered by manifest" (probably a build mistake) from
    // "signature mismatch" (post-install tamper) so the user sees the right
    // remediation hint.
    const result = await verifyFile(manifest!, name, manifestKey, body!);
    if (!result.present) {
      fail(
        `Refusing to print: '${manifestKey}' is not covered by the signed manifest for '${name}'.`
      );
    }
    if (!result.valid) {
      fail(
        `Refusing to print: signature mismatch for '${manifestKey}' in skill '${name}' (action '${act}'). The file may have been tampered with — reinstall the skill.`
      );
    }
    return resolved;
  }

  if (action) {
    if (!ACTION_NAME_PATTERN.test(action)) fail(`Invalid action name: ${action}`);
    const entry = bin![action];
    if (!entry) fail(`No '${action}' declared for skill '${name}'`);
    const resolved = await verifiedPathOrFail(action, entry);
    process.stdout.write(`${formatExecLine(resolved, entry, skillDir(name))}\n`);
    return;
  }
  const entries = Object.entries(bin!);
  if (entries.length === 0) {
    process.stdout.write(`No bin actions declared for ${name}\n`);
    return;
  }
  for (const [act, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const resolved = await verifiedPathOrFail(act, entry);
    process.stdout.write(`${act}\t${formatExecLine(resolved, entry, skillDir(name))}\n`);
  }
}

// `skill which` is the documented review surface — users inspect this BEFORE
// they hand control to a script that may handle secrets. Printing only the
// resolved path hides the signed argv that `runAction` will actually pass to
// spawn(); a benign-looking script can have attacker-supplied args (config
// paths, mode flags) that materially change behavior. The output here mirrors
// what runAction does: spawn(command, args, { cwd: skillDir(name) }). We
// print a shell-escaped command line plus an explicit `# cwd:` annotation so
// what the user reviews is what gets exec'd.
function formatExecLine(commandPath: string, entry: SkillBinAction, cwd: string): string {
  const tokens = [commandPath, ...entry.args];
  const escaped = tokens.map(shellEscape).join(" ");
  return `${escaped}\t# cwd: ${cwd}`;
}

// POSIX-shell-safe quoting. Tokens matching the safe set are printed bare; all
// others get wrapped in single quotes with embedded `'` rewritten as `'\''`.
// This is the canonical shell-escape that round-trips through `sh -c`.
//
// Defense-in-depth against C0/DEL spoofing: validation rejects control chars
// in bin.command and bin.args at install time, but a skill installed before
// that gate landed (or via a pre-existing manifest) could still ship a
// signed argv with `\n`/`\r`/`\x1b`. POSIX single-quotes are LITERAL — a
// newline inside `'...'` stays a newline byte in terminal output, which is
// exactly the spoofing vector. When any control char is present, fall back
// to JSON.stringify so the byte renders as a visible escape sequence
// (`\n`, ``, etc.) rather than performing its terminal effect.
function shellEscape(token: string): string {
  if (token === "") return "''";
  if (/[\x00-\x1F\x7F]/.test(token)) return JSON.stringify(token);
  if (/^[A-Za-z0-9_/.@:=+,-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

async function runAction(action: string, name: string, extraArgs: string[]): Promise<void> {
  if (extraArgs.length > 0) {
    fail(
      `Extra arguments are not accepted; bin.<action>.args is authoritative. Got: ${extraArgs.join(" ")}`
    );
  }
  assertSafeSkillName(name);

  const storageRoot = loadConfig().storagePath;

  // Hard signature enforcement starts here. We must verify SKILL.md against the
  // manifest BEFORE we trust any frontmatter (command, args, requires-tty, the
  // set of declared actions) — otherwise post-install SKILL.md tampering can
  // change exec metadata while keeping a still-signed bin file body.
  const manifest = await readSkillManifest(name);
  if (!manifest) {
    fail(
      `Refusing to exec: no signed manifest for skill '${name}'. Reinstall the skill (or use 'autovault skill which' to inspect).`
    );
  }
  const skillMdPath = path.join(skillDir(name), "SKILL.md");
  let skillMdContent: string;
  try {
    skillMdContent = await fs.readFile(skillMdPath, "utf-8");
  } catch (error) {
    fail(`Skill not installed: ${name} (${String(error)})`);
  }
  const skillMdResult = await verifyFile(manifest!, name, "SKILL.md", skillMdContent!);
  if (!skillMdResult.present) {
    fail(`Refusing to exec: SKILL.md is not covered by the signed manifest for '${name}'.`);
  }
  if (!skillMdResult.valid) {
    fail(
      `Refusing to exec: SKILL.md signature mismatch for skill '${name}'. The skill metadata may have been tampered with — reinstall the skill.`
    );
  }

  // Parse bin metadata from the SAME bytes we just verified. A second on-disk
  // read here (e.g. via readSkill) opens a race window: an attacker who swaps
  // SKILL.md between the verify and the re-read can substitute attacker-
  // controlled `command` or `args[]` while the file body still verifies. The
  // signed binding is action+command+args+SKILL.md — so the only safe place to
  // pull bin metadata is the exact bytes verifyFile just signed off on.
  let bin: Record<string, SkillBinAction>;
  try {
    const { data } = parseFrontmatter(skillMdContent!);
    bin = asBinBlock((data as Record<string, unknown>).bin);
  } catch (error) {
    fail(`Refusing to exec: SKILL.md frontmatter unparseable (${String(error)})`);
  }

  const entry = bin![action];
  if (!entry) {
    process.stdout.write(`No ${action} declared for skill '${name}'\n`);
    return;
  }

  const target = resolveCommandPath(name, entry);
  await assertWithinStorage(target, storageRoot);
  await assertExecutableFile(target);

  const manifestKey = canonicalRelPath(entry.command);
  // Early verify: catches static tamper with a clear "signature mismatch"
  // error before we ever touch the TTY check. Without this, a non-interactive
  // user would only learn about a tampered file after the TTY refusal, which
  // hides the real (worse) problem. verifyFile binds (skill, path, content),
  // so a manifest entry lifted from another skill or another path within the
  // same skill fails to verify here.
  const fileContent = await fs.readFile(target, "utf-8");
  const earlyResult = await verifyFile(manifest!, name, manifestKey, fileContent);
  if (!earlyResult.present) {
    fail(`Refusing to exec: '${manifestKey}' is not covered by the signed manifest for '${name}'.`);
  }
  if (!earlyResult.valid) {
    fail(
      `Refusing to exec: signature mismatch for '${manifestKey}' in skill '${name}'. The file may have been tampered with — reinstall the skill.`
    );
  }

  // Hard TTY enforcement: a TTY is always required for bin exec. There is no
  // env-var or config bypass — a per-process flag is settable by whoever spawns
  // the CLI (including the agent we're trying to wall off), so it would not be
  // a real wall. If a user genuinely needs to automate, they can invoke the
  // script directly at `$AUTOVAULT_STORAGE_PATH/skills/<name>/<bin.command>`,
  // accepting that they're stepping outside the signed-exec path on purpose.
  // (Don't pipe `skill which` output into `bash $(…)` — that line is shaped
  // for human review and its quoting + `# cwd:` annotation do not survive
  // command substitution.)
  if (!process.stdin.isTTY) {
    fail(
      `Action '${action}' for skill '${name}' requires an interactive terminal. Bin actions must be run from a real TTY; non-interactive use is intentionally not supported through this CLI.`
    );
  }

  // Re-verify immediately before spawn. Node has no fexecve(2), so
  // spawn(target) is unavoidably a fresh path lookup — same-UID concurrent
  // attackers can race verify→exec. Re-verifying here narrows the window to
  // OS scheduling time (microseconds). It does NOT close the race; see
  // THREAT-MODEL.md "Residual TOCTOU" for what this boundary actually buys.
  const recheck = await fs.readFile(target, "utf-8");
  const recheckResult = await verifyFile(manifest!, name, manifestKey, recheck);
  if (!recheckResult.present || !recheckResult.valid) {
    fail(
      `Refusing to exec: signature mismatch for '${manifestKey}' in skill '${name}' on re-verify. The file may have been tampered with — reinstall the skill.`
    );
  }

  await new Promise<void>((resolve) => {
    const child = spawn(target, entry.args, {
      stdio: "inherit",
      cwd: skillDir(name)
    });
    child.on("error", (error) => {
      process.stderr.write(`autovault skill ${action}: ${String(error)}\n`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`autovault skill ${action}: terminated by signal ${signal}\n`);
        process.exit(1);
      }
      process.exit(code ?? 0);
      resolve();
    });
  });
}

// Canonicalize entry.command (POSIX-slash, normalized) BEFORE joining with the
// skill directory. Validation and writeSkill both store/sign resources under
// the canonical form, so the manifest lookup uses canonicalRelPath(entry.command);
// resolving the raw command on POSIX would look for a literal-backslash
// filename like `bin\setup` while the signed resource is at `bin/setup`. The
// install would succeed (validation maps the canonical key to a real resource)
// but every `skill which`/exec call would fail with "not accessible". Mirror
// the exact transform used by the manifest key here so storage-write,
// validation, manifest-verify, and CLI-resolve agree on one path string.
//
// An empty canonical path (entry.command was `.`, `./`, or whitespace) means
// the author declared an action that does not actually point at a file. That's
// always a misconfiguration; fail loudly instead of joining empty and walking
// the skill root as a "command."
function resolveCommandPath(name: string, entry: SkillBinAction): string {
  const canonical = canonicalRelPath(entry.command);
  if (canonical === "") {
    fail(`Refusing to resolve: bin command for skill '${name}' is empty after canonicalization (got '${entry.command}')`);
  }
  return path.resolve(skillDir(name), canonical);
}

async function assertWithinStorage(target: string, storageRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(storageRoot);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    fail(`Refusing to exec: resolved path escapes storage root (${target})`);
  }
}

async function assertExecutableFile(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    fail(`Refusing to exec: ${target} is not accessible (${String(error)})`);
  }
  if (!stat!.isFile()) fail(`Refusing to exec: ${target} is not a regular file`);
}
