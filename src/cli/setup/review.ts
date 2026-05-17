import matter from "gray-matter";
import { collectLocalSkillBundle, type LocalSkillResource } from "../../installer/local.js";
import { canonicalRelPath } from "../../util/path.js";
import { badge } from "../ui/messages.js";
import { makeTheme, padEndVisible } from "../ui/theme.js";
import { parseFrontmatter } from "../../validation/frontmatter.js";
import { synthesizeSkillFrontmatter } from "../../validation/frontmatter-synthesis.js";
import { validateSkillInput } from "../../validation/index.js";
import type { SkillSourceView, SkillView } from "./scan.js";

export type ReviewIssueKind =
  | "resource-manifest-incomplete"
  | "schema-invalid"
  | "security-blocked"
  | "native-drift"
  | "cross-host-drift"
  | "native-only"
  | "unreadable"
  | "unknown-validation";

export type ReviewIssue = {
  kind: ReviewIssueKind;
  severity: "info" | "warn" | "error";
  message: string;
  affectedPaths: string[];
  rawDetails: string[];
};

export type ReviewActionId =
  | "leave"
  | "adopt-backup"
  | "repair-adopt-backup"
  | "use-bundled";

export type ReviewAction = {
  id: ReviewActionId;
  label: string;
  enabled: boolean;
  hint: string;
  disabledReason?: string;
  safetyNote?: string;
};

export type ReviewRepair = {
  skillMd: string;
  resources: LocalSkillResource[];
  declaredResources: string[];
};

export type ReviewPlan = {
  skill: SkillView;
  issues: ReviewIssue[];
  actions: ReviewAction[];
  recommendedAction: ReviewActionId;
  repair?: ReviewRepair;
};

const RESOURCE_ERROR = /Bundle includes undisclosed file '([^']+)'/;

function shortHash(hash: string): string {
  return hash ? hash.slice(0, 8) : "--------";
}

function categoryLabel(skill: SkillView): string {
  if (skill.category === "cross-host-drift") return "cross-host drift";
  if (skill.category === "native-only") return "native only";
  if (skill.category === "bundled-drift" || skill.category === "vault-drift") return "drift";
  if (skill.category === "invalid") return "unreadable";
  return skill.category.replace(/-/g, " ");
}

function firstNative(skill: SkillView): SkillSourceView | undefined {
  return skill.native[0];
}

function nativeValidationFailures(skill: SkillView): Array<{ native: SkillSourceView; errors: string[]; securityFlags: string[] }> {
  return skill.native
    .filter((native) => native.validation && !native.validation.valid)
    .map((native) => ({
      native,
      errors: native.validation?.errors ?? [],
      securityFlags: native.validation?.securityFlags ?? []
    }));
}

function resourcePathsFrom(errors: string[]): string[] {
  return errors
    .map((error) => RESOURCE_ERROR.exec(error)?.[1])
    .filter((path): path is string => Boolean(path));
}

