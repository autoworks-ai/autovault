import { loadConfig } from "../config.js";
import {
  cleanIgnoredSkillArtifacts,
  ensureStorage,
  listIgnoredSkillArtifacts,
  listInstalledSkillNames,
  readSkillSourceStatus,
  recoverOrphanBackups,
  verifyInstalledIntegrity,
  type SkillIntegrityStatus,
  type SkillSourceStatus
} from "../storage/index.js";
import { ignoredArtifactNamesDescription } from "../util/ignored-artifacts.js";
import { assertSafeSkillName } from "../util/skill-name.js";

type DoctorOptions = {
  skill?: string;
  clean?: boolean;
  json?: boolean;
};

type DoctorSkillReport = {
  name: string;
  status: "ok" | "warning" | "error";
  ignored_artifacts: string[];
  cleaned: string[];
  integrity: SkillIntegrityStatus;
  source: SkillSourceStatus;
  actions: string[];
};

function usage(): never {
  process.stderr.write(`Usage:
  autovault doctor [skill-name] [--clean] [--json]
`);
  process.exit(1);
}

function parseOptions(args: string[]): DoctorOptions {
  let skill: string | undefined;
  let clean = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--clean") {
      clean = true;
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
  return { skill, clean, json };
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
  ignoredArtifacts: string[]
): "ok" | "warning" | "error" {
  if (integrity.kind === "tampered" || integrity.kind === "manifest_corrupt") return "error";
  if (source.kind === "tampered" || source.kind === "unparseable") return "error";
  if (integrity.kind === "no_manifest" || source.kind === "legacy" || source.kind === "absent") {
    return "warning";
  }
  if (ignoredArtifacts.length > 0) return "warning";
  return "ok";
}

async function inspectSkill(name: string, clean: boolean): Promise<DoctorSkillReport> {
  const before = await listIgnoredSkillArtifacts(name);
  const cleaned = clean && before.length > 0 ? await cleanIgnoredSkillArtifacts(name) : [];
  const ignoredArtifacts = clean ? await listIgnoredSkillArtifacts(name) : before;
  const integrity = await verifyInstalledIntegrity(name);
  const source = await readSkillSourceStatus(name);
  const actions = [
    ...integrityActions(integrity),
    ...sourceActions(source),
    ...(ignoredArtifacts.length > 0
      ? ["Run autovault doctor --clean to remove ignored OS/editor metadata."]
      : [])
  ];
  return {
    name,
    status: overallStatus(integrity, source, ignoredArtifacts),
    ignored_artifacts: ignoredArtifacts,
    cleaned,
    integrity,
    source,
    actions
  };
}

function formatReport(report: Awaited<ReturnType<typeof runDoctorReport>>): string {
  const lines: string[] = [];
  lines.push("AutoVault doctor");
  lines.push("================");
  lines.push(`storage: ${report.storagePath}`);
  lines.push(`ignored metadata allowlist: ${ignoredArtifactNamesDescription()}`);
  lines.push("");
  if (report.skills.length === 0) {
    lines.push("No installed skills found.");
    return `${lines.join("\n")}\n`;
  }
  for (const skill of report.skills) {
    lines.push(`${skill.status.toUpperCase()} ${skill.name}`);
    if (skill.cleaned.length > 0) {
      lines.push(`  cleaned: ${skill.cleaned.join(", ")}`);
    }
    if (skill.ignored_artifacts.length > 0) {
      lines.push(`  ignored artifacts: ${skill.ignored_artifacts.join(", ")}`);
    }
    if (skill.integrity.kind === "tampered") {
      const detail = skill.integrity.mismatches
        .map((m) => `${m.file} (${m.reason})`)
        .join(", ");
      lines.push(`  integrity: failed: ${detail}`);
    } else {
      lines.push(`  integrity: ${skill.integrity.kind}`);
    }
    lines.push(`  source: ${skill.source.kind}`);
    for (const action of skill.actions) lines.push(`  next: ${action}`);
    lines.push("");
  }
  lines.push(
    `summary: ${report.summary.ok} ok, ${report.summary.warnings} warning(s), ${report.summary.errors} error(s), ${report.summary.cleaned} cleaned artifact(s)`
  );
  return `${lines.join("\n")}\n`;
}

async function runDoctorReport(options: DoctorOptions) {
  await ensureStorage();
  await recoverOrphanBackups();
  const names = options.skill ? [options.skill] : await listInstalledSkillNames();
  const skills = [];
  for (const name of names) {
    skills.push(await inspectSkill(name, Boolean(options.clean)));
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
