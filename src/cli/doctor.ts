import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { collectLocalSkillBundle, LocalBundleLimitError } from "../installer/local.js";
import {
  cleanIgnoredSkillArtifacts,
  ensureStorage,
  listIgnoredSkillArtifacts,
  listInstalledSkillNames,
  readSkillSourceStatus,
  recoverOrphanBackups,
  skillDir,
  verifyInstalledIntegrity,
  writeSkill,
  type SkillIntegrityStatus,
  type SkillSource,
  type SkillSourceStatus
} from "../storage/index.js";
import {
  loadRenderIndex,
  sweepRenderOrphans,
  verifyRenderForSkill,
  type RenderFidelityStatus,
  type RenderIndexEntry
} from "../storage/render-index.js";
import { bundleHash } from "../util/hash.js";
import { ignoredArtifactNamesDescription } from "../util/ignored-artifacts.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { validateSkillInput } from "../validation/index.js";
import { withStorageLock } from "../storage/lock.js";
import { badge, sectionTitle } from "./ui/messages.js";
import { bulletList, keyValueRows } from "./ui/table.js";
import { makeTheme } from "./ui/theme.js";
import { writeJson } from "./ui/output.js";
import { scanPluginShadows, type PluginShadow } from "../doctor/plugin-shadows.js";

type DoctorOptions = {
  skill?: string;
  clean?: boolean;
  repair?: boolean;
  json?: boolean;
};

type DoctorRepairStatus = "not_requested" | "not_needed" | "repaired" | "refused" | "failed";

type DoctorRepairReport = {
  repaired: boolean;
  repair_status: DoctorRepairStatus;
  repair_reason: string;
};

type DoctorSkillReport = {
  name: string;
  status: "ok" | "warning" | "error";
  ignored_artifacts: string[];
  cleaned: string[];
  repaired: boolean;
  repair_status: DoctorRepairStatus;
  repair_reason: string;
  integrity: SkillIntegrityStatus;
  source: SkillSourceStatus;
  render: RenderFidelityStatus;
  plugin_shadows: PluginShadow[];
  actions: string[];
};

function usage(): never {
  process.stderr.write(`Usage:
  autovault doctor [skill-name] [--clean] [--repair] [--json]
`);
  process.exit(1);
}

function parseOptions(args: string[]): DoctorOptions {
  let skill: string | undefined;
  let clean = false;
  let repair = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--clean") {
      clean = true;
      continue;
    }
    if (arg === "--repair") {
      repair = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage();
    if (arg.startsWith("-")) usage();
    if (skill) usage();
    assertSafeSkillName(arg);
    skill = arg;
  }
  return { skill, clean, repair, json };
}

function sourceActions(status: SkillSourceStatus): string[] {
  switch (status.kind) {
    case "present":
      return [];
    case "legacy":
      return ["Reinstall the skill to migrate source metadata into the signed manifest."];
    case "tampered":
      return ["Reinstall the skill; source metadata does not match the signed manifest."];
    case "unparseable":
      return ["Reinstall the skill; source metadata is not valid JSON."];
    case "absent":
      return ["Reinstall or update the skill with source metadata if update checks should work."];
  }
}

function localSourceIdentifier(status: SkillSourceStatus): string | undefined {
  if (status.kind !== "present" && status.kind !== "legacy") return undefined;
  if (status.source.source !== "local") return undefined;
  if (status.source.identifier.startsWith("local:")) return undefined;
  return status.source.identifier;
}

