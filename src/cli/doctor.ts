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
import { bundleHash } from "../util/hash.js";
import { ignoredArtifactNamesDescription } from "../util/ignored-artifacts.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { validateSkillInput } from "../validation/index.js";
import { withStorageLock } from "../storage/lock.js";
import { badge, sectionTitle } from "./ui/messages.js";
import { bulletList, keyValueRows } from "./ui/table.js";
import { makeTheme } from "./ui/theme.js";

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

function integrityActions(status: SkillIntegrityStatus): string[] {
  switch (status.kind) {
    case "ok":
      return [];
    case "no_manifest":
      return ["Reinstall the skill to create a signed manifest."];
    case "manifest_corrupt":
      return ["Reinstall the skill; the signed manifest is corrupt."];
    case "tampered":
      return [
        "Reinstall the skill or inspect the listed files; these are not ignored OS/editor metadata artifacts."
      ];
  }
}

function overallStatus(
  integrity: SkillIntegrityStatus,
  source: SkillSourceStatus,
  ignoredArtifacts: string[],
  repair: DoctorRepairReport
): "ok" | "warning" | "error" {
  if (repair.repair_status === "failed" || repair.repair_status === "refused") return "error";
  if (integrity.kind === "tampered" || integrity.kind === "manifest_corrupt") return "error";
  if (source.kind === "tampered" || source.kind === "unparseable") return "error";
  if (integrity.kind === "no_manifest" || source.kind === "legacy" || source.kind === "absent") {
    return "warning";
  }
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

async function inspectSkill(name: string, clean: boolean, repair: boolean): Promise<DoctorSkillReport> {
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
  const ignoredArtifacts = clean ? await listIgnoredSkillArtifacts(name) : before;
  const actions = [
    ...integrityActions(integrity),
    ...sourceActions(source),
    ...(repairReport.repair_status === "refused" || repairReport.repair_status === "failed"
      ? [repairReport.repair_reason]
      : []),
    ...(ignoredArtifacts.length > 0
      ? ["Run autovault doctor --clean to remove ignored OS/editor metadata."]
      : [])
  ];
  return {
    name,
    status: overallStatus(integrity, source, ignoredArtifacts, repairReport),
    ignored_artifacts: ignoredArtifacts,
    cleaned,
    ...repairReport,
    integrity,
    source,
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
    if (statusTone !== "ok" && skill.actions.length > 0) {
      lines.push(bulletList(skill.actions.map((action) => `next: ${action}`), theme));
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function runDoctorReport(options: DoctorOptions) {
  await ensureStorage();
  await recoverOrphanBackups();
  const names = options.skill ? [options.skill] : await listInstalledSkillNames();
  const skills = [];
  for (const name of names) {
    skills.push(await inspectSkill(name, Boolean(options.clean), Boolean(options.repair)));
  }
  const summary = {
    ok: skills.filter((skill) => skill.status === "ok").length,
    warnings: skills.filter((skill) => skill.status === "warning").length,
    errors: skills.filter((skill) => skill.status === "error").length,
    ignored_artifacts: skills.reduce((sum, skill) => sum + skill.ignored_artifacts.length, 0),
    cleaned: skills.reduce((sum, skill) => sum + skill.cleaned.length, 0)
  };
  return {
    storagePath: loadConfig().storagePath,
    checked: names,
    cleaned: Boolean(options.clean),
    summary,
    skills
  };
}

export async function runDoctorCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const report = await runDoctorReport(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report));
  }
  if (report.summary.errors > 0) process.exit(1);
}
