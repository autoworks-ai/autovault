import { canonicalRelPath } from "../util/path.js";

function canonicalizeForCompare(p: string): string {
  return canonicalRelPath(p);
}

// Extract canonical paths for every declared bin command so the shebang scan
// only fires on resources the CLI will actually exec. Reading directly from
// `frontmatter.bin` keeps this independent of the storage layer's stricter
// SkillBinAction parser — capability validation runs before installation, on
// raw frontmatter that may still have soft errors elsewhere.
function collectBinPaths(frontmatter: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();
  const bin = frontmatter.bin;
  if (typeof bin !== "object" || bin === null) return paths;
  for (const entry of Object.values(bin as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const command = (entry as Record<string, unknown>).command;
    if (typeof command !== "string" || command.length === 0) continue;
    const canonical = canonicalizeForCompare(command);
    if (canonical.length > 0) paths.add(canonical);
  }
  return paths;
}

const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\s+[^|]/i,
  /\bwget\s+/i,
  /\bfetch\s*\(/i,
  /\bhttps?\.(?:get|request|post|put)\s*\(/i,
  /\baxios\./i
];

const NON_BASH_INTERPRETERS: RegExp[] = [
  /(?:^|\s|`)python3?\s+\S/i,
  /(?:^|\s|`)node\s+\S/i,
  /(?:^|\s|`)ruby\s+\S/i,
  /(?:^|\s|`)perl\s+\S/i,
  /(?:^|\s|`)php\s+\S/i
];

// Shebang interpreters that, in a declared bin resource, mean the actual
// runtime is non-Bash even when the body contains no `node script.js`-style
// command. The CLI execs bin files directly via spawn(target), so the
// shebang controls what kernel-side `execve` resolves the interpreter to —
// a skill claiming `tools: [Bash]` that ships `#!/usr/bin/env node` is
// misrepresenting its runtime at the user-trigger boundary. Scanning bodies
// for `node arg` misses this because a pure-JS bin/setup needs no shell
// invocation. Pattern matches both `#!/usr/bin/env <interp>` (the portable
// idiom) and `#!/usr/bin/<interp>`/`#!/usr/local/bin/<interp>` (older form).
const NON_BASH_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/(?:local\/)?)?bin\/)?(python3?|node|nodejs|ruby|perl|php)\b/i;

const EXTERNAL_WRITE_PATTERNS: RegExp[] = [
  />\s*~\/[^\s)"`]/,
  />>\s*~\/[^\s)"`]/,
  />\s*\/etc\//,
  />>\s*\/etc\//,
  />\s*\/tmp\//,
  />>\s*\/tmp\//
];

function matchesAny(content: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}

function asToolSet(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tools = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase());
  return tools.length > 0 ? tools : null;
}

// Capability cross-check covers the WHOLE bundle: SKILL.md *and* every
// bundled resource (bin scripts, helper scripts, references). A skill that
// declares `network: false` while shipping a `bin/setup` that calls `curl` is
// understating what the user is asked to run. Treating capabilities as an
// upper-bound on the whole bundle keeps the metadata honest — the alternative
// (scope-to-SKILL.md-only) was too easy to mislead users with once bin
// scripts became a thing.
export function checkCapabilityDeclaration(
  content: string,
  frontmatter: Record<string, unknown>,
  resources: Array<{ path: string; content: string }> = []
): string[] {
  const flags: string[] = [];
  const capsRaw = frontmatter.capabilities;
  if (typeof capsRaw !== "object" || capsRaw === null) return flags;
  const caps = capsRaw as Record<string, unknown>;

  type Source = { label: string; body: string };
  const sources: Source[] = [{ label: "SKILL.md", body: content }];
  for (const resource of resources) {
    sources.push({ label: resource.path, body: resource.content });
  }

  if (caps.network === false) {
    for (const source of sources) {
      if (matchesAny(source.body, NETWORK_PATTERNS)) {
        flags.push(
          `Capability mismatch: capabilities.network=false but network call detected in ${source.label}`
        );
      }
    }
  }

  const tools = asToolSet(caps.tools);
  if (tools && tools.includes("bash") && tools.length === 1) {
    for (const source of sources) {
      if (matchesAny(source.body, NON_BASH_INTERPRETERS)) {
        flags.push(
          `Capability mismatch: capabilities.tools=[Bash] but non-Bash interpreter usage detected in ${source.label}`
        );
      }
    }
    // Bin resources are spawned directly — the shebang IS the interpreter
    // selection at exec time. A pure-JS bin/setup with `#!/usr/bin/env node`
    // never appears as `node arg` in the body, so the body scan above misses
    // it. Cross-check shebangs of declared bin commands against the Bash-only
    // claim. Resources not declared as bin commands aren't subject to direct
    // exec, so a non-bin helper script with a python shebang is fine.
    const binPaths = collectBinPaths(frontmatter);
    if (binPaths.size > 0) {
      for (const resource of resources) {
        if (!binPaths.has(canonicalizeForCompare(resource.path))) continue;
        const firstLine = resource.content.split(/\r?\n/, 1)[0] ?? "";
        const match = firstLine.match(NON_BASH_SHEBANG);
        if (match) {
          flags.push(
            `Capability mismatch: capabilities.tools=[Bash] but ${resource.path} declares a ${match[1]} shebang (${firstLine.trim()})`
          );
        }
      }
    }
  }

  if (caps.filesystem === "readonly") {
    for (const source of sources) {
      if (matchesAny(source.body, EXTERNAL_WRITE_PATTERNS)) {
        flags.push(
          `Capability mismatch: capabilities.filesystem=readonly but external write detected in ${source.label}`
        );
      }
    }
  }

  return flags;
}