function hasSignatureInvalidMismatch(status: SkillIntegrityStatus): boolean {
  return (
    status.kind === "tampered" &&
    status.mismatches.some((mismatch) => mismatch.reason === "signature_invalid")
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function sameFileIdentity(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

async function canonicalPath(value: string): Promise<string> {
  const unresolved: string[] = [];
  let candidate = path.resolve(value);
  while (true) {
    try {
      return path.join(await fs.realpath(candidate), ...unresolved);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(value);
      unresolved.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function isSelfReferentialVaultSource(sourcePath: string, name: string): Promise<boolean> {
  const vaultPath = skillDir(name);
  if (await sameFileIdentity(sourcePath, vaultPath)) return true;

  const skillsRoot = path.dirname(vaultPath);
  const [canonicalSourcePath, canonicalVaultPath, canonicalSkillsRoot] = await Promise.all([
    canonicalPath(sourcePath),
    canonicalPath(vaultPath),
    canonicalPath(skillsRoot)
  ]);
  return (
    isSameOrChildPath(path.resolve(sourcePath), path.resolve(vaultPath)) ||
    isSameOrChildPath(path.resolve(sourcePath), path.resolve(skillsRoot)) ||
    isSameOrChildPath(canonicalSourcePath, canonicalVaultPath) ||
    isSameOrChildPath(canonicalSourcePath, canonicalSkillsRoot)
  );
}

async function signatureInvalidGuidance(name: string, source: SkillSourceStatus): Promise<string> {
  const sourcePath = localSourceIdentifier(source);
  const sourceIsVault = sourcePath ? await isSelfReferentialVaultSource(sourcePath, name) : false;
  const sourceGuidance = sourcePath
    ? sourceIsVault
      ? [
          "The recorded local source is inside the vault, so it is not an editable upstream.",
          "To recover safely, copy the bundle to a working directory outside the vault, edit the copy, then run:",
          "  autovault add-local '<copied-bundle-path>' --sync-profiles"
        ].join("\n")
      : `Fix by editing the original source bundle and running:\n  autovault add-local ${shellQuote(sourcePath)} --sync-profiles`
    : "Fix by editing the original source bundle and reinstalling through autovault add-local.";
  return [
    "The vaulted copy was edited after signing. Do not edit ~/.autovault/skills directly.",
    sourceGuidance,
    "For intentional local vault edits only, run:",
    `  autovault doctor ${name} --repair`
  ].join("\n");
}

async function integrityActions(
  status: SkillIntegrityStatus,
  source: SkillSourceStatus,
  name: string
): Promise<string[]> {
  switch (status.kind) {
    case "ok":
      return [];
    case "no_manifest":
      return ["Reinstall the skill to create a signed manifest."];
    case "manifest_corrupt":
      return ["Reinstall the skill; the signed manifest is corrupt."];
    case "tampered":
      if (hasSignatureInvalidMismatch(status)) {
        return [await signatureInvalidGuidance(name, source)];
      }
      return [
        "Reinstall the skill or inspect the listed files; these are not ignored OS/editor metadata artifacts."
      ];
  }
}

function overallStatus(
  integrity: SkillIntegrityStatus,
  source: SkillSourceStatus,
  ignoredArtifacts: string[],
  repair: DoctorRepairReport,
  render: RenderFidelityStatus,
  pluginShadows: PluginShadow[]
): "ok" | "warning" | "error" {
  if (repair.repair_status === "failed" || repair.repair_status === "refused") return "error";
  if (render.kind === "error") return "error";
  if (integrity.kind === "tampered" || integrity.kind === "manifest_corrupt") return "error";
  if (source.kind === "tampered" || source.kind === "unparseable") return "error";
  if (integrity.kind === "no_manifest" || source.kind === "legacy" || source.kind === "absent") {
    return "warning";
  }
  if (pluginShadows.length > 0) return "warning";
  if (ignoredArtifacts.length > 0) return "warning";
  return "ok";
}

const repairNotRequested: DoctorRepairReport = {
  repaired: false,
  repair_status: "not_requested",
  repair_reason: "Repair not requested."
};

function repairNotNeeded(): DoctorRepairReport {
  return {
    repaired: false,
    repair_status: "not_needed",
    repair_reason: "Installed skill already has valid signed integrity and source metadata."
  };
}

function repairRefused(reason: string): DoctorRepairReport {
  return { repaired: false, repair_status: "refused", repair_reason: reason };
}

function repairFailed(reason: string): DoctorRepairReport {
  return { repaired: false, repair_status: "failed", repair_reason: reason };
}

async function repairSkillInstall(
  name: string,
  integrity: SkillIntegrityStatus,
  sourceStatus: SkillSourceStatus
): Promise<DoctorRepairReport> {
  if (integrity.kind === "ok" && sourceStatus.kind === "present") return repairNotNeeded();

  let identifier: string;
  if (sourceStatus.kind === "present" || sourceStatus.kind === "legacy") {
    const source = sourceStatus.source;
    if (source.source !== "local") {
      return repairRefused(
        `Refusing to repair skill with remote source '${source.source}'; reinstall or update from upstream.`
      );
    }
    identifier = source.identifier;
  } else if (sourceStatus.kind === "absent") {
    identifier = `local:${name}`;
  } else if (sourceStatus.kind === "tampered") {
    return repairRefused("Refusing to repair because source metadata is tampered; reinstall the skill.");
  } else {
    return repairRefused("Refusing to repair because source metadata is not valid JSON; reinstall the skill.");
  }

  let bundle: Awaited<ReturnType<typeof collectLocalSkillBundle>>;
  try {
    bundle = await withStorageLock(() => collectLocalSkillBundle(skillDir(name)));
  } catch (error) {
    if (error instanceof LocalBundleLimitError) {
      return repairRefused(`Bundle validation failed: ${error.errors.join("; ")}`);
    }
    return repairFailed(`Could not collect current skill bundle: ${String(error)}`);
  }

  const { output: normalizedSkillMd } = attemptRepair(bundle.skillMd);
  const resources = bundle.resources.map((resource) => ({
    path: resource.path,
    content: resource.content
  }));
  const validation = validateSkillInput(normalizedSkillMd, resources);
  if (!validation.valid) {
    return repairRefused(`Bundle validation failed: ${validation.errors.join("; ")}`);
  }

  let parsedName: string;
  try {
    const { data } = parseFrontmatter(normalizedSkillMd);
    parsedName = typeof data.name === "string" ? data.name : "";
  } catch (error) {
    return repairRefused(`Bundle validation failed: could not parse frontmatter: ${String(error)}`);
  }
  if (parsedName !== name) {
    return repairRefused(
      `Bundle validation failed: SKILL.md declares '${parsedName || "(missing)"}' but directory is '${name}'.`
    );
  }

  const source: SkillSource = {
    source: "local",
    identifier,
    fetchedAt: new Date().toISOString(),
    contentHash: bundleHash(normalizedSkillMd, resources)
  };
  await writeSkill(name, normalizedSkillMd, resources, source);
  return {
    repaired: true,
    repair_status: "repaired",
    repair_reason: `Re-signed current local bundle with source '${identifier}'.`
  };
}

async function inspectSkill(
  name: string,
  clean: boolean,
  repair: boolean,
  renderEntries: RenderIndexEntry[],
  pluginShadows: PluginShadow[]
): Promise<DoctorSkillReport> {
  const before = await listIgnoredSkillArtifacts(name);
  const cleaned = clean && before.length > 0 ? await cleanIgnoredSkillArtifacts(name) : [];
  let integrity = await verifyInstalledIntegrity(name);
  let source = await readSkillSourceStatus(name);
  const repairReport = repair
    ? await repairSkillInstall(name, integrity, source)
    : repairNotRequested;
  if (repairReport.repaired) {
    integrity = await verifyInstalledIntegrity(name);
    source = await readSkillSourceStatus(name);
  }
  // Render fidelity is verified AFTER any repair so a re-signed bundle is
  // re-checked against the recorded render hashes, not the pre-repair state.
  const render = await verifyRenderForSkill(name, renderEntries);
  const ignoredArtifacts = clean ? await listIgnoredSkillArtifacts(name) : before;
  const actions = [
    ...(await integrityActions(integrity, source, name)),
    ...sourceActions(source),
    ...(render.kind === "error" ? render.problems : []),
    ...(pluginShadows.length > 0
      ? [
          "skillOverrides cannot suppress plugin skills. Manage the conflicting plugin in Cursor or Claude Code if the vaulted copy should be authoritative; AutoVault reports these collisions but does not uninstall host plugins."
        ]
      : []),
    ...(repairReport.repair_status === "refused" || repairReport.repair_status === "failed"
      ? [repairReport.repair_reason]
      : []),
    ...(ignoredArtifacts.length > 0
      ? ["Run autovault doctor --clean to remove ignored OS/editor metadata."]
      : [])
  ];
  return {
    name,
    status: overallStatus(
      integrity,
      source,
      ignoredArtifacts,
      repairReport,
      render,
      pluginShadows
    ),
    ignored_artifacts: ignoredArtifacts,
    cleaned,
    ...repairReport,
    integrity,
    source,
    render,
    plugin_shadows: pluginShadows,
    actions
  };
}

function formatReport(report: Awaited<ReturnType<typeof runDoctorReport>>): string {
  const theme = makeTheme(process.stdout);
  const lines: string[] = [];
  lines.push("");
  lines.push(`${badge("doctor", theme)} ${theme.style.bold("AutoVault trust dashboard")}`);
  lines.push(sectionTitle("Vault health", theme));
  lines.push(
    keyValueRows(
      [
        { label: "storage", value: theme.style.dim(report.storagePath), status: "muted" },
        {
          label: "summary",
          value: `${report.summary.ok} ok, ${report.summary.warnings} warning(s), ${report.summary.errors} error(s)`,
          status:
            report.summary.errors > 0
              ? "error"
              : report.summary.warnings > 0
                ? "warn"
                : "ok"
        },
        {
          label: "cleaned",
          value: `${report.summary.cleaned} artifact(s)`,
          status: report.summary.cleaned > 0 ? "ok" : "muted"
        },
        ...(report.summary.plugin_shadowed > 0
          ? [
              {
                label: "plugin shadows",
                value: `${report.summary.plugin_shadowed} skill(s)`,
                status: "warn" as const
              }
            ]
          : []),
        {
          label: "allowlist",
          value: ignoredArtifactNamesDescription(),
          status: "muted"
        }
      ],
      theme
    )
  );
  lines.push("");

  // Report-level render state: a corrupt index, dangling orphan symlinks, or
  // render entries owned by an uninstalled skill. Rendered ABOVE the skill list
  // and the no-skills bailout so an orphan survives even after every skill is
  // gone.
  if (
    report.render.index === "corrupt" ||
    report.render.orphans.length > 0 ||
    report.render.unverifiable.length > 0
  ) {
    lines.push(sectionTitle("Render state", theme));
    if (report.render.index === "corrupt") {
      lines.push(
        `  ${theme.style.red("index")} corrupt: ${report.render.corruptReason ?? "unparseable render index"}`
      );
    }
    if (report.render.orphans.length > 0) {
      lines.push(
        `  ${theme.style.red("orphan symlinks")} ${report.render.orphans.join(", ")}`
      );
    }
    if (report.render.unverifiable.length > 0) {
      lines.push(
        `  ${theme.style.red("unverifiable")} render entries for uninstalled skill(s): ${report.render.unverifiable.join(", ")}`
      );
    }
    lines.push("");
  }

  if (report.skills.length === 0) {
    lines.push(`${theme.style.dim("No installed skills found.")}`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(sectionTitle("Skill integrity", theme));
  for (const skill of report.skills) {
    const statusTone =
      skill.status === "ok" ? "ok" : skill.status === "warning" ? "warn" : "error";
    const mark =
      skill.status === "ok"
        ? theme.style.green(theme.symbol.check)
        : skill.status === "warning"
          ? theme.style.yellow(theme.symbol.warn)
          : theme.style.red(theme.symbol.cross);
    lines.push(`${mark} ${theme.style.bold(skill.name)} ${theme.style.dim(skill.status)}`);
    if (skill.cleaned.length > 0) {
      lines.push(`  ${theme.style.green("cleaned")} ${skill.cleaned.join(", ")}`);
    }
    if (skill.ignored_artifacts.length > 0) {
      lines.push(
        `  ${theme.style.yellow("ignored metadata")} ${skill.ignored_artifacts.join(", ")}`
      );
    }
    if (skill.repair_status !== "not_requested" && skill.repair_status !== "not_needed") {
      const repairTone =
        skill.repair_status === "repaired"
          ? theme.style.green("repair")
          : theme.style.red("repair");
      lines.push(`  ${repairTone} ${skill.repair_status}: ${skill.repair_reason}`);
    }
    if (skill.integrity.kind === "tampered") {
      const detail = skill.integrity.mismatches
        .map((m) => `${m.file} (${m.reason})`)
        .join(", ");
      lines.push(`  ${theme.style.red("integrity")} failed: ${detail}`);
    } else {
      lines.push(`  ${theme.style.dim("integrity")} ${skill.integrity.kind}`);
    }
    lines.push(`  ${theme.style.dim("source")} ${skill.source.kind}`);
    for (const shadow of skill.plugin_shadows) {
      lines.push(
        `  ${theme.style.yellow("plugin shadowed")} ${shadow.host}: ${shadow.plugin} (${shadow.skill_md_path})`
      );
    }
    // Render fidelity: only surface when the skill has rendered state on this
    // machine. `skipped` (never rendered here — the default for the bundled
    // demos) prints nothing, keeping the dashboard clean.
    if (skill.render.kind === "error") {
      lines.push(`  ${theme.style.red("render")} failed: ${skill.render.problems.join("; ")}`);
    } else if (skill.render.kind === "ok") {
      lines.push(
        `  ${theme.style.dim("render")} ok (${skill.render.entries} bundle${
          skill.render.entries === 1 ? "" : "s"
        })`
      );
    }
    if (statusTone !== "ok" && skill.actions.length > 0) {
      lines.push(bulletList(skill.actions.map((action) => `next: ${action}`), theme));
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function runDoctorReport(options: DoctorOptions) {
  await ensureStorage();
  await recoverOrphanBackups();

  // Load the machine-local render index once. A corrupt index is a report-level
  // error surfaced regardless of scope; entries drive the per-skill render check.
  const indexLoad = await loadRenderIndex();
  const renderEntries = indexLoad.kind === "ok" ? indexLoad.entries : [];

  const installedNames = await listInstalledSkillNames();
  const names = options.skill ? [options.skill] : installedNames;
  const pluginShadows = await scanPluginShadows(installedNames);
  const skills = [];
  for (const name of names) {
    skills.push(
      await inspectSkill(
        name,
        Boolean(options.clean),
        Boolean(options.repair),
        renderEntries,
        pluginShadows[name] ?? []
      )
    );
  }

  // Full runs scan the active Codex automation root plus every recorded link
  // root. Scanning the active root even when the index is absent catches a
  // live AutoVault symlink whose sole index entry was deleted.
  const sweep =
    !options.skill
      ? await sweepRenderOrphans(renderEntries, new Set(names))
      : { orphans: [], unverifiable: [] };

  const render = {
    index: indexLoad.kind,
    corruptReason: indexLoad.kind === "corrupt" ? indexLoad.reason : undefined,
    orphans: sweep.orphans,
    unverifiable: sweep.unverifiable
  };

  // Report-level render errors live outside any single skill's status, so fold
  // them into the error count that drives the exit code.
  const reportLevelRenderErrors =
    (indexLoad.kind === "corrupt" ? 1 : 0) + sweep.orphans.length + sweep.unverifiable.length;

  const summary = {
    ok: skills.filter((skill) => skill.status === "ok").length,
    warnings: skills.filter((skill) => skill.status === "warning").length,
    errors:
      skills.filter((skill) => skill.status === "error").length + reportLevelRenderErrors,
    plugin_shadowed: skills.filter((skill) => skill.plugin_shadows.length > 0).length,
    ignored_artifacts: skills.reduce((sum, skill) => sum + skill.ignored_artifacts.length, 0),
    cleaned: skills.reduce((sum, skill) => sum + skill.cleaned.length, 0)
  };
  return {
    storagePath: loadConfig().storagePath,
    checked: names,
    cleaned: Boolean(options.clean),
    summary,
    render,
    skills
  };
}

export async function runDoctorCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const report = await runDoctorReport(options);
  if (options.json) {
    writeJson(report);
  } else {
    process.stdout.write(formatReport(report));
  }
  if (report.summary.errors > 0) process.exit(1);
}
