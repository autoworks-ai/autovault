import { sayVault } from "../ui/animation.js";
import { renderSuccessOutro } from "../ui/brand.js";
import { badge, makeLogger, sectionTitle } from "../ui/messages.js";
import { keyValueRows } from "../ui/table.js";
import { startSpinner } from "../ui/tasks.js";
import { makeTheme, padEndVisible, type Theme } from "../ui/theme.js";
import { KNOWN_PROFILE_ROOTS } from "../../profiles/discovery.js";
import type { DriftCategory, DriftReport, SkillView } from "./scan.js";

export { makeLogger, startSpinner };

export type Colors = {
  bold: string;
  dim: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  reset: string;
};

const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m"
};

const PLAIN: Colors = {
  bold: "",
  dim: "",
  red: "",
  green: "",
  yellow: "",
  blue: "",
  magenta: "",
  cyan: "",
  reset: ""
};

export function colorsFor(stream: NodeJS.WriteStream): Colors {
  return makeTheme(stream).color ? ANSI : PLAIN;
}

const CATEGORY_LABEL: Record<DriftCategory, string> = {
  identical: "healthy",
  "vault-drift": "vault drift",
  "bundled-drift": "bundled drift",
  "cross-host-drift": "cross-host drift",
  "vault-only": "vault only",
  "native-only": "native only",
  "bundled-only": "bundled only",
  invalid: "unreadable"
};

const CATEGORY_ORDER: DriftCategory[] = [
  "vault-drift",
  "bundled-drift",
  "cross-host-drift",
  "native-only",
  "invalid",
  "vault-only",
  "bundled-only",
  "identical"
];

const REVIEW_DETAIL_LIMIT = 6;

function shortHash(hash: string): string {
  return hash ? hash.slice(0, 8) : "--------";
}

function categoryStatus(category: DriftCategory): "ok" | "warn" | "error" | "muted" {
  if (category === "identical") return "ok";
  if (category === "invalid") return "error";
  if (category === "vault-only" || category === "bundled-only") return "muted";
  return "warn";
}

function interestingSkills(report: DriftReport): SkillView[] {
  return report.skills.filter((skill) => {
    if (skill.category !== "identical" && skill.category !== "vault-only" && skill.category !== "bundled-only") {
      return true;
    }
    return skill.native.some((native) => native.validation && !native.validation.valid);
  });
}

export function reviewSkills(report: DriftReport): SkillView[] {
  return interestingSkills(report);
}

export function reviewReason(skill: SkillView): string {
  if (skill.native.some((native) => native.validation && !native.validation.valid)) {
    return "needs validation";
  }
  if (skill.invalidReasons.length > 0 || skill.category === "invalid") return "unreadable";
  if (skill.category === "native-only") return "native only";
  if (
    skill.category === "vault-drift" ||
    skill.category === "bundled-drift" ||
    skill.category === "cross-host-drift"
  ) {
    return "drift";
  }
  return CATEGORY_LABEL[skill.category];
}

export function reviewSummary(report: DriftReport): {
  total: number;
  ready: number;
  review: number;
  unreadable: number;
} {
  const review = reviewSkills(report).length;
  const unreadable = new Set(
    report.skills
      .filter((skill) => skill.category === "invalid" || skill.invalidReasons.length > 0)
      .map((skill) => skill.name)
  ).size;
  return {
    total: report.skills.length,
    ready: Math.max(0, report.skills.length - review),
    review,
    unreadable
  };
}

function formatSourceLine(theme: Theme, label: string, hash: string, detail: string): string {
  return `      ${theme.style.dim(padEndVisible(label, 8))} ${shortHash(hash)} ${theme.style.dim(detail)}`;
}

function renderSkillDetail(skill: SkillView, theme: Theme): string[] {
  const lines = [`  ${theme.style.bold(skill.name)} ${theme.style.dim(CATEGORY_LABEL[skill.category])}`];
  if (skill.vault) lines.push(formatSourceLine(theme, "vault", skill.vault.hash, skill.vault.skillDir));
  if (skill.bundled) {
    lines.push(formatSourceLine(theme, "bundled", skill.bundled.hash, skill.bundled.skillDir));
  }
  for (const native of skill.native) {
    lines.push(formatSourceLine(theme, native.agent ?? "native", native.hash, native.skillDir));
    if (native.validation && !native.validation.valid) {
      const reason =
        native.validation.errors[0] ??
        native.validation.securityFlags[0] ??
        "validation failed";
      lines.push(`      ${theme.style.red(`${theme.symbol.warn} fails validation:`)} ${reason}`);
    }
  }
  for (const reason of skill.invalidReasons) {
    lines.push(`      ${theme.style.red(`${theme.symbol.cross} ${reason}`)}`);
  }
  return lines;
}

export async function renderSetupIntro(stream: NodeJS.WriteStream = process.stdout): Promise<void> {
  await sayVault("Welcome to AutoVault. Let's validate, sign, and vault your skills.", stream);
}