function declaredResourcePaths(data: Record<string, unknown>): Set<string> {
  const declared = new Set<string>();
  if (Array.isArray(data.resources)) {
    for (const raw of data.resources as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const resourcePath = (raw as Record<string, unknown>).path;
      if (typeof resourcePath === "string" && resourcePath.length > 0) {
        declared.add(canonicalRelPath(resourcePath) || resourcePath);
      }
    }
  }
  if (typeof data.bin === "object" && data.bin !== null) {
    for (const raw of Object.values(data.bin as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const command = (raw as Record<string, unknown>).command;
      if (typeof command === "string" && command.length > 0) {
        declared.add(canonicalRelPath(command) || command);
      }
    }
  }
  return declared;
}

function synthesizeResourceRepair(
  skillMd: string,
  resources: LocalSkillResource[],
  inferredAgents: string[] | undefined
): { skillMd: string; declaredResources: string[] } {
  const firstPass = synthesizeSkillFrontmatter(skillMd, {
    resources,
    agents: inferredAgents
  });
  const parsed = parseFrontmatter(firstPass.skillMd);
  const frontmatter = { ...parsed.data };
  const declared = declaredResourcePaths(frontmatter);
  const existingResources = Array.isArray(frontmatter.resources)
    ? [...(frontmatter.resources as unknown[])]
    : [];
  const declaredResources: string[] = [];

  for (const resource of resources) {
    const resourcePath = canonicalRelPath(resource.path) || resource.path;
    if (declared.has(resourcePath)) continue;
    existingResources.push({ path: resourcePath, type: "file" });
    declared.add(resourcePath);
    declaredResources.push(resourcePath);
  }

  if (firstPass.inferredResources.length > 0) {
    declaredResources.push(...firstPass.inferredResources.map((resource) => resource.path));
  }
  if (declaredResources.length === 0) {
    return { skillMd: firstPass.skillMd, declaredResources };
  }

  frontmatter.resources = existingResources;
  return {
    skillMd: matter.stringify(`${parsed.content.trimEnd()}\n`, frontmatter).replace(/\n+$/, "\n"),
    declaredResources
  };
}

async function buildRepair(skill: SkillView): Promise<ReviewRepair | undefined> {
  const native = firstNative(skill);
  if (!native || skill.native.length !== 1) return undefined;
  const failing = native.validation && !native.validation.valid;
  if (!failing) return undefined;
  const paths = resourcePathsFrom(native.validation?.errors ?? []);
  if (paths.length === 0) return undefined;

  try {
    const bundle = await collectLocalSkillBundle(native.skillDir, { followRootSymlink: true });
    const synthesized = synthesizeResourceRepair(
      bundle.skillMd,
      bundle.resources,
      native.inferredAgents
    );
    if (synthesized.declaredResources.length === 0) return undefined;
    const validation = validateSkillInput(synthesized.skillMd, bundle.resources);
    if (!validation.valid) return undefined;
    return {
      skillMd: synthesized.skillMd,
      resources: bundle.resources,
      declaredResources: synthesized.declaredResources
    };
  } catch {
    return undefined;
  }
}

function buildIssues(skill: SkillView): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  for (const reason of skill.invalidReasons) {
    issues.push({
      kind: "unreadable",
      severity: "error",
      message: "AutoVault could not read this skill bundle.",
      affectedPaths: [],
      rawDetails: [reason]
    });
  }

  if (skill.category === "cross-host-drift") {
    issues.push({
      kind: "cross-host-drift",
      severity: "warn",
      message: "Multiple native roots have different bytes for this skill.",
      affectedPaths: skill.native.map((native) => native.skillDir),
      rawDetails: []
    });
  } else if (skill.category === "vault-drift" || skill.category === "bundled-drift") {
    issues.push({
      kind: "native-drift",
      severity: "warn",
      message: "The native copy differs from the vaulted or bundled copy.",
      affectedPaths: skill.native.map((native) => native.skillDir),
      rawDetails: []
    });
  } else if (skill.category === "native-only") {
    issues.push({
      kind: "native-only",
      severity: "info",
      message: "This skill exists only in a native agent root.",
      affectedPaths: skill.native.map((native) => native.skillDir),
      rawDetails: []
    });
  }

  for (const failure of nativeValidationFailures(skill)) {
    const resourcePaths = resourcePathsFrom(failure.errors);
    if (resourcePaths.length > 0) {
      issues.push({
        kind: "resource-manifest-incomplete",
        severity: "error",
        message: "The bundle ships resource files that SKILL.md does not declare.",
        affectedPaths: resourcePaths,
        rawDetails: failure.errors.filter((error) => RESOURCE_ERROR.test(error))
      });
    }

    const schemaErrors = failure.errors.filter((error) => !RESOURCE_ERROR.test(error));
    if (schemaErrors.length > 0) {
      issues.push({
        kind: "schema-invalid",
        severity: "error",
        message: "SKILL.md does not satisfy the AutoVault schema.",
        affectedPaths: [failure.native.skillDir],
        rawDetails: schemaErrors
      });
    }

    if (failure.securityFlags.length > 0) {
      issues.push({
        kind: "security-blocked",
        severity: "error",
        message: "The skill declares capabilities that do not match its contents.",
        affectedPaths: [failure.native.skillDir],
        rawDetails: failure.securityFlags
      });
    }

    if (
      resourcePaths.length === 0 &&
      schemaErrors.length === 0 &&
      failure.securityFlags.length === 0
    ) {
      issues.push({
        kind: "unknown-validation",
        severity: "error",
        message: "The native copy failed validation.",
        affectedPaths: [failure.native.skillDir],
        rawDetails: [...failure.errors, ...failure.securityFlags]
      });
    }
  }

  return issues;
}

function canUseBundled(skill: SkillView): boolean {
  const nativeHash = firstNative(skill)?.hash;
  return skill.native.length === 1 && Boolean(skill.bundled && nativeHash && skill.bundled.hash !== nativeHash);
}

function hasBlockingValidation(skill: SkillView): boolean {
  return nativeValidationFailures(skill).length > 0;
}

function canAdoptWithBackup(skill: SkillView): boolean {
  return skill.native.length === 1 && !hasBlockingValidation(skill) && skill.category !== "invalid";
}

function disabledAdoptReason(skill: SkillView): string {
  if (skill.native.length === 0) return "no native copy is available to adopt";
  if (skill.native.length > 1) return "multiple native roots disagree; choose one source manually before adopting";
  if (skill.category === "invalid") return "the skill bundle is unreadable";
  if (hasBlockingValidation(skill)) return "validation needs a manual fix before normal adoption";
  return "not needed for this skill";
}

function disabledBundledReason(skill: SkillView): string {
  if (skill.native.length > 1) return "multiple native roots disagree; choose one source manually before replacing";
  if (!skill.bundled) return "no bundled version exists";
  const nativeHash = firstNative(skill)?.hash;
  if (!nativeHash) return "no readable native copy is available";
  if (skill.bundled.hash === nativeHash) return "native copy already matches bundled bytes";
  return "bundled replacement is not available";
}

