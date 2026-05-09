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
  askSelect,
  isTtyAvailable,
  NoTtyError
} from "./setup/prompt.js";
import {
  colorsFor,
  makeLogger,
  renderArt,
  renderCompactScanSummary,
  renderDriftReport,
  renderSetupIntro,
  renderFinalSummary,
  renderReviewSkill,
  reviewReason,
  reviewSkills,
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
  review?: boolean;
  advanced?: boolean;
};

export async function runSetup(options: RunSetupOptions = {}): Promise<void> {
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

  await renderSetupIntro();

  const spin = startSpinner("Scanning vault and native skill roots...");
  try {
    report = await scanDrift(scanInput);
    spin.stop(
      `Scanned ${report.skills.length} skill name(s) across ${Object.keys(report.discovered).length} native root(s)`
    );
  } catch (error) {
    spin.error("Scan failed");
    throw error;
  }

  const profileRoots = { ...report.discovered, ...(options.profileRoots ?? {}) };

  if (options.advanced) {
    await runAdvancedSetup(report, profileRoots, options);
    return;
  }

  renderCompactScanSummary(report);

  const needsReview = reviewSkills(report);
  let didSync = false;
  if (options.review) {
    didSync = await runReviewPicker(report, profileRoots, options);
  } else if (needsReview.length > 0) {
    const decision = await askChoice<"finish" | "review">(
      "Review native skill issues now?",
      [
        {
          key: "f",
          label: "finish install",
          value: "finish",
          hint: "safe default: leave native skills untouched"
        },
        {
          key: "r",
          label: "review now",
          value: "review",
          hint: "open an interactive picker"
        }
      ]
    );
    if (decision.value === "review") {
      didSync = await runReviewPicker(report, profileRoots, options);
    }
  }

  if (!didSync) {
    await runSafeSync(profileRoots, options);
  }

  renderArt(process.stdout, { reviewCount: needsReview.length });
}

async function runAdvancedSetup(
  report: DriftReport,
  profileRoots: Record<string, string>,
  options: RunSetupOptions
): Promise<void> {
  const log = makeLogger();
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

  const candidatesAll = adoptionCandidates(report);
  const candidates = allowFailingValidation
    ? candidatesAll
    : candidatesAll.filter(
        (skill) => !skill.native.some((n) => n.validation && !n.validation.valid)
      );

  let adoptionMode: AdoptionMode = "augment";
  if (candidates.length > 0) {
    const adoptionDecision = await askChoice<AdoptionMode | "skip">(
      "\nHow would you like to handle native skills?",
      [
        {
          key: "1",
          label: "augment (recommended) - leave natives alone, vault adds new skills only",
          value: "augment"
        },
        {
          key: "2",
          label: "adopt + backup - copy into vault; move originals to <root>.bak/<name>",
          value: "backup"
        },
        {
          key: "3",
          label: "adopt in place (destructive) - replace original dirs with managed symlinks",
          value: "in-place"
        },
        { key: "4", label: "skip - exit without changes", value: "skip" }
      ]
    );

    if (adoptionDecision.value === "skip") {
      log.info("No changes applied. Re-run autovault setup any time.");
      return;
    }
    adoptionMode = adoptionDecision.value;
  } else {
    log.ok("No adoption decisions needed; refreshing managed profile links.");
  }

  let collisions: CollisionDecision[] = [];
  if (adoptionMode !== "augment") {
    const colliding = bundledNativeCollisions(report).filter((skill) =>
      candidates.includes(skill)
    );
    collisions = await collectCollisionDecisions(colliding);
  }

  const applySpin = startSpinner("Applying vault intake decisions...");
  let outcomes: Awaited<ReturnType<typeof applyDecisions>>;
  try {
    outcomes = await applyDecisions({
      mode: adoptionMode,
      candidates,
      collisions,
      profileRoots,
      discover: options.discover ?? true
    });
    applySpin.stop("Profile links refreshed");
  } catch (error) {
    applySpin.error("Apply failed");
    throw error;
  }

  renderFinalSummary(report, outcomes);

  printConfigSnippets(report, profileRoots);
  printHostRestartGuidance();
  renderArt(process.stdout, { reviewCount: reviewSkills(report).length });
}

type ReviewSelection = {
  candidates: SkillView[];
  collisions: CollisionDecision[];
};

function nativeFailsValidation(skill: SkillView): boolean {
  return skill.native.some((native) => native.validation && !native.validation.valid);
}

function canAdoptWithBackup(skill: SkillView): boolean {
  return skill.native.length > 0 && !nativeFailsValidation(skill) && skill.category !== "invalid";
}

function canUseBundled(skill: SkillView): boolean {
  const nativeHash = skill.native[0]?.hash;
  return Boolean(skill.bundled && nativeHash && skill.bundled.hash !== nativeHash);
}

