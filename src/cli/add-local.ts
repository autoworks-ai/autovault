import fs from "node:fs/promises";
import path from "node:path";
import { renderSuccessOutro } from "./ui/brand.js";
import { badge, sectionTitle } from "./ui/messages.js";
import { bulletList, keyValueRows } from "./ui/table.js";
import { makeTheme } from "./ui/theme.js";
import { formatJson, joinCliList } from "./ui/output.js";
import { ask, askMultiSelect, confirm, isTtyAvailable } from "./setup/prompt.js";
import {
  addLocalSkill,
  collectLocalSkillBundle,
  previewSkillFrontmatter,
  type AddLocalSkillInput,
  type AddLocalSkillResult,
  type LocalRepairField
} from "../installer/local.js";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { synthesizeSkillFrontmatter } from "../validation/frontmatter-synthesis.js";
import { withSuppressedLogs } from "../util/log.js";

type AddLocalCommandIO = {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => void;
};

type AddLocalCommandOptions = {
  skillDir: string;
  source?: string;
  syncProfiles: boolean;
  json: boolean;
  profileRoots: Record<string, string>;
};

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseProfileLink(value: string | undefined): [string, string] {
  if (!value || !value.includes("=")) throw new Error("autovault add-local --link requires agent=/path");
  const [agent, root] = value.split("=", 2);
  if (!agent || !root) throw new Error("autovault add-local --link requires agent=/path");
  return [agent, root];
}

function exit(io: AddLocalCommandIO, code: number): never {
  if (io.exit) io.exit(code);
  else process.exit(code);
  throw new Error(`exit ${code}`);
}

function fail(io: AddLocalCommandIO, message: string, code = 2): never {
  (io.stderr ?? process.stderr).write(`${message}\n`);
  return exit(io, code);
}

function parseArgs(args: string[], io: AddLocalCommandIO): AddLocalCommandOptions {
  let skillDir: string | undefined;
  let source: string | undefined;
  const profileRoots: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--source") {
      source = args[i + 1];
      if (!source) fail(io, "autovault add-local --source requires a provenance value.");
      i += 1;
      continue;
    }
    if (arg === "--link") {
      try {
        const [agent, root] = parseProfileLink(args[i + 1]);
        profileRoots[agent] = root;
      } catch (error) {
        fail(io, String((error as Error).message ?? error));
      }
      i += 1;
      continue;
    }
    if (arg === "--sync-profiles" || arg === "--json") continue;
    if (arg.startsWith("-")) fail(io, `Unknown autovault add-local flag: ${arg}`);
    if (skillDir) fail(io, "autovault add-local accepts one local skill directory or SKILL.md path.");
    skillDir = arg;
  }
  if (!skillDir) fail(io, "autovault add-local requires a local skill directory or SKILL.md path.");
  return {
    skillDir,
    source,
    syncProfiles: hasFlag(args, "--sync-profiles"),
    json: hasFlag(args, "--json"),
    profileRoots
  };
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
          const count = result.sync.profiles[agent]?.length ?? 0;
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

function canPrompt(options: AddLocalCommandOptions, result: AddLocalSkillResult): boolean {
  if (options.json) return false;
  if (process.env.CI === "true" || process.env.CI === "1") return false;
  return Boolean(result.repair?.available && isTtyAvailable());
}

function suggested(field: LocalRepairField): string | undefined {
  return typeof field.suggested === "string" ? field.suggested : undefined;
}

async function repairedSkillMdFor(
  options: AddLocalCommandOptions,
  result: AddLocalSkillResult
): Promise<string> {
  if (!result.repair?.available) throw new Error("No local repair proposal available.");
  const bundle = await collectLocalSkillBundle(options.skillDir);
  const { output: normalizedSkillMd } = attemptRepair(bundle.skillMd);
  const parsed = parseFrontmatter(normalizedSkillMd);
  const field = (path: LocalRepairField["path"]) =>
    result.repair?.available ? result.repair.fields.find((item) => item.path === path) : undefined;

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
  options: AddLocalCommandOptions,
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

export async function runAddLocalCommand(
  args: string[],
  io: AddLocalCommandIO = {}
): Promise<void> {
  const stdout = (io.stdout ?? process.stdout) as NodeJS.WriteStream;
  const options = parseArgs(args, io);
  const input: AddLocalSkillInput = {
    skillDir: options.skillDir,
    source: options.source,
    syncProfiles: options.syncProfiles,
    profileRoots: options.profileRoots,
    discoverProfileRoots: options.syncProfiles
  };
  let result = await withSuppressedLogs(() => addLocalSkill(input));
  if (canPrompt(options, result)) {
    result = await runInteractiveRepair(options, input, result, stdout);
  }
  if (options.json) {
    stdout.write(`${formatJson(result)}\n`);
  } else {
    stdout.write(formatAddLocalResult(result, options.skillDir, stdout));
  }
  if (!result.success) exit(io, 1);
}
