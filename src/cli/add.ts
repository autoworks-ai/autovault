import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { renderSuccessOutro } from "./ui/brand.js";
import { badge, sectionTitle } from "./ui/messages.js";
import { bulletList, keyValueRows } from "./ui/table.js";
import { makeTheme } from "./ui/theme.js";
import { formatJson, joinCliList } from "./ui/output.js";
import { ask, askMultiSelect, confirm, isTtyAvailable } from "./setup/prompt.js";
import { startSpinner } from "./ui/tasks.js";
import { loadConfig } from "../config.js";
import {
  addLocalSkill,
  buildLocalRepairProposal,
  collectLocalSkillBundle,
  previewSkillFrontmatter,
  type AddLocalSkillInput,
  type AddLocalSkillResult,
  type LocalRepairField
} from "../installer/local.js";
import { addSkill, type AddSkillInput } from "../tools/add-skill.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { synthesizeSkillFrontmatter } from "../validation/frontmatter-synthesis.js";
import { validateSkillInput } from "../validation/index.js";
import { withSuppressedLogs } from "../util/log.js";

type AddSource = "github" | "agentskills" | "url" | "local";

type WritableLike = {
  write(chunk: string): unknown;
};

type AddCommandIO = {
  stdout?: WritableLike;
  stderr?: WritableLike;
  exit?: (code: number) => void;
};

type AddCommandDeps = {
  addSkill?: typeof addSkill;
};

type AddCommandRuntimeOptions = {
  commandName?: "add" | "add-local";
  localOnly?: boolean;
  legacyLocalSourceFlag?: boolean;
  verboseResult?: boolean;
};

type AddCommandOptions = {
  target: string;
  source?: AddSource;
  provenance?: string;
  version?: string;
  syncProfiles?: boolean;
  discoverProfileRoots?: boolean;
  json: boolean;
  dryRun: boolean;
  yes: boolean;
  quiet: boolean;
  verbose: boolean;
  targetAgents: string[];
  profileRoots: Record<string, string>;
};

type AddCommandPlan = {
  source: AddSource;
  identifier?: string;
  skillDir?: string;
};

type AddPlanSummary = {
  source: AddSource;
  target: string;
  identifier?: string;
  skillDir?: string;
  version?: string;
  syncProfiles: boolean;
  discoverProfileRoots: boolean;
  targetAgents: string[];
  profileRoots: Record<string, string>;
  storagePath: string;
};

type AddLocalPreflight = {
  name: string;
  bundleRoot: string;
  validation: ReturnType<typeof validateSkillInput>;
  warnings: string[];
  repair?: AddLocalSkillResult["repair"];
};

type AddPreviewResult = {
  success: boolean;
  dryRun: boolean;
  wouldWrite: boolean;
  needsConfirmation?: boolean;
  plan: AddPlanSummary;
  preflight?: AddLocalPreflight;
  warnings: string[];
  message?: string;
};

export type AddCommandOutcome = {
  mutated: boolean;
  shouldWriteUpdateNotice: boolean;
};

const SOURCE_VALUES = new Set<AddSource>(["github", "agentskills", "url", "local"]);

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function parseProfileLink(value: string | undefined, commandName: string): [string, string] {
  if (!value || !value.includes("=")) {
    throw new Error(`autovault ${commandName} --link requires agent=/path`);
  }
  const [agent, root] = value.split("=", 2);
  if (!agent || !root) throw new Error(`autovault ${commandName} --link requires agent=/path`);
  return [agent, root];
}

function exit(io: AddCommandIO, code: number): never {
  if (io.exit) io.exit(code);
  else process.exit(code);
  throw new Error(`exit ${code}`);
}

function fail(io: AddCommandIO, message: string, code = 2): never {
  (io.stderr ?? process.stderr).write(`${message}\n`);
  return exit(io, code);
}

function sourceFromFlag(value: string | undefined, io: AddCommandIO): AddSource {
  if (!value) fail(io, "autovault add --source requires github, agentskills, url, or local.");
  if (!SOURCE_VALUES.has(value as AddSource)) {
    fail(io, `Unknown autovault add source: ${value}`);
  }
  return value as AddSource;
}