export function enabledReviewActions(plan: ReviewPlan): ReviewAction[] {
  return plan.actions.filter((action) => action.enabled);
}

export function unavailableReviewActions(plan: ReviewPlan): ReviewAction[] {
  return plan.actions.filter((action) => !action.enabled);
}

export async function buildReviewPlan(skill: SkillView): Promise<ReviewPlan> {
  const repair = await buildRepair(skill);
  const actions: ReviewAction[] = [
    {
      id: "leave",
      label: "leave native for now",
      enabled: true,
      hint: "safe fallback; no native files are changed"
    },
    {
      id: "repair-adopt-backup",
      label: "repair + adopt with backup",
      enabled: Boolean(repair),
      hint: repair
        ? `declare ${repair.declaredResources.length} resource file(s), copy into vault, and back up native`
        : "only available for mechanical frontmatter repairs",
      disabledReason: repair ? undefined : "no mechanical repair is available; manual fix required",
      safetyNote: "native copy is moved to <root>.bak before AutoVault writes managed links"
    },
    {
      id: "adopt-backup",
      label: "adopt with backup",
      enabled: canAdoptWithBackup(skill),
      hint: "copy native bytes into the vault and move original to <root>.bak",
      disabledReason: canAdoptWithBackup(skill) ? undefined : disabledAdoptReason(skill),
      safetyNote: "native copy is moved to <root>.bak before AutoVault writes managed links"
    },
    {
      id: "use-bundled",
      label: "use bundled",
      enabled: canUseBundled(skill),
      hint: "back up the native copy and keep the bundled AutoVault version",
      disabledReason: canUseBundled(skill) ? undefined : disabledBundledReason(skill),
      safetyNote: "native copy is moved to <root>.bak"
    }
  ];

  let recommendedAction: ReviewActionId = "leave";
  if (repair) {
    recommendedAction = "repair-adopt-backup";
  } else if (canUseBundled(skill)) {
    recommendedAction = "use-bundled";
  } else if (canAdoptWithBackup(skill)) {
    recommendedAction = "adopt-backup";
  }
  if (skill.native.length > 1 || skill.invalidReasons.length > 0) {
    recommendedAction = "leave";
  }

  return {
    skill,
    issues: buildIssues(skill),
    actions,
    recommendedAction,
    ...(repair ? { repair } : {})
  };
}

function formatSourceLine(label: string, hash: string, detail: string): string {
  return `      ${padEndVisible(label, 8)} ${shortHash(hash)} ${detail}`;
}

export function renderReviewPlan(
  plan: ReviewPlan,
  stream: NodeJS.WriteStream = process.stdout
): void {
  const theme = makeTheme(stream);
  const { skill } = plan;
  stream.write(`\n${badge("review", theme, "warn")} ${theme.style.bold(skill.name)} ${theme.style.dim(categoryLabel(skill))}\n`);
  if (skill.vault) stream.write(`${theme.style.dim(formatSourceLine("vault", skill.vault.hash, skill.vault.skillDir))}\n`);
  if (skill.bundled) {
    stream.write(`${theme.style.dim(formatSourceLine("bundled", skill.bundled.hash, skill.bundled.skillDir))}\n`);
  }
  for (const native of skill.native) {
    stream.write(`${theme.style.dim(formatSourceLine(native.agent ?? "native", native.hash, native.skillDir))}\n`);
    if (native.inferredAgents && native.inferredAgents.length > 0) {
      stream.write(`      ${theme.style.green(`${theme.symbol.check} inferred agent:`)} ${native.inferredAgents.join(", ")} ${theme.style.dim("from native root")}\n`);
    }
  }

  if (plan.issues.length > 0) {
    stream.write(`\n  ${theme.style.bold("Diagnosis")}\n`);
    for (const issue of plan.issues) {
      const mark = issue.severity === "error" ? theme.style.red(theme.symbol.warn) : theme.style.yellow(theme.symbol.warn);
      stream.write(`  ${mark} ${issue.kind.replace(/-/g, " ")}: ${issue.message}\n`);
      for (const affectedPath of issue.affectedPaths) {
        stream.write(`      ${theme.style.dim(affectedPath)}\n`);
      }
    }
  }

  const recommended = plan.actions.find((action) => action.id === plan.recommendedAction);
  if (recommended) {
    stream.write(`\n  ${theme.style.green("Recommended")} ${recommended.label}\n`);
    stream.write(`      ${theme.style.dim(recommended.hint)}\n`);
    if (plan.repair?.declaredResources.length) {
      stream.write(`      ${theme.style.dim(`will declare: ${plan.repair.declaredResources.join(", ")}`)}\n`);
    }
  }

  const unavailable = unavailableReviewActions(plan);
  if (unavailable.length > 0) {
    stream.write(`\n  ${theme.style.dim("Unavailable")}\n`);
    for (const action of unavailable) {
      stream.write(`      ${action.label.replace(" with backup", "")} unavailable: ${action.disabledReason ?? "not available"}\n`);
    }
  }
}
