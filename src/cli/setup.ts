import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStorage } from "../storage/index.js";
import {
  applyDecisions,
  type AdoptionMode,
  type CollisionAction,
  type CollisionDecision
} from "./setup/apply.js";
import {
  askChoice,
  isTtyAvailable,
  NoTtyError
} from "./setup/prompt.js";
import {
  colorsFor,
  makeLogger,
  renderArt,
  renderDriftReport,
  renderFinalSummary,
  startSpinner
} from "./setup/render.js";
import {
  adoptionCandidates,
  bundledNativeCollisions,
  failingNativeSkills,
  scanDrift,
  type DriftReport,
  type SkillView
} from "./setup/scan.js";

export type RunSetupOptions = {
  bundledRoot?: string;
  discover?: boolean;
  profileRoots?: Record<string, string>;
  json?: boolean;
};

export async function runSetup(options: RunSetupOptions = {}): Promise<void> {
  const log = makeLogger();
  if (!isTtyAvailable() && !options.json) {
    throw new NoTtyError();
  }

  await ensureStorage();

  const scanInput = {
    discover: options.discover ?? true,
    bundledRoot: options.bundledRoot,
    profileRoots: options.profileRoots
  };

  let report: DriftReport;
  if (options.json) {
    report = await scanDrift(scanInput);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const spin = startSpinner("Scanning skill roots…");
  try {
    report = await scanDrift(scanInput);
  } finally {
    spin.stop();
  }

  const profileRoots = { ...report.discovered, ...(options.profileRoots ?? {}) };

  log.ok(
    `Scanned ${report.skills.length} skill name(s) across vault, bundled, and ${Object.keys(profileRoots).length} native root(s)`
  );

  renderDriftReport(report);

  if (report.skills.length === 0) {
    log.info("No skills found anywhere yet — install some, then re-run autovault setup.");
    return;
  }

  const failing = failingNativeSkills(report);
  let allowFailingValidation = false;
  if (failing.length > 0) {
    const c = colorsFor(process.stdout);
    process.stdout.write(
      `\n${c.bold}${failing.length}${c.reset} native skill(s) would fail vault validation under strict mode.\n`
    );
    const decision = await askChoice<"skip" | "abort" | "loosen">(
      "How would you like to handle them?",
      [
        { key: "s", label: "skip those skills (adopt only the validatable ones)", value: "skip" },
        { key: "a", label: "abort setup", value: "abort" },
        { key: "l", label: "loosen strict mode for this run only", value: "loosen" }
      ]
    );
    if (decision.value === "abort") {
      log.warn("Aborted by user");
      return;
    }
    if (decision.value === "loosen") {
      process.env.AUTOVAULT_SECURITY_STRICT = "false";
      allowFailingValidation = true;
    }
  }

  const adoptionDecision = await askChoice<AdoptionMode | "skip">(
    "\nHow would you like to handle native skills?",
    [
      { key: "1", label: "augment — leave natives alone, vault adds new skills only", value: "augment" },
      { key: "2", label: "adopt + backup — copy each into vault; rename original to <root>.bak/<name>", value: "backup" },
      { key: "3", label: "adopt in place — copy each into vault; replace original dir with managed symlink", value: "in-place" },
      { key: "4", label: "skip — exit without changes", value: "skip" }
    ]
  );

  if (adoptionDecision.value === "skip") {
    log.info("No changes applied. Re-run autovault setup any time.");
    return;
  }

  const candidatesAll = adoptionCandidates(report);
  const candidates = allowFailingValidation
    ? candidatesAll
    : candidatesAll.filter(
        (skill) => !skill.native.some((n) => n.validation && !n.validation.valid)
      );

  let collisions: CollisionDecision[] = [];
  if (adoptionDecision.value !== "augment") {
    const colliding = bundledNativeCollisions(report).filter((skill) =>
      candidates.includes(skill)
    );
    collisions = await collectCollisionDecisions(colliding);
  }

  const outcomes = await applyDecisions({
    mode: adoptionDecision.value,
    candidates,
    collisions,
    profileRoots,
    discover: options.discover ?? true
  });

  renderFinalSummary(report, outcomes);

  printConfigSnippets(report, profileRoots);
  renderArt();
}

export function resolveMcpServerPath(
  currentModuleUrl = import.meta.url,
  cwd = process.cwd()
): string {
  const currentFile = fileURLToPath(currentModuleUrl);
  const currentDir = path.dirname(currentFile);
  if (
    path.basename(currentDir) === "cli" &&
    path.basename(path.dirname(currentDir)) === "dist"
  ) {
    return path.resolve(currentDir, "..", "index.js");
  }
  return path.resolve(cwd, "dist", "index.js");
}

async function collectCollisionDecisions(
  colliding: SkillView[]
): Promise<CollisionDecision[]> {
  const decisions: CollisionDecision[] = [];
  let applyToAll: CollisionAction | null = null;
  for (const skill of colliding) {
    if (applyToAll) {
      decisions.push({ name: skill.name, action: applyToAll });
      continue;
    }
    const c = colorsFor(process.stdout);
    process.stdout.write(`\n${c.bold}Collision:${c.reset} ${skill.name}\n`);
    if (skill.bundled) {
      process.stdout.write(`  ${c.dim}bundled :${c.reset} ${skill.bundled.description}\n`);
    }
    for (const native of skill.native) {
      process.stdout.write(`  ${c.dim}${native.agent} :${c.reset} ${native.description}\n`);
    }
    const choice = await askChoice<CollisionAction>(
      "How should this be resolved?",
      [
        {
          key: "b",
          label: "use bundled (back up native to <root>.bak/<name>)",
          value: "use-bundled",
          applyToAllKey: "B"
        },
        {
          key: "n",
          label: "keep native (adopt yours into vault, skip bundled install)",
          value: "keep-native",
          applyToAllKey: "N"
        },
        {
          key: "s",
          label: "skip this skill entirely",
          value: "skip",
          applyToAllKey: "S"
        }
      ]
    );
    decisions.push({ name: skill.name, action: choice.value });
    if (choice.applyToAll) applyToAll = choice.value;
  }
  return decisions;
}

function printConfigSnippets(
  report: DriftReport,
  profileRoots: Record<string, string>
): void {
  const c = colorsFor(process.stdout);
  process.stdout.write(`\n${c.bold}MCP host config snippet${c.reset} (Claude Code)\n`);
  process.stdout.write(
    `${c.dim}Add this to ~/.claude/mcp.json or your project's .mcp.json:${c.reset}\n`
  );
  const node = process.execPath;
  const distPath = resolveMcpServerPath();
  const linkArgs = Object.entries(profileRoots)
    .map(([agent, root]) => `${agent}=${root}`)
    .join(",");
  const snippet = {
    mcpServers: {
      autovault: {
        command: node,
        args: [distPath],
        env: {
          AUTOVAULT_STORAGE_PATH: report.storagePath,
          ...(linkArgs ? { AUTOVAULT_PROFILE_LINKS: linkArgs } : {})
        }
      }
    }
  };
  process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
}
