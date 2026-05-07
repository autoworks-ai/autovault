import fs from "node:fs/promises";
import path from "node:path";

export type AuditRepoFormat = "json" | "markdown";

export type AuditClassification =
  | "stay-hub"
  | "vault-skill"
  | "vault-capability"
  | "thin-shim"
  | "split-first"
  | "deprecate";

export type AuditRisk = "low" | "medium" | "high";

export type SecretFinding = {
  path: string;
  key: string;
  kind: "env" | "json" | "inline";
};

export type AuditRepoItem = {
  path: string;
  kind: string;
  classification: AuditClassification;
  target: string;
  risk: AuditRisk;
  reasons: string[];
  redacted_findings?: SecretFinding[];
};

export type AuditRepoInput = {
  repo: string;
};

export type AuditRepoResult = {
  repo: string;
  item_count: number;
  generated_at: string;
  items: AuditRepoItem[];
};

const IGNORED_DIRS = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  "__pycache__"
]);

const AUDIT_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".json",
  ".md",
  ".sh",
  ".py",
  ".toml",
  ".yml",
  ".yaml",
  ".plist"
]);

const AUDIT_TOP_LEVELS = new Set([
  ".agents",
  "cloudflare-tunnel",
  "raycast",
  "scripts",
  "services",
  "tools",
  "workers",
  "workflows"
]);

const AUDIT_EXACT_FILES = new Set([
  "config/mcp-servers.json",
  "config/mcp-servers.example.json",
  "config/mcp-tools.json",
  "config/tool-filters.json",
  "package.json"
]);

const SECRET_NAME_RE = /(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|CREDENTIAL|AUTH|WEBHOOK[_-]?SECRET)/i;
const SECRET_VALUE_RE =
  /\b(?:sk_(?:live|test)_[A-Za-z0-9]{12,}|rk_(?:live|test)_[A-Za-z0-9]{12,}|xox[abp]-[A-Za-z0-9-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/;

const MIGRATION_TARGETS: Array<{
  target: string;
  classification: AuditClassification;
  patterns: RegExp[];
  reason: string;
}> = [
  {
    target: "autovault-capabilities",
    classification: "vault-capability",
    patterns: [
      /^config\/(?:tool-filters|mcp-tools|mcp-servers(?:\.example)?)\.json$/
    ],
    reason:
      "Capability ownership should move from repo JSON into the AutoVault SQLite index."
  },
  {
    target: "cloudflare-ops",
    classification: "vault-skill",
    patterns: [
      /(^|\/)(cloudflare-tunnel|workers\/)/,
      /scripts\/(?:deploy-pages-site|setup-cloudflare-d1|run-d1-|d1-|deploy-pi)/,
      /(^|\/)wrangler\.toml$/
    ],
    reason: "Cloudflare, D1, tunnel, and deploy helpers are reusable operator workflows."
  },
  {
    target: "raycast-autojack",
    classification: "vault-skill",
    patterns: [/^raycast\//, /scripts\/install-vl-convert/],
    reason: "Raycast install and desktop helper scripts should be packaged as a host setup skill."
  },
  {
    target: "mcp-registry-maintainer",
    classification: "vault-skill",
    patterns: [
      /scripts\/(?:scan-mcp-tools|monitor-mcp-health|setup-mcp-config|migrate-mcp-config|fix-mcp-npx|mcp-wrapper|sync-cursor-mcp)/,
      /(^|\/)config\/mcp-/
    ],
    reason: "MCP registry maintenance is reusable across agent hosts."
  },
  {
    target: "home-assistant-operator",
    classification: "vault-skill",
    patterns: [/home-assistant|scripts\/ha[-_]/],
    reason: "Home Assistant bootstrap, inventory, and verification are operator workflows."
  },
  {
    target: "autojack-blog-publisher",
    classification: "vault-skill",
    patterns: [/autojack-blog|github-release-announcement|evernote-note-formatter/],
    reason: "Publishing and webhook workflows belong with the AutoJack blog skill."
  },
  {
    target: "code-review",
    classification: "vault-skill",
    patterns: [/copilot-review|batch-fix|parallel-fix|agent-review|review:copilot/],
    reason: "Review and fix orchestration should be a reusable code-review capability."
  },
  {
    target: "voice-lab",
    classification: "split-first",
    patterns: [/voice|openwakeword|parakeet|wake-word|realtime-mcp-agent|pi-voice/],
    reason: "Voice tooling is large and should be split before vault packaging."
  }
];

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isAuditFile(filePath: string): boolean {
  return AUDIT_EXTENSIONS.has(path.extname(filePath));
}

function shouldEnterDirectory(root: string, dirPath: string): boolean {
  const relative = toPosix(path.relative(root, dirPath));
  if (!relative) return true;
  const [first] = relative.split("/");
  return AUDIT_TOP_LEVELS.has(first);
}

function shouldAuditRelative(relativePath: string): boolean {
  if (AUDIT_EXACT_FILES.has(relativePath)) return true;
  const [first] = relativePath.split("/");
  return AUDIT_TOP_LEVELS.has(first);
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!shouldEnterDirectory(root, abs)) continue;
      files.push(...await walk(root, abs));
      continue;
    }
    const relative = toPosix(path.relative(root, abs));
    if (entry.isFile() && isAuditFile(abs) && shouldAuditRelative(relative)) {
      files.push(relative);
    }
  }
  return files;
}