function parseArgs(
  args: string[],
  io: AddCommandIO,
  runtime: AddCommandRuntimeOptions = {}
): AddCommandOptions {
  const commandName = runtime.commandName ?? "add";
  let target: string | undefined;
  let source: AddSource | undefined;
  let provenance: string | undefined;
  let version: string | undefined;
  let syncProfiles: boolean | undefined;
  let discoverProfileRoots: boolean | undefined;
  let dryRun = false;
  let yes = false;
  let quiet = false;
  let verbose = false;
  const targetAgents: string[] = [];
  const profileRoots: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--source") {
      const value = args[i + 1];
      if (!value) {
        fail(
          io,
          runtime.legacyLocalSourceFlag
            ? "autovault add-local --source requires a provenance value."
            : "autovault add --source requires github, agentskills, url, or local."
        );
      }
      if (runtime.legacyLocalSourceFlag) {
        provenance = value;
      } else {
        source = sourceFromFlag(value, io);
      }
      i += 1;
      continue;
    }
    if (arg === "--provenance") {
      provenance = args[i + 1];
      if (!provenance) fail(io, "autovault add --provenance requires a value.");
      i += 1;
      continue;
    }
    if (arg === "--version") {
      version = args[i + 1];
      if (!version) fail(io, `autovault ${commandName} --version requires a value.`);
      i += 1;
      continue;
    }
    if (arg === "--link") {
      try {
        const [agent, root] = parseProfileLink(args[i + 1], commandName);
        profileRoots[agent] = root;
      } catch (error) {
        fail(io, String((error as Error).message ?? error));
      }
      i += 1;
      continue;
    }
    if (arg === "--agent") {
      const value = args[i + 1];
      if (!value) fail(io, `autovault ${commandName} --agent requires a value.`);
      targetAgents.push(value);
      i += 1;
      continue;
    }
    if (arg === "--sync-profiles") {
      syncProfiles = true;
      continue;
    }
    if (arg === "--no-sync-profiles") {
      syncProfiles = false;
      continue;
    }
    if (arg === "--discover") {
      discoverProfileRoots = true;
      continue;
    }
    if (arg === "--no-discover") {
      discoverProfileRoots = false;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--json") continue;
    if (arg.startsWith("-")) fail(io, `Unknown autovault ${commandName} flag: ${arg}`);
    if (target) {
      fail(
        io,
        runtime.localOnly
          ? "autovault add-local accepts one local skill directory or SKILL.md path."
          : "autovault add accepts one source identifier or local path."
      );
    }
    target = arg;
  }

  if (!target) {
    fail(
      io,
      runtime.localOnly
        ? "autovault add-local requires a local skill directory or SKILL.md path."
        : "autovault add requires a source identifier or local path."
    );
  }

  if (runtime.localOnly && source && source !== "local") {
    fail(io, "autovault add-local only accepts local skill directories or SKILL.md paths.");
  }

  return {
    target,
    source: runtime.localOnly ? "local" : source,
    provenance,
    version,
    syncProfiles,
    discoverProfileRoots,
    json: hasFlag(args, "--json"),
    dryRun,
    yes,
    quiet,
    verbose,
    targetAgents,
    profileRoots
  };
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.lstat(path.resolve(expandHome(inputPath)));
    return true;
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function looksLikeCompactGitHubIdentifier(value: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return false;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@[^:]+)?(?::.+)?$/.test(value);
}

async function planAdd(options: AddCommandOptions): Promise<AddCommandPlan> {
  if (options.source === "local") return { source: "local", skillDir: options.target };
  if (options.source) {
    return { source: options.source, identifier: options.target };
  }

  if (await pathExists(options.target)) {
    return { source: "local", skillDir: options.target };
  }

  const url = isHttpsUrl(options.target);
  if (url) {
    return {
      source: url.hostname === "github.com" ? "github" : "url",
      identifier: options.target
    };
  }

  if (looksLikeCompactGitHubIdentifier(options.target)) {
    return { source: "github", identifier: options.target };
  }

  return { source: "agentskills", identifier: options.target };
}

function hostRestartGuidance(): string[] {
  return [
    "restart Claude Code, Codex, or Cursor if they cache filesystem skills",
    "verify from the host by loading the autovault-skill skill"
  ];
}

function formatRepairField(field: LocalRepairField): string {
  const suggested = Array.isArray(field.suggested)
    ? field.suggested.join(", ")
    : field.suggested;
  return suggested ? `${field.path}: ${field.reason} (suggested ${suggested})` : `${field.path}: ${field.reason}`;
}

function syncProfileCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" ? value : 0;
}

