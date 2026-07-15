import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { sha256 } from "../util/hash.js";
import { readVerifiedSkillResources } from "./index.js";

// Machine-local render-fidelity index.
//
// AutoVault signs the canonical `.tpl` templates a skill ships, but Codex (and
// any future consumer) reads MACHINE-LOCAL rendered files through a symlink. The
// machine-specific substitution vars (project root, codex home, render root)
// cannot live in signed bytes, so the install-time helper records — into this
// index, a sibling of `rendered/` under the storage root — exactly what it
// produced: the owning skill, the render root, the managed link root, the
// `~/.codex` symlink, the content-hash of each vault template at render time,
// and the content-hash of each rendered file. `autovault doctor` reads this
// index and HASH-COMPARES; it never re-renders. One renderer, never two.
//
// Trust ceiling: this index is unsigned (or signed with the same vault key a
// same-UID writer can forge). It therefore defends against accidental drift and
// weaker-privilege tampering, NOT a same-UID attacker — consistent with the
// existing "storage-root write access = full vault compromise" accepted risk in
// docs/THREAT-MODEL.md.

export type RenderIndexTemplate = { path: string; hash: string };
export type RenderIndexRendered = { path: string; hash: string };

export type RenderIndexEntry = {
  skill: string;
  renderRoot: string;
  linkRoot: string;
  symlink: string;
  templates: RenderIndexTemplate[];
  rendered: RenderIndexRendered[];
};

export type RenderIndexLoad =
  | { kind: "absent" }
  | { kind: "corrupt"; reason: string }
  | { kind: "ok"; entries: RenderIndexEntry[] };

// Per-skill render-fidelity verdict. `skipped` means the skill has no index
// entry on this machine — genuinely never rendered here. CRITICAL: `skipped`
// is NOT `ok`. A cron/Codex preflight that wants "my bundle is installed AND
// verified" must positively assert `render.kind === "ok"` for its bundle —
// not the skill's overall `status` (skipped leaves that `ok`), and not exit
// code (skipped exits 0).
export type RenderFidelityStatus =
  | { kind: "ok"; entries: number }
  | { kind: "skipped" }
  | { kind: "error"; problems: string[] };

// Report-level sweep result: live managed symlinks with no backing entry
// (orphans) and entries whose owning skill is no longer installed
// (unverifiable). Both are render-state errors the global `doctor` run folds
// into the exit code.
export type RenderOrphanSweep = {
  orphans: string[];
  unverifiable: string[];
};

export function renderIndexPath(): string {
  return path.join(loadConfig().storagePath, "render-index.json");
}

function renderRootBoundary(): string {
  return path.resolve(path.join(loadConfig().storagePath, "rendered"));
}

function activeCodexLinkRoot(): string {
  const configured = process.env.CODEX_HOME?.trim();
  const home = process.env.HOME ?? os.homedir();
  const codexHome =
    configured === "~"
      ? home
      : configured?.startsWith("~/")
        ? path.join(home, configured.slice(2))
        : configured || path.join(home, ".codex");
  return path.resolve(codexHome, "automations");
}

// Resolve-based (NOT realpath-based) prefix check. The bash helper records
// absolute paths derived from the same literal AUTOVAULT_STORAGE_PATH the config
// reads, so `path.resolve` on both sides agrees without touching the filesystem
// — sidestepping macOS /tmp→/private symlink-prefix flakiness that realpath
// would introduce.
function resolvedWithin(target: string, root: string): boolean {
  const t = path.resolve(target);
  const r = path.resolve(root);
  return t === r || t.startsWith(r + path.sep);
}

function isShapeSafeRelative(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (path.isAbsolute(candidate)) return false;
  const normalized = candidate.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return normalized
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isStringField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseHashList(value: unknown): Array<{ path: string; hash: string }> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: Array<{ path: string; hash: string }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (!isStringField(record.path) || !isStringField(record.hash)) return null;
    if (!isShapeSafeRelative(record.path)) return null;
    if (!/^[a-f0-9]{64}$/.test(record.hash)) return null;
    if (seen.has(record.path)) return null;
    seen.add(record.path);
    out.push({ path: record.path, hash: record.hash });
  }
  return out;
}