function classifyKind(relativePath: string): string {
  if (relativePath === "package.json") return "manifest";
  if (relativePath.startsWith("scripts/")) return "script";
  if (relativePath.startsWith("tools/")) return "mcp-tool";
  if (relativePath.startsWith("workflows/")) return "workflow";
  if (relativePath.startsWith("raycast/")) return "raycast";
  if (relativePath.startsWith("cloudflare-tunnel/")) return "cloudflare-tunnel";
  if (relativePath.startsWith("workers/")) return "worker";
  if (relativePath.startsWith("services/")) return "service";
  if (relativePath.startsWith("config/")) return "config";
  return "file";
}

function signalReasons(relativePath: string, content: string): string[] {
  const reasons: string[] = [];
  if (/process\.env|\$[A-Z_][A-Z0-9_]{2,}/.test(content)) {
    reasons.push("uses environment configuration");
  }
  if (/writeFile|appendFile|mkdir|unlink|rmSync|>\s/.test(content)) {
    reasons.push("writes files or local state");
  }
  if (/fetch\(|\bhttps?:\/\/|\bcurl\b|\bwrangler\b|\bcloudflared\b|\bgh\s+/.test(content)) {
    reasons.push("uses network or external service CLIs");
  }
  if (/mcp|MCP|mcpClient|toolGroups/.test(content)) {
    reasons.push("touches MCP capability surfaces");
  }
  if (/raycast|osascript|streamdeck|afplay|say\s/.test(content)) {
    reasons.push("integrates with host desktop UI");
  }
  if (relativePath.includes("_deprecated")) {
    reasons.push("already lives in a deprecated area");
  }
  return reasons;
}

function classifyPath(relativePath: string, content: string): {
  classification: AuditClassification;
  target: string;
  reasons: string[];
} {
  if (relativePath === "package.json") {
    return {
      classification: "stay-hub",
      target: "autohub-runtime",
      reasons: [
        "repo manifest stays in AutoHub; individual npm scripts are audited separately"
      ]
    };
  }

  if (relativePath.includes("_deprecated")) {
    return {
      classification: "deprecate",
      target: "none",
      reasons: ["deprecated artifact should be removed after replacement checks pass"]
    };
  }

  const haystack = `${relativePath}\n${content}`;
  for (const target of MIGRATION_TARGETS) {
    if (target.patterns.some((pattern) => pattern.test(haystack))) {
      return {
        classification: target.classification,
        target: target.target,
        reasons: [target.reason]
      };
    }
  }

  if (relativePath.startsWith("tools/") || relativePath.startsWith("src/")) {
    return {
      classification: "stay-hub",
      target: "autohub-runtime",
      reasons: ["runtime MCP/server code should remain in AutoHub"]
    };
  }

  return {
    classification: "stay-hub",
    target: "autohub",
    reasons: ["no reusable operator migration target detected"]
  };
}

function riskFor(reasons: string[], secretFindings: SecretFinding[]): AuditRisk {
  if (secretFindings.length > 0) return "high";
  if (
    reasons.some((reason) =>
      /network|external service|writes files|local state|desktop UI/.test(reason)
    )
  ) {
    return "medium";
  }
  return "low";
}

function collectSecretFindings(relativePath: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const processEnvMatch = line.match(
      /process\.env\.([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*)/i
    );
    if (processEnvMatch) {
      findings.push({
        path: `${relativePath}:${index + 1}`,
        key: processEnvMatch[1],
        kind: "env"
      });
    }
    const envMatch = line.match(/([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[:=]/i);
    if (envMatch) {
      findings.push({
        path: `${relativePath}:${index + 1}`,
        key: envMatch[1],
        kind: "env"
      });
    }
    if (SECRET_VALUE_RE.test(line)) {
      findings.push({
        path: `${relativePath}:${index + 1}`,
        key: "redacted-secret-shaped-value",
        kind: "inline"
      });
    }
  });

  if (relativePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content) as unknown;
      collectJsonSecretKeys(parsed, relativePath, findings);
    } catch {
      // Non-strict JSON is still covered by line scanning.
    }
  }
  return dedupeFindings(findings);
}