function formatAddLocalResult(
  result: AddLocalSkillResult,
  skillDir: string,
  stream: NodeJS.WriteStream
): string {
  const theme = makeTheme(stream);
  const lines: string[] = [];
  lines.push("");
  lines.push(`${badge("vault", theme)} ${theme.style.bold("AutoVault local installer")}`);
  lines.push(sectionTitle(result.success ? "Admission receipt" : "Admission blocked", theme));
  lines.push(
    keyValueRows(
      [
        { label: "scan", value: skillDir, status: "muted" },
        {
          label: "validate",
          value: result.validation.valid ? "passed" : "failed",
          status: result.validation.valid ? "ok" : "error"
        }
      ],
      theme
    )
  );
  if (result.success) {
    lines.push(
      keyValueRows(
        [
          { label: "sign", value: result.name, status: "ok" },
          ...(result.paths ? [{ label: "storage", value: result.paths.skill, status: "ok" as const }] : []),
          ...(result.source
            ? [
                {
                  label: "source",
                  value: result.sourceInferred
                    ? `${result.source.identifier} (inferred)`
                    : result.source.identifier,
                  status: "muted" as const
                }
              ]
            : []),
          ...(result.inferredAgents && result.inferredAgents.length > 0
            ? [
                {
                  label: "agents",
                  value: `${result.inferredAgents.join(", ")} (${result.agentInferenceReason ?? "inferred"})`,
                  status: "muted" as const
                }
              ]
            : [])
        ],
        theme
      )
    );
    if (result.sync) {
      lines.push("");
      lines.push(`${badge("sync", theme, "dim")} profile sync`);
      const linkedEntries = Object.entries(result.sync.linkedRoots);
      if (linkedEntries.length === 0) {
        lines.push(`  ${theme.style.dim("No external profile roots linked.")}`);
      } else {
        for (const [agent, root] of linkedEntries) {
          const count = syncProfileCount((result.sync.profiles as Record<string, unknown>)[agent]);
          lines.push(
            `  ${theme.style.green(theme.symbol.check)} ${agent} ${theme.style.dim(root)} (${count} skill${count === 1 ? "" : "s"})`
          );
        }
      }
    }
    if (result.warnings.length > 0) {
      lines.push("");
      lines.push(`${badge("warn", theme, "warn")} warnings`);
      lines.push(bulletList(result.warnings, theme));
    }
    lines.push(
      renderSuccessOutro(
        "Skill vaulted",
        hostRestartGuidance().map((line) => `${theme.style.dim("next")} ${line}`),
        stream
      ).trimEnd()
    );
  } else {
    lines.push("");
    lines.push(`${badge("error", theme, "warn")} errors`);
    lines.push(bulletList([...result.validation.errors, ...result.warnings], theme));
    if (result.repair?.available) {
      lines.push("");
      lines.push(`${badge("repair", theme, "dim")} repair available`);
      lines.push(bulletList(result.repair.fields.map(formatRepairField), theme));
      if (result.repair.fields.some((field) => field.path === "agents")) {
        lines.push(`  ${theme.style.dim("agents")} ${joinCliList(result.repair.suggestedAgents)}`);
      }
    } else if (result.repair) {
      lines.push("");
      lines.push(`${badge("repair", theme, "dim")} repair unavailable: ${result.repair.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function stringWarnings(result: Record<string, unknown>): string[] {
  return Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
}

function stringArrayFromValidation(
  result: Record<string, unknown>,
  key: "errors" | "warnings" | "securityFlags"
): string[] {
  const validation = result.validation;
  if (typeof validation !== "object" || validation === null) return [];
  const value = (validation as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function validationPassed(result: Record<string, unknown>): boolean {
  const validation = result.validation;
  return (
    typeof validation === "object" &&
    validation !== null &&
    (validation as { valid?: unknown }).valid === true
  );
}

function sourceIdentifier(result: Record<string, unknown>): string | undefined {
  const source = result.source;
  if (typeof source !== "object" || source === null) return undefined;
  const identifier = (source as { identifier?: unknown }).identifier;
  return typeof identifier === "string" ? identifier : undefined;
}

function resultOutcome(result: Record<string, unknown>): string | undefined {
  return typeof result.outcome === "string" ? result.outcome : undefined;
}

function isTargetAgentsRequired(result: Record<string, unknown>): boolean {
  return resultOutcome(result) === "target_agents_required";
}

function sourceArgsForRecovery(options: AddCommandOptions, plan: AddCommandPlan): string[] {
  return options.source ? ["--source", plan.source] : [];
}

function targetAgentsRecoveryCommands(options: AddCommandOptions, plan: AddCommandPlan): string[] {
  const base = ["autovault", "add", options.target, ...sourceArgsForRecovery(options, plan)];
  return [
    [...base, "--agent", "codex", "--yes"],
    [...base, "--no-sync-profiles", "--yes"]
  ].map((parts) => parts.map(shellQuote).join(" "));
}

function formatAddResult(
  result: Record<string, unknown>,
  plan: AddCommandPlan,
  options: AddCommandOptions,
  stream: NodeJS.WriteStream
): string {
  if (plan.source === "local") {
    return formatAddLocalResult(result as AddLocalSkillResult, options.target, stream);
  }

  const theme = makeTheme(stream);
  const success = result.success === true;
  const name = typeof result.name === "string" ? result.name : "";
  const warnings = stringWarnings(result);
  const lines: string[] = [];
  lines.push("");
  lines.push(`${badge("vault", theme)} ${theme.style.bold("AutoVault skill adder")}`);
  lines.push(sectionTitle(success ? "Admission receipt" : "Admission blocked", theme));
  lines.push(
    keyValueRows(
      [
        { label: "kind", value: plan.source, status: "muted" },
        {
          label: "validate",
          value: validationPassed(result) ? "passed" : "failed",
          status: validationPassed(result) ? "ok" : "error"
        },
        ...(success ? [{ label: "install", value: name, status: "ok" as const }] : []),
        ...(resultOutcome(result)
          ? [
              {
                label: "outcome",
                value: resultOutcome(result)!.replace(/_/g, " "),
                status: success ? "muted" as const : "warn" as const
              }
            ]
          : []),
        {
          label: "source",
          value: sourceIdentifier(result) ?? plan.identifier ?? options.target,
          status: "muted"
        }
      ],
      theme
    )
  );
  if (warnings.length > 0) {
    lines.push("");
    lines.push(`${badge(success ? "warn" : "error", theme, success ? "warn" : "warn")} ${success ? "warnings" : "errors"}`);
    lines.push(bulletList(warnings, theme));
  }
  if (!success) {
    const validationDetails = [
      ...stringArrayFromValidation(result, "errors"),
      ...stringArrayFromValidation(result, "securityFlags").map((flag) => `Security flag: ${flag}`),
      ...stringArrayFromValidation(result, "warnings")
    ];
    if (validationDetails.length > 0 || warnings.length === 0) {
      lines.push("");
      lines.push(`${badge("error", theme, "warn")} validation`);
      lines.push(bulletList(validationDetails.length > 0 ? validationDetails : ["No validation details returned."], theme));
    }
    if (isTargetAgentsRequired(result)) {
      lines.push("");
      lines.push(`${badge("next", theme, "dim")} recovery`);
      lines.push(bulletList(targetAgentsRecoveryCommands(options, plan), theme));
    }
  }
  if (success) {
    lines.push(
      renderSuccessOutro(
        "Skill vaulted",
        hostRestartGuidance().map((line) => `${theme.style.dim("next")} ${line}`),
        stream
      ).trimEnd()
    );
  }
  return `${lines.join("\n")}\n`;
}

function canPrompt(
  options: AddCommandOptions,
  result: AddLocalSkillResult
): boolean {
  if (options.json) return false;
  if (options.quiet) return false;
  if (process.env.CI === "true" || process.env.CI === "1") return false;
  return Boolean(result.repair?.available && isTtyAvailable());
}

function suggested(field: LocalRepairField): string | undefined {
  return typeof field.suggested === "string" ? field.suggested : undefined;
}

async function repairedSkillMdFor(
  options: AddCommandOptions,
  result: AddLocalSkillResult
): Promise<string> {
  if (!result.repair?.available) throw new Error("No local repair proposal available.");
  const bundle = await collectLocalSkillBundle(options.target);
  const { output: normalizedSkillMd } = attemptRepair(bundle.skillMd);
  const parsed = parseFrontmatter(normalizedSkillMd);
  const field = (fieldPath: LocalRepairField["path"]) =>
    result.repair?.available ? result.repair.fields.find((item) => item.path === fieldPath) : undefined;

  const agentsField = field("agents");
  const agents = agentsField
    ? await askMultiSelect(
        "Select agents for this skill",
        result.repair.agentChoices.map((agent) => ({
          label: agent,
          value: agent,
          hint: result.repair?.profileContext.some((item) => item.agent === agent && item.matched)
            ? "detected from source path/profile roots"
            : undefined
        })),
        {
          initialValues: result.repair.suggestedAgents,
          required: true
        }
      )
    : undefined;

  const nameField = field("name");
  const name =
    nameField !== undefined
      ? (await ask(`Skill name (${suggested(nameField) ?? "required"})`)) || suggested(nameField)
      : undefined;

  const descriptionField = field("description");
  const description =
    descriptionField !== undefined
      ? (await ask("Skill description (20+ chars)")) ||
        (typeof parsed.data.description === "string" ? parsed.data.description : undefined)
      : undefined;

  const versionField = field("metadata.version");
  const resourcesField = field("resources");
  return synthesizeSkillFrontmatter(normalizedSkillMd, {
    agents,
    replaceEmptyAgents: true,
    name,
    description,
    metadataVersion: suggested(versionField ?? { path: "metadata.version", reason: "defaulted", suggested: "1.0.0" }),
    resources: resourcesField ? bundle.resources : undefined,
    appendMissingResources: resourcesField !== undefined
  }).skillMd;
}

async function runInteractiveRepair(
  options: AddCommandOptions,
  input: AddLocalSkillInput,
  result: AddLocalSkillResult,
  stream: NodeJS.WriteStream
): Promise<AddLocalSkillResult> {
  if (!result.repair?.available) return result;
  const repairedSkillMd = await repairedSkillMdFor(options, result);
  stream.write("\nRepaired frontmatter preview:\n");
  stream.write(`${previewSkillFrontmatter(repairedSkillMd)}\n`);
  const writeBack =
    result.repair.canWriteBack &&
    (await confirm("Write repaired frontmatter back to the source bundle?", true));
  if (writeBack) {
    await fs.writeFile(result.repair.sourcePath, repairedSkillMd, "utf-8");
  }
  return withSuppressedLogs(() =>
    addLocalSkill({
      ...input,
      skillMdOverride: writeBack ? undefined : repairedSkillMd
    })
  );
}

function profileRootsOrUndefined(profileRoots: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(profileRoots).length > 0 ? profileRoots : undefined;
}

function defaultSyncProfiles(source: AddSource, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return source !== "local";
}

function defaultDiscoverProfiles(source: AddSource, sync: boolean, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return source === "local" ? sync : false;
}

function planSummaryFor(
  options: AddCommandOptions,
  plan: AddCommandPlan,
  input: AddSkillInput
): AddPlanSummary {
  return {
    source: plan.source,
    target: options.target,
    ...(plan.identifier ? { identifier: plan.identifier } : {}),
    ...(plan.skillDir ? { skillDir: plan.skillDir } : {}),
    ...(options.version ? { version: options.version } : {}),
    syncProfiles: input.sync_profiles === true,
    discoverProfileRoots: input.discover_profile_roots === true,
    targetAgents: [...options.targetAgents],
    profileRoots: { ...options.profileRoots },
    storagePath: loadConfig().storagePath
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function suggestedYesCommand(commandName: string, args: string[]): string {
  const filtered = args.filter((arg) => arg !== "--dry-run" && arg !== "--yes" && arg !== "-y");
  return [`autovault`, commandName, ...filtered, "--yes"].map(shellQuote).join(" ");
}

function canUseInteractivePrompts(options: AddCommandOptions, stdout: NodeJS.WriteStream): boolean {
  if (options.json || options.quiet) return false;
  if (process.env.CI === "true" || process.env.CI === "1") return false;
  return stdout.isTTY === true && isTtyAvailable();
}

function shouldUseSpinner(options: AddCommandOptions, stdout: NodeJS.WriteStream): boolean {
  return canUseInteractivePrompts(options, stdout);
}

function validationName(skillMd: string): string {
  try {
    const { data } = parseFrontmatter(skillMd);
    return typeof data.name === "string" ? data.name : "";
  } catch {
    return "";
  }
}

function formatSyncPlan(value: boolean): string {
  return value ? "yes" : "no";
}

function formatProfileRoots(profileRoots: Record<string, string>): string {
  const entries = Object.entries(profileRoots);
  if (entries.length === 0) return "none";
  return entries.map(([agent, root]) => `${agent}=${root}`).join(", ");
}

function formatTargetAgents(targetAgents: string[]): string {
  return targetAgents.length > 0 ? targetAgents.join(", ") : "none";
}

function formatAddPlan(
  summary: AddPlanSummary,
  options: AddCommandOptions,
  stream: NodeJS.WriteStream,
  mode: "dry-run" | "pending" | "apply",
  preflight?: AddLocalPreflight,
  commandSuggestion?: string
): string {
  const theme = makeTheme(stream);
  const rows = [
    { label: "operation", value: "add", status: "muted" as const },
    { label: "source", value: summary.source, status: "muted" as const },
    { label: "target", value: summary.identifier ?? summary.skillDir ?? summary.target, status: "muted" as const },
    ...(summary.version ? [{ label: "version", value: summary.version, status: "muted" as const }] : []),
    { label: "storage", value: summary.storagePath, status: "muted" as const },
    { label: "sync", value: formatSyncPlan(summary.syncProfiles), status: summary.syncProfiles ? "ok" as const : "muted" as const },
    { label: "discover", value: formatSyncPlan(summary.discoverProfileRoots), status: summary.discoverProfileRoots ? "ok" as const : "muted" as const },
    { label: "profiles", value: formatProfileRoots(summary.profileRoots), status: "muted" as const },
    ...(summary.targetAgents.length > 0
      ? [{ label: "agents", value: formatTargetAgents(summary.targetAgents), status: "muted" as const }]
      : []),
    ...(preflight
      ? [
          {
            label: "validate",
            value: preflight.validation.valid ? "passed" : "failed",
            status: preflight.validation.valid ? "ok" as const : "error" as const
          }
        ]
      : []),
    {
      label: "write",
      value: mode === "dry-run" ? "no (dry run)" : mode === "pending" ? "pending confirmation" : "yes",
      status: mode === "apply" ? "ok" as const : mode === "pending" ? "warn" as const : "muted" as const
    }
  ];
  const lines: string[] = [];
  lines.push("");
  lines.push(`${badge("vault", theme)} ${theme.style.bold("AutoVault add plan")}`);
  lines.push(keyValueRows(rows, theme));
  if (preflight && !preflight.validation.valid) {
    const problems = [...preflight.validation.errors, ...preflight.warnings];
    if (problems.length > 0) {
      lines.push("");
      lines.push(`${badge("warn", theme, "warn")} preflight`);
      lines.push(bulletList(problems, theme));
    }
  }
  if (options.verbose && preflight?.repair?.available) {
    lines.push("");
    lines.push(`${badge("repair", theme, "dim")} repair available`);
    lines.push(bulletList(preflight.repair.fields.map(formatRepairField), theme));
  }
  if (commandSuggestion) {
    lines.push("");
    lines.push(`Run ${commandSuggestion} to apply.`);
  }
  return `${lines.join("\n")}\n`;
}

function formatAddPreviewJson(preview: AddPreviewResult): string {
  return `${formatJson(preview)}\n`;
}

function addSkillInputFor(
  options: AddCommandOptions,
  plan: AddCommandPlan,
  runtime: AddCommandRuntimeOptions
): AddSkillInput {
  const syncProfiles = defaultSyncProfiles(plan.source, options.syncProfiles);
  const discover = defaultDiscoverProfiles(plan.source, syncProfiles, options.discoverProfileRoots);
  const profileRoots = profileRootsOrUndefined(options.profileRoots);
  if (plan.source === "local") {
    const input: AddSkillInput = {
      source: "local",
      skill_dir: plan.skillDir,
      sync_profiles: syncProfiles,
      discover_profile_roots: discover
    };
    if (options.provenance) input.identifier = options.provenance;
    if (profileRoots) input.profile_roots = profileRoots;
    if (runtime.verboseResult !== undefined) input.verbose = runtime.verboseResult;
    else if (options.verbose) input.verbose = true;
    return input;
  }
  const input: AddSkillInput = {
    source: plan.source,
    identifier: plan.identifier ?? options.target,
    sync_profiles: syncProfiles,
    discover_profile_roots: discover
  };
  if (options.version) input.version = options.version;
  if (profileRoots) input.profile_roots = profileRoots;
  if (options.targetAgents.length > 0) input.target_agents = [...options.targetAgents];
  if (runtime.verboseResult !== undefined) input.verbose = runtime.verboseResult;
  else if (options.verbose) input.verbose = true;
  return input;
}

function localRepairInputFor(options: AddCommandOptions, plan: AddCommandPlan): AddLocalSkillInput {
  const syncProfiles = defaultSyncProfiles(plan.source, options.syncProfiles);
  return {
    skillDir: plan.skillDir ?? options.target,
    source: options.provenance,
    syncProfiles,
    profileRoots: profileRootsOrUndefined(options.profileRoots),
    discoverProfileRoots: defaultDiscoverProfiles(plan.source, syncProfiles, options.discoverProfileRoots)
  };
}

async function preflightLocalAdd(
  options: AddCommandOptions,
  plan: AddCommandPlan
): Promise<AddLocalPreflight> {
  const bundle = await collectLocalSkillBundle(plan.skillDir ?? options.target);
  const { output: repairedSkillMd } = attemptRepair(bundle.skillMd);
  const validation = validateSkillInput(repairedSkillMd, bundle.resources);
  const repair = validation.valid
    ? undefined
    : await buildLocalRepairProposal(bundle, repairedSkillMd, validation, localRepairInputFor(options, plan));
  return {
    name: validationName(repairedSkillMd),
    bundleRoot: bundle.root,
    validation,
    warnings: validation.warnings,
    ...(repair ? { repair } : {})
  };
}

async function preflightForPlan(
  options: AddCommandOptions,
  plan: AddCommandPlan
): Promise<AddLocalPreflight | undefined> {
  if (plan.source !== "local") return undefined;
  return preflightLocalAdd(options, plan);
}

async function executeAdd(
  input: AddSkillInput,
  options: AddCommandOptions,
  stdout: NodeJS.WriteStream,
  addSkillFn: typeof addSkill
): Promise<Record<string, unknown>> {
  if (!shouldUseSpinner(options, stdout)) {
    return withSuppressedLogs(() => addSkillFn(input));
  }
  const task = startSpinner("Adding skill", stdout);
  try {
    const result = await withSuppressedLogs(() => addSkillFn(input));
    task.stop("Skill add complete");
    return result;
  } catch (error) {
    task.error("Skill add failed");
    throw error;
  }
}

const COMMON_TARGET_AGENTS = ["codex", "claude-code", "cursor"];

function targetAgentPromptChoices(options: AddCommandOptions): Array<{ label: string; value: string; hint?: string }> {
  const choices = new Map<string, { label: string; value: string; hint?: string }>();
  for (const agent of Object.keys(options.profileRoots)) {
    choices.set(agent, { label: agent, value: agent, hint: "linked profile root" });
  }
  for (const agent of COMMON_TARGET_AGENTS) {
    if (!choices.has(agent)) choices.set(agent, { label: agent, value: agent });
  }
  return [...choices.values()];
}

async function promptForRemoteTargetAgents(options: AddCommandOptions): Promise<string[]> {
  return askMultiSelect(
    "Where should AutoVault expose this skill?",
    targetAgentPromptChoices(options),
    {
      initialValues: options.targetAgents,
      required: true
    }
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExitSentinel(error: unknown): boolean {
  return typeof (error as { code?: unknown })?.code === "number" && /^exit \d+$/.test(errorMessage(error));
}

function errorPayload(error: unknown, summary?: AddPlanSummary): Record<string, unknown> {
  return {
    success: false,
    error: errorMessage(error),
    ...(summary ? { plan: summary } : {}),
    warnings: []
  };
}

function previewResult(
  summary: AddPlanSummary,
  options: AddCommandOptions,
  preflight: AddLocalPreflight | undefined,
  kind: "dry-run" | "needs-confirmation",
  message?: string
): AddPreviewResult {
  const validationValid = preflight ? preflight.validation.valid : true;
  return {
    success: kind === "dry-run" ? validationValid : false,
    dryRun: kind === "dry-run",
    wouldWrite: false,
    ...(kind === "needs-confirmation" ? { needsConfirmation: true } : {}),
    plan: summary,
    ...(preflight ? { preflight } : {}),
    warnings: preflight?.warnings ?? [],
    ...(message ? { message } : {})
  };
}

export async function runAddCommand(
  args: string[],
  io: AddCommandIO = {},
  deps: AddCommandDeps = {},
  runtime: AddCommandRuntimeOptions = {}
): Promise<AddCommandOutcome> {
  const stdout = (io.stdout ?? process.stdout) as NodeJS.WriteStream;
  const stderr = (io.stderr ?? process.stderr) as NodeJS.WriteStream;
  const options = parseArgs(args, io, runtime);
  const plan = await planAdd(options);
  if (runtime.localOnly && plan.source !== "local") {
    fail(io, "autovault add-local only accepts local skill directories or SKILL.md paths.");
  }

  const input = addSkillInputFor(options, plan, runtime);
  const summary = planSummaryFor(options, plan, input);
  const addSkillFn = deps.addSkill ?? addSkill;
  const commandName = runtime.commandName ?? "add";
  const canonicalAdd = !runtime.localOnly && commandName === "add";

  try {
    let preflight: AddLocalPreflight | undefined;
    if (
      options.dryRun ||
      (canonicalAdd && (!options.yes || (!options.json && !options.quiet)))
    ) {
      preflight = await preflightForPlan(options, plan);
    }

    if (options.dryRun) {
      const preview = previewResult(summary, options, preflight, "dry-run");
      if (options.json) {
        stdout.write(formatAddPreviewJson(preview));
      } else if (!options.quiet) {
        stdout.write(formatAddPlan(summary, options, stdout, "dry-run", preflight));
      }
      if (!preview.success) exit(io, 1);
      return { mutated: false, shouldWriteUpdateNotice: false };
    }

    if (canonicalAdd && !options.yes) {
      const commandSuggestion = suggestedYesCommand(commandName, args);
      if (!canUseInteractivePrompts(options, stdout)) {
        const preview = previewResult(
          summary,
          options,
          preflight,
          "needs-confirmation",
          `${commandSuggestion} to apply.`
        );
        if (options.json) {
          stdout.write(formatAddPreviewJson(preview));
        } else if (!options.quiet) {
          stdout.write(formatAddPlan(summary, options, stdout, "pending", preflight, commandSuggestion));
        }
        return { mutated: false, shouldWriteUpdateNotice: false };
      }

      if (!options.quiet && !options.json) {
        stdout.write(formatAddPlan(summary, options, stdout, "pending", preflight));
      }
      const ok = await confirm("Add this skill to AutoVault?", true);
      if (!ok) {
        if (!options.quiet && !options.json) stdout.write("Add canceled.\n");
        return { mutated: false, shouldWriteUpdateNotice: false };
      }
    } else if (canonicalAdd && !options.json && !options.quiet) {
      stdout.write(formatAddPlan(summary, options, stdout, "apply", preflight));
    }

    let result = await executeAdd(input, options, stdout, addSkillFn);
    if (plan.source === "local" && canPrompt(options, result as AddLocalSkillResult)) {
      result = await runInteractiveRepair(
        options,
        localRepairInputFor(options, plan),
        result as AddLocalSkillResult,
        stdout
      );
    }
    if (
      plan.source !== "local" &&
      isTargetAgentsRequired(result) &&
      canUseInteractivePrompts(options, stdout)
    ) {
      const selectedAgents = await promptForRemoteTargetAgents(options);
      result = await executeAdd(
        { ...input, target_agents: selectedAgents },
        { ...options, targetAgents: selectedAgents },
        stdout,
        addSkillFn
      );
    }

    if (options.json) {
      stdout.write(`${formatJson(result)}\n`);
    } else if (!options.quiet) {
      stdout.write(formatAddResult(result, plan, options, stdout));
    }
    if (result.success !== true) {
      if (options.quiet && !options.json) {
        const warnings = stringWarnings(result);
        stderr.write(`${warnings[0] ?? "AutoVault add failed."}\n`);
      }
      exit(io, 1);
    }
    return {
      mutated: true,
      shouldWriteUpdateNotice: !options.json && !options.quiet
    };
  } catch (error) {
    if (isExitSentinel(error)) throw error;
    if (options.json) {
      stdout.write(`${formatJson(errorPayload(error, summary))}\n`);
    } else {
      stderr.write(`${errorMessage(error)}\n`);
    }
    exit(io, 1);
  }
}

export async function runAddLocalCommand(
  args: string[],
  io: AddCommandIO = {}
): Promise<AddCommandOutcome> {
  return runAddCommand(args, io, {}, {
    commandName: "add-local",
    localOnly: true,
    legacyLocalSourceFlag: true,
    verboseResult: true
  });
}