function reviewChoiceLabel(skill: SkillView): string {
  return `${reviewReason(skill)}: ${skill.name}`;
}

async function runReviewPicker(
  report: DriftReport,
  profileRoots: Record<string, string>,
  options: RunSetupOptions
): Promise<boolean> {
  const reasonOrder = new Map([
    ["needs validation", 0],
    ["native only", 1],
    ["drift", 2],
    ["unreadable", 3]
  ]);
  const reviewable = reviewSkills(report).sort((left, right) => {
    const byReason =
      (reasonOrder.get(reviewReason(left)) ?? 99) -
      (reasonOrder.get(reviewReason(right)) ?? 99);
    return byReason || left.name.localeCompare(right.name);
  });
  if (reviewable.length === 0) {
    makeLogger().ok("No native skill issues need review.");
    return false;
  }

  const selection: ReviewSelection = { candidates: [], collisions: [] };
  const handled = new Set<string>();

  while (true) {
    const remaining = reviewable.filter((skill) => !handled.has(skill.name));
    const choice = await askSelect<SkillView | "finish">(
      "Choose a skill to review",
      [
        {
          label: "finish review",
          value: "finish",
          hint:
            selection.candidates.length === 0
              ? "leave all remaining native skills untouched"
              : "apply selected safe actions"
        },
        ...remaining.map((skill) => ({
          label: reviewChoiceLabel(skill),
          value: skill,
          hint: skill.native[0]?.description || skill.bundled?.description || skill.vault?.description
        }))
      ],
      { initialValue: "finish", maxItems: 8 }
    );

    if (choice === "finish") break;
    renderReviewSkill(choice);

    const actions: Array<{
      label: string;
      value: "leave" | "adopt-backup" | "use-bundled";
      hint?: string;
      disabled?: boolean;
    }> = [
      {
        label: "leave native for now",
        value: "leave",
        hint: "safe default"
      },
      {
        label: "adopt with backup",
        value: "adopt-backup",
        hint: "copy into vault and move original to <root>.bak",
        disabled: !canAdoptWithBackup(choice)
      },
      {
        label: "use bundled",
        value: "use-bundled",
        hint: "back up native copy and keep bundled version",
        disabled: !canUseBundled(choice)
      }
    ];

    const action = await askSelect("Action for this skill", actions, {
      initialValue: "leave"
    });
    handled.add(choice.name);

    if (action === "adopt-backup") {
      selection.candidates.push(choice);
    } else if (action === "use-bundled") {
      selection.candidates.push(choice);
      selection.collisions.push({ name: choice.name, action: "use-bundled" });
    }
  }

  if (selection.candidates.length === 0) return false;

  const applySpin = startSpinner("Applying reviewed skill decisions...");
  try {
    const outcomes = await applyDecisions({
      mode: "backup",
      candidates: selection.candidates,
      collisions: selection.collisions,
      profileRoots,
      discover: options.discover ?? true
    });
    applySpin.stop("Reviewed decisions applied");
    renderFinalSummary(report, outcomes);
    return true;
  } catch (error) {
    applySpin.error("Review apply failed");
    throw error;
  }
}

async function runSafeSync(
  profileRoots: Record<string, string>,
  options: RunSetupOptions
): Promise<void> {
  const applySpin = startSpinner("Refreshing managed profile links...");
  try {
    const outcomes = await applyDecisions({
      mode: "augment",
      candidates: [],
      collisions: [],
      profileRoots,
      discover: options.discover ?? true
    });
    const failed = outcomes.filter((outcome) => !outcome.ok);
    if (failed.length > 0) {
      applySpin.stop("Profile links refreshed with warnings");
      if (process.env.AUTOVAULT_VERBOSE === "1") {
        renderFinalSummary(
          {
            storagePath: "",
            bundledRoot: "",
            discovered: {},
            skills: [],
            totals: {
              identical: 0,
              "vault-drift": 0,
              "bundled-drift": 0,
              "cross-host-drift": 0,
              "vault-only": 0,
              "native-only": 0,
              "bundled-only": 0,
              invalid: 0
            },
            hasFailingValidation: false
          },
          failed
        );
      } else {
        makeLogger().warn(`${failed.length} profile link warning(s); run autovault doctor for details.`);
      }
      return;
    }
    applySpin.stop("Profile links refreshed");
  } catch (error) {
    applySpin.error("Profile refresh failed");
    throw error;
  }
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

function printHostRestartGuidance(): void {
  const c = colorsFor(process.stdout);
  process.stdout.write(`\n${c.bold}Host restart${c.reset}\n`);
  process.stdout.write("Restart Claude Code, Codex, or Cursor if they cache filesystem skills.\n");
  process.stdout.write("Then verify from the host by loading the autovault-skill skill.\n");
}