function collectJsonSecretKeys(
  value: unknown,
  prefix: string,
  findings: SecretFinding[]
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectJsonSecretKeys(item, `${prefix}[${index}]`, findings));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${prefix}.${key}`;
    if (SECRET_NAME_RE.test(key)) {
      findings.push({ path: childPath, key, kind: "json" });
    }
    if (typeof child === "string" && SECRET_VALUE_RE.test(child)) {
      findings.push({
        path: childPath,
        key: "redacted-secret-shaped-value",
        kind: "json"
      });
    }
    collectJsonSecretKeys(child, childPath, findings);
  }
}

function dedupeFindings(findings: SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.path}:${finding.key}:${finding.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shellWords(command: string): string[] {
  return Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g)).map(
    match => match[1] ?? match[2] ?? match[3] ?? match[4]
  );
}

function classifyAutovaultDelegation(command: string): {
  classification: AuditClassification;
  target: string;
  reasons: string[];
} | null {
  const words = shellWords(command);
  const shimIndex = words.findIndex(word => word.endsWith("autovault-shim.js"));
  if (shimIndex >= 0) {
    const args = words.slice(shimIndex + 1);
    if (args[0] === "--cli") {
      return {
        classification: "vault-capability",
        target: "autovault",
        reasons: [
          `npm script exposes AutoVault CLI capability ${args[1] ?? "command"}`
        ]
      };
    }

    if (args[0]) {
      return {
        classification: "thin-shim",
        target: args[0],
        reasons: ["npm script delegates to AutoVault skill execution"]
      };
    }
  }

  const autovaultIndex = words.findIndex(word => /(^|\/)autovault$/.test(word));
  if (autovaultIndex >= 0 && words[autovaultIndex + 1] === "skill") {
    const action = words[autovaultIndex + 2];
    const skill = words[autovaultIndex + 3];
    if (action && skill) {
      return {
        classification: "thin-shim",
        target: skill,
        reasons: ["npm script delegates to AutoVault skill execution"]
      };
    }
  }

  return null;
}

async function packageScriptItems(repo: string): Promise<AuditRepoItem[]> {
  const packagePath = path.join(repo, "package.json");
  let content: string;
  try {
    content = await fs.readFile(packagePath, "utf-8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
  const scripts = parsed.scripts ?? {};
  return Object.entries(scripts).map(([name, command]) => {
    const pseudoPath = `package.json#scripts.${name}`;
    const delegated = classifyAutovaultDelegation(command);
    const base = classifyPath(pseudoPath, command);
    const targetFromCommand = classifyPath(command, command);
    const classification =
      delegated?.classification ??
      (targetFromCommand.classification === "vault-skill" ||
      targetFromCommand.classification === "split-first"
        ? "thin-shim"
        : base.classification);
    const target =
      delegated?.target ??
      (classification === "thin-shim" ? targetFromCommand.target : base.target);
    const secretFindings = collectSecretFindings(pseudoPath, command);
    const reasons = delegated
      ? [...delegated.reasons, ...signalReasons(pseudoPath, command)]
      : [
          ...base.reasons,
          ...targetFromCommand.reasons,
          ...signalReasons(pseudoPath, command)
        ];
    const uniqueReasons = [...new Set(reasons)];
    return {
      path: pseudoPath,
      kind: "npm-script",
      classification,
      target,
      risk: riskFor(uniqueReasons, secretFindings),
      reasons: uniqueReasons,
      ...(secretFindings.length > 0 ? { redacted_findings: secretFindings } : {})
    };
  });
}

export async function auditRepo(input: AuditRepoInput): Promise<AuditRepoResult> {
  const repo = path.resolve(input.repo);
  const filePaths = await walk(repo);
  const items: AuditRepoItem[] = [];

  for (const relativePath of filePaths.sort()) {
    const abs = path.join(repo, relativePath);
    const content = await fs.readFile(abs, "utf-8");
    const base = classifyPath(relativePath, content);
    const secretFindings = collectSecretFindings(relativePath, content);
    const reasons = [...new Set([...base.reasons, ...signalReasons(relativePath, content)])];
    items.push({
      path: relativePath,
      kind: classifyKind(relativePath),
      classification: base.classification,
      target: base.target,
      risk: riskFor(reasons, secretFindings),
      reasons,
      ...(secretFindings.length > 0 ? { redacted_findings: secretFindings } : {})
    });
  }

  items.push(...await packageScriptItems(repo));
  items.sort((a, b) => a.path.localeCompare(b.path));

  return {
    repo,
    item_count: items.length,
    generated_at: new Date().toISOString(),
    items
  };
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function formatAuditRepoMarkdown(result: AuditRepoResult): string {
  const lines = [
    `# AutoVault Repo Audit`,
    "",
    `Repo: \`${result.repo}\``,
    `Items: ${result.item_count}`,
    "",
    "| Path | Kind | Classification | Target | Risk | Reasons |",
    "|---|---|---|---|---|---|"
  ];
  for (const item of result.items) {
    const reasons = [...item.reasons];
    if (item.redacted_findings?.length) {
      reasons.push(`${item.redacted_findings.length} redacted secret finding(s)`);
    }
    lines.push(
      [
        markdownCell(item.path),
        markdownCell(item.kind),
        markdownCell(item.classification),
        markdownCell(item.target),
        markdownCell(item.risk),
        markdownCell(reasons.join("; "))
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    );
  }
  return `${lines.join("\n")}\n`;
}