function parseEntry(value: unknown): RenderIndexEntry | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !isStringField(record.skill) ||
    !isStringField(record.renderRoot) ||
    !isStringField(record.linkRoot) ||
    !isStringField(record.symlink)
  ) {
    return null;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(record.skill)) return null;
  if (
    !path.isAbsolute(record.renderRoot) ||
    !path.isAbsolute(record.linkRoot) ||
    !path.isAbsolute(record.symlink)
  ) {
    return null;
  }
  if (!resolvedWithin(record.renderRoot, renderRootBoundary())) return null;
  if (path.dirname(path.resolve(record.symlink)) !== path.resolve(record.linkRoot)) return null;
  const templates = parseHashList(record.templates);
  const rendered = parseHashList(record.rendered);
  if (!templates || !rendered) return null;
  return {
    skill: record.skill,
    renderRoot: record.renderRoot,
    linkRoot: record.linkRoot,
    symlink: record.symlink,
    templates,
    rendered
  };
}

export async function loadRenderIndex(): Promise<RenderIndexLoad> {
  let raw: string;
  try {
    raw = await fs.readFile(renderIndexPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "corrupt", reason: `unreadable render index: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: "corrupt", reason: `render index is not valid JSON: ${String(error)}` };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "corrupt", reason: "render index is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    return { kind: "corrupt", reason: "render index has an unsupported version" };
  }
  const list = record.entries;
  if (!Array.isArray(list)) {
    return { kind: "corrupt", reason: "render index has no entries array" };
  }
  const entries: RenderIndexEntry[] = [];
  const symlinks = new Set<string>();
  for (const candidate of list) {
    const entry = parseEntry(candidate);
    if (!entry) {
      return { kind: "corrupt", reason: "render index has a structurally invalid entry" };
    }
    const resolvedSymlink = path.resolve(entry.symlink);
    if (symlinks.has(resolvedSymlink)) {
      return { kind: "corrupt", reason: `render index has duplicate symlink: ${entry.symlink}` };
    }
    symlinks.add(resolvedSymlink);
    entries.push(entry);
  }
  return { kind: "ok", entries };
}

async function verifyEntry(entry: RenderIndexEntry): Promise<string[]> {
  const problems: string[] = [];
  const label = `${entry.skill} (${path.basename(entry.renderRoot)})`;

  // The render root must live under the vault render tree. Anything else means
  // the index is pointing the check at arbitrary disk — refuse.
  if (!resolvedWithin(entry.renderRoot, renderRootBoundary())) {
    problems.push(`${label}: render root is outside the vault render tree: ${entry.renderRoot}`);
    return problems;
  }

  // Steps 1+2 — template authenticity + staleness. readVerifiedSkillResources
  // runs the open-set integrity walk under the storage lock and returns the
  // VERIFIED template bytes; we then hash them and compare against the hash
  // recorded at render time. A mismatch means the template changed but the
  // bundle was never re-rendered (stale).
  const templatePaths = entry.templates.map((template) => template.path);
  let verified: Awaited<ReturnType<typeof readVerifiedSkillResources>>;
  try {
    verified = await readVerifiedSkillResources(entry.skill, templatePaths);
  } catch (error) {
    problems.push(`${label}: could not read templates: ${String(error)}`);
    return problems;
  }
  if (verified.kind !== "ok") {
    problems.push(
      `${label}: template integrity check failed (${verified.kind}${
        "resource" in verified ? `: ${verified.resource}` : ""
      })`
    );
    return problems;
  }
  const verifiedByPath = new Map(verified.resources.map((resource) => [resource.path, resource.content]));
  for (const template of entry.templates) {
    const content = verifiedByPath.get(template.path);
    if (content === undefined) {
      problems.push(`${label}: template not returned by integrity walk: ${template.path}`);
      continue;
    }
    if (sha256(content) !== template.hash) {
      problems.push(
        `${label}: template ${template.path} changed since render — reinstall the bundle to re-render`
      );
    }
  }

  // Step 3 — rendered files exist and match the recorded hash. Missing is a
  // failure, not a skip.
  for (const rendered of entry.rendered) {
    if (!isShapeSafeRelative(rendered.path)) {
      problems.push(`${label}: rendered path is unsafe: ${rendered.path}`);
      continue;
    }
    const renderedAbs = path.resolve(entry.renderRoot, rendered.path);
    if (!resolvedWithin(renderedAbs, entry.renderRoot)) {
      problems.push(`${label}: rendered path escapes the render root: ${rendered.path}`);
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(renderedAbs, "utf-8");
    } catch {
      problems.push(`${label}: rendered file missing: ${rendered.path}`);
      continue;
    }
    if (sha256(content) !== rendered.hash) {
      problems.push(`${label}: rendered file drifted (hand-edited or stale): ${rendered.path}`);
    }
  }

  // Step 4 — the recorded symlink is a symlink pointing at the render root.
  // Missing, present-but-not-a-symlink, and wrong-target all fail.
  let linkStat;
  try {
    linkStat = await fs.lstat(entry.symlink);
  } catch {
    problems.push(`${label}: codex symlink is missing: ${entry.symlink}`);
    return problems;
  }
  if (!linkStat.isSymbolicLink()) {
    problems.push(`${label}: codex automation path is not a symlink: ${entry.symlink}`);
    return problems;
  }
  let target: string;
  try {
    target = await fs.readlink(entry.symlink);
  } catch (error) {
    problems.push(`${label}: could not read codex symlink: ${String(error)}`);
    return problems;
  }
  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(path.dirname(entry.symlink), target);
  if (resolvedTarget !== path.resolve(entry.renderRoot)) {
    problems.push(
      `${label}: codex symlink points at ${resolvedTarget}, expected ${path.resolve(entry.renderRoot)}`
    );
  }

  return problems;
}

// Per-skill render-fidelity check. Filters the index to this skill's entries;
// no entry → skipped. Aggregates every entry's problems into one error verdict.
export async function verifyRenderForSkill(
  name: string,
  entries: RenderIndexEntry[]
): Promise<RenderFidelityStatus> {
  const owned = entries.filter((entry) => entry.skill === name);
  if (owned.length === 0) return { kind: "skipped" };
  const problems: string[] = [];
  for (const entry of owned) {
    problems.push(...(await verifyEntry(entry)));
  }
  if (problems.length > 0) return { kind: "error", problems };
  return { kind: "ok", entries: owned.length };
}

// Closed-set orphan sweep over the recorded managed link roots. Any symlink in
// a managed link root that points INTO the vault render tree but has no backing
// index entry is an orphan — the "render state/entry deleted but the live
// symlink survives, dangling" case. Entries whose owning skill is no longer
// installed are unverifiable: live rendered state for a skill whose signing
// templates are gone.
export async function sweepRenderOrphans(
  entries: RenderIndexEntry[],
  installedNames: Set<string>
): Promise<RenderOrphanSweep> {
  const boundary = renderRootBoundary();
  const knownSymlinks = new Set(entries.map((entry) => path.resolve(entry.symlink)));
  const linkRoots = new Set([
    activeCodexLinkRoot(),
    ...entries.map((entry) => path.resolve(entry.linkRoot))
  ]);

  const orphans: string[] = [];
  for (const linkRoot of linkRoots) {
    let dirents;
    try {
      dirents = await fs.readdir(linkRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isSymbolicLink()) continue;
      const linkPath = path.resolve(linkRoot, dirent.name);
      if (knownSymlinks.has(linkPath)) continue;
      let target: string;
      try {
        target = await fs.readlink(linkPath);
      } catch {
        continue;
      }
      const resolvedTarget = path.isAbsolute(target)
        ? path.resolve(target)
        : path.resolve(linkRoot, target);
      if (resolvedWithin(resolvedTarget, boundary)) {
        orphans.push(linkPath);
      }
    }
  }

  const unverifiable: string[] = [];
  for (const entry of entries) {
    if (!installedNames.has(entry.skill)) unverifiable.push(entry.skill);
  }

  orphans.sort();
  return { orphans, unverifiable: [...new Set(unverifiable)].sort() };
}
