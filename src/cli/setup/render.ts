import type { DriftCategory, DriftReport, SkillView } from "./scan.js";

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

const ANSI: Colors = {
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
  if (process.env.NO_COLOR) return PLAIN;
  if (process.env.FORCE_COLOR) return ANSI;
  return stream.isTTY ? ANSI : PLAIN;
}

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  ok(message: string): void;
  raw(text: string): void;
};

export function makeLogger(stream: NodeJS.WriteStream = process.stdout): Logger {
  const c = colorsFor(stream);
  return {
    info: (m) => stream.write(`${c.bold}${c.dim}>${c.reset} ${m}\n`),
    warn: (m) => stream.write(`${c.yellow}!${c.reset} ${m}\n`),
    error: (m) => process.stderr.write(`${c.red}x${c.reset} ${m}\n`),
    ok: (m) => stream.write(`${c.green}✓${c.reset} ${m}\n`),
    raw: (t) => stream.write(t)
  };
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type Spinner = {
  stop(finalLine?: string): void;
  update(text: string): void;
};

export function startSpinner(initial: string, stream: NodeJS.WriteStream = process.stdout): Spinner {
  const c = colorsFor(stream);
  if (!stream.isTTY) {
    stream.write(`${c.bold}${c.dim}>${c.reset} ${initial}\n`);
    return {
      stop: (finalLine) => {
        if (finalLine) stream.write(`${c.green}✓${c.reset} ${finalLine}\n`);
      },
      update: (text) => stream.write(`${c.bold}${c.dim}>${c.reset} ${text}\n`)
    };
  }
  let frame = 0;
  let label = initial;
  const draw = () => {
    stream.write(`\r${c.cyan}${FRAMES[frame]}${c.reset} ${label}`);
    frame = (frame + 1) % FRAMES.length;
  };
  draw();
  const interval = setInterval(draw, 80);
  return {
    update: (text) => {
      label = text;
      // Clear the rest of the previous label by padding with spaces.
      stream.write(`\r${c.cyan}${FRAMES[frame]}${c.reset} ${label.padEnd(60)}`);
    },
    stop: (finalLine) => {
      clearInterval(interval);
      stream.write(`\r${" ".repeat(label.length + 4)}\r`);
      if (finalLine) stream.write(`${c.green}✓${c.reset} ${finalLine}\n`);
    }
  };
}

const CATEGORY_LABEL: Record<DriftCategory, string> = {
  identical: "identical",
  "vault-drift": "drift between vault and native",
  "bundled-drift": "drift between bundled and native",
  "cross-host-drift": "different versions across native roots",
  "vault-only": "in vault only",
  "native-only": "native only (not in vault)",
  "bundled-only": "bundled only",
  invalid: "could not be read"
};

const CATEGORY_ORDER: DriftCategory[] = [
  "vault-drift",
  "bundled-drift",
  "cross-host-drift",
  "native-only",
  "vault-only",
  "bundled-only",
  "invalid",
  "identical"
];

function shortHash(hash: string): string {
  return hash ? hash.slice(0, 8) : "—";
}

function formatNativeLines(skill: SkillView, c: Colors, indent: string): string[] {
  return skill.native.map(
    (native) =>
      `${indent}${c.dim}${native.agent}${c.reset}  ${shortHash(native.hash)}  ${c.dim}${native.skillDir}${c.reset}`
  );
}

export function renderDriftReport(
  report: DriftReport,
  stream: NodeJS.WriteStream = process.stdout
): void {
  const c = colorsFor(stream);
  const out: string[] = [];

  out.push("");
  out.push(`${c.bold}Drift report${c.reset}`);
  out.push("─".repeat(48));
  out.push(`storage: ${c.dim}${report.storagePath}${c.reset}`);
  if (Object.keys(report.discovered).length > 0) {
    for (const [agent, root] of Object.entries(report.discovered)) {
      out.push(`${c.green}✓${c.reset} ${agent} at ${c.dim}${root}${c.reset}`);
    }
  } else {
    out.push(`${c.dim}no native skill roots discovered${c.reset}`);
  }
  out.push("");

  for (const category of CATEGORY_ORDER) {
    const skills = report.skills.filter((s) => s.category === category);
    if (skills.length === 0) continue;
    const color =
      category === "identical"
        ? c.green
        : category === "vault-only" || category === "bundled-only"
          ? c.dim
          : category === "invalid"
            ? c.red
            : c.yellow;
    out.push(`${color}${CATEGORY_LABEL[category]} (${skills.length})${c.reset}`);

    if (category === "identical") {
      const names = skills.map((s) => s.name).join(", ");
      out.push(`  ${c.dim}${names}${c.reset}`);
      out.push("");
      continue;
    }

    for (const skill of skills) {
      out.push(`  ${c.bold}${skill.name}${c.reset}`);
      if (skill.vault) {
        out.push(`    ${c.dim}vault   ${shortHash(skill.vault.hash)}${c.reset}`);
      }
      if (skill.bundled) {
        out.push(`    ${c.dim}bundled ${shortHash(skill.bundled.hash)}${c.reset}`);
      }
      out.push(...formatNativeLines(skill, c, "    "));
      const failingNative = skill.native.find(
        (native) => native.validation && !native.validation.valid
      );
      if (failingNative) {
        const reason =
          failingNative.validation?.errors[0] ??
          failingNative.validation?.securityFlags[0] ??
          "validation failed";
        out.push(`    ${c.red}⚠ would fail vault validation: ${reason}${c.reset}`);
      }
      if (skill.invalidReasons.length > 0) {
        for (const reason of skill.invalidReasons) {
          out.push(`    ${c.red}✗ ${reason}${c.reset}`);
        }
      }
    }
    out.push("");
  }

  stream.write(out.join("\n") + "\n");
}

export function renderFinalSummary(
  report: DriftReport,
  applied: { name: string; action: string; ok: boolean; detail?: string }[],
  stream: NodeJS.WriteStream = process.stdout
): void {
  const c = colorsFor(stream);
  stream.write(`\n${c.bold}Summary${c.reset}\n`);
  stream.write("─".repeat(48) + "\n");
  if (applied.length === 0) {
    stream.write(`${c.dim}no changes applied${c.reset}\n`);
    return;
  }
  for (const entry of applied) {
    const mark = entry.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const detail = entry.detail ? `  ${c.dim}${entry.detail}${c.reset}` : "";
    stream.write(`  ${mark} ${entry.action.padEnd(18)} ${entry.name}${detail}\n`);
  }
}

export function renderArt(stream: NodeJS.WriteStream = process.stdout): void {
  const c = colorsFor(stream);
  const art = `
${c.cyan}    ╔═══════════════════════════════════╗${c.reset}
${c.cyan}    ║${c.reset}  ${c.bold}AutoVault${c.reset} ${c.dim}— skill safe deposit${c.reset}    ${c.cyan}║${c.reset}
${c.cyan}    ║${c.reset}  ${c.green}vault locked, key in your hand${c.reset}   ${c.cyan}║${c.reset}
${c.cyan}    ╚═══════════════════════════════════╝${c.reset}
`;
  stream.write(art);
}