export function renderDriftReport(
  report: DriftReport,
  stream: NodeJS.WriteStream = process.stdout
): void {
  const theme = makeTheme(stream);
  const profileCount = Object.keys(report.discovered).length;
  const reviewCount = interestingSkills(report).length;

  const rows = [
    { label: "storage", value: theme.style.dim(report.storagePath), status: "muted" as const },
    {
      label: "native roots",
      value: profileCount === 0 ? "none discovered" : String(profileCount),
      status: profileCount === 0 ? ("warn" as const) : ("ok" as const)
    },
    {
      label: "skills",
      value: `${report.skills.length} total`,
      status: report.skills.length === 0 ? ("muted" as const) : ("ok" as const)
    },
    {
      label: "needs review",
      value: reviewCount === 0 ? "nothing blocking" : `${reviewCount} skill(s)`,
      status: reviewCount === 0 ? ("ok" as const) : ("warn" as const)
    }
  ];

  const categoryRows = CATEGORY_ORDER.filter((category) => report.totals[category] > 0).map(
    (category) => ({
      label: CATEGORY_LABEL[category],
      value: String(report.totals[category]),
      status: categoryStatus(category)
    })
  );

  stream.write(`\n${sectionTitle("Vault intake", theme)}\n`);
  stream.write(`${keyValueRows(rows, theme)}\n`);
  if (categoryRows.length > 0) {
    stream.write(`\n${keyValueRows(categoryRows, theme)}\n`);
  }

  if (profileCount === 0) {
    stream.write(
      `\n  ${theme.style.yellow(theme.symbol.warn)} No native skill roots were discovered.\n`
    );
    stream.write(
      `  ${theme.style.dim(
        `checked: ${KNOWN_PROFILE_ROOTS.map((root) => `~/${root.root}`).join(", ")}`
      )}\n`
    );
    stream.write(
      `  ${theme.style.dim(
        `link manually: autovault sync-profiles --link codex="$HOME/.codex/skills"`
      )}\n`
    );
  } else {
    stream.write(`\n${badge("profiles", theme, "dim")} discovered native roots\n`);
    for (const [agent, root] of Object.entries(report.discovered)) {
      stream.write(`  ${theme.style.green(theme.symbol.check)} ${agent} ${theme.style.dim(root)}\n`);
    }
  }

  const details = interestingSkills(report);
  if (details.length > 0) {
    const shown = details.slice(0, REVIEW_DETAIL_LIMIT);
    const hidden = details.length - shown.length;
    stream.write(`\n${badge("review", theme, "warn")} skills that need a decision\n`);
    for (const skill of shown) {
      stream.write(`${renderSkillDetail(skill, theme).join("\n")}\n`);
    }
    if (hidden > 0) {
      stream.write(
        `  ${theme.style.dim(`+${hidden} more hidden here to keep setup readable.`)}\n`
      );
      stream.write(
        `  ${theme.style.dim("Run autovault setup --json for the full scan payload.")}\n`
      );
    }
  } else if (report.skills.length > 0) {
    const identical = report.skills.filter((skill) => skill.category === "identical");
    const names = identical.slice(0, 8).map((skill) => skill.name).join(", ");
    const suffix = identical.length > 8 ? `, +${identical.length - 8} more` : "";
    stream.write(`\n${theme.style.green(theme.symbol.check)} No conflicts or drift require a decision.\n`);
    if (names) stream.write(`  ${theme.style.dim(`${names}${suffix}`)}\n`);
  }
}

export function renderCompactScanSummary(
  report: DriftReport,
  stream: NodeJS.WriteStream = process.stdout
): void {
  const theme = makeTheme(stream);
  const summary = reviewSummary(report);
  const bits = [
    `${summary.total} found`,
    `${summary.ready} ready`,
    `${summary.review} need review`,
    `${summary.unreadable} unreadable`
  ];
  stream.write(`\n${badge("skills", theme)} ${bits.join(` ${theme.style.dim("·")} `)}\n`);
  const roots = Object.keys(report.discovered).length;
  if (roots > 0) {
    stream.write(`  ${theme.style.dim(`${roots} native root${roots === 1 ? "" : "s"} discovered`)}\n`);
  } else {
    stream.write(`  ${theme.style.dim("No native skill roots discovered.")}\n`);
  }
}

export function renderReviewSkill(
  skill: SkillView,
  stream: NodeJS.WriteStream = process.stdout
): void {
  const theme = makeTheme(stream);
  stream.write(`\n${badge("review", theme, "warn")} ${theme.style.bold(skill.name)} ${theme.style.dim(reviewReason(skill))}\n`);
  stream.write(`${renderSkillDetail(skill, theme).join("\n")}\n`);
}

export function renderFinalSummary(
  _report: DriftReport,
  applied: { name: string; action: string; ok: boolean; detail?: string }[],
  stream: NodeJS.WriteStream = process.stdout
): void {
  const theme = makeTheme(stream);
  stream.write(`\n${sectionTitle("Applied changes", theme)}\n`);
  if (applied.length === 0) {
    stream.write(`  ${theme.style.dim("No changes applied.")}\n`);
    return;
  }
  for (const entry of applied) {
    const mark = entry.ok ? theme.style.green(theme.symbol.check) : theme.style.red(theme.symbol.cross);
    const action = padEndVisible(entry.action, 18);
    const detail = entry.detail ? ` ${theme.style.dim(entry.detail)}` : "";
    stream.write(`  ${mark} ${action} ${entry.name}${detail}\n`);
  }
}

export function renderArt(
  stream: NodeJS.WriteStream = process.stdout,
  options: { reviewCount?: number } = {}
): void {
  const theme = makeTheme(stream);
  const next = [`${theme.style.dim("next")} autovault doctor`];
  if ((options.reviewCount ?? 0) > 0) {
    next.push(`${theme.style.dim("next")} autovault setup --review`);
  }
  stream.write(
    renderSuccessOutro(
      "Vault ready",
      next,
      stream
    )
  );
}
