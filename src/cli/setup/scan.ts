import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config.js";
import { collectLocalSkillBundle } from "../../installer/local.js";
import { discoverProfileRoots } from "../../profiles/discovery.js";
import { listInstalledSkillNames } from "../../storage/index.js";
import { skillDir } from "../../storage/index.js";
import { parseFrontmatter } from "../../validation/frontmatter.js";
import { validateSkillInput } from "../../validation/index.js";

export type DriftCategory =
  | "identical"
  | "vault-drift"
  | "bundled-drift"
  | "cross-host-drift"
  | "vault-only"
  | "native-only"
  | "bundled-only"
  | "invalid";

export type SkillSourceView = {
  origin: "vault" | "bundled" | "native";
  agent?: string;
  rootDir: string;
  skillDir: string;
  hash: string;
  description: string;
  validation?: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    securityFlags: string[];
  };
  loadError?: string;
};

export type SkillView = {
  name: string;
  category: DriftCategory;
  vault?: SkillSourceView;
  bundled?: SkillSourceView;
  native: SkillSourceView[];
  invalidReasons: string[];
};

export type DriftReport = {
  storagePath: string;
  bundledRoot: string;
  discovered: Record<string, string>;
  skills: SkillView[];
  totals: Record<DriftCategory, number>;
  hasFailingValidation: boolean;
};

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultBundledRoot(): string {
  // src/cli/setup/scan.ts → ../../../skills (when run from src/) or
  // dist/cli/setup/scan.js → ../../../skills (when run from dist/).
  return path.resolve(here, "..", "..", "..", "skills");
}

function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

async function readDescription(skillMd: string): Promise<string> {
  try {
    const { data } = parseFrontmatter(skillMd);
    const desc = (data as Record<string, unknown>).description;
    return typeof desc === "string" ? desc : "";
  } catch {
    return "";
  }
}

async function loadSourceView(
  origin: SkillSourceView["origin"],
  rootDir: string,
  name: string,
  agent?: string,
  options?: { runValidation?: boolean }
): Promise<SkillSourceView> {
  const target = path.join(rootDir, name);
  try {
    const bundle = await collectLocalSkillBundle(target);
    const validation = options?.runValidation
      ? validateSkillInput(bundle.skillMd, bundle.resources)
      : undefined;
    return {
      origin,
      agent,
      rootDir,
      skillDir: target,
      hash: hashContent(bundle.skillMd),
      description: await readDescription(bundle.skillMd),
      validation: validation
        ? {
            valid: validation.valid,
            errors: validation.errors,
            warnings: validation.warnings,
            securityFlags: validation.securityFlags
          }
        : undefined
    };
  } catch (error) {
    return {
      origin,
      agent,
      rootDir,
      skillDir: target,
      hash: "",
      description: "",
      loadError: String(error)
    };
  }
}

async function listSkillNamesInDir(rootDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function pickCategory(view: SkillView): DriftCategory {
  const native = view.native;
  const hasVault = Boolean(view.vault);
  const hasBundled = Boolean(view.bundled);
  const hasNative = native.length > 0;

  if (view.invalidReasons.length > 0 && !hasVault && !hasBundled) return "invalid";

  const nativeHashes = new Set(native.map((n) => n.hash).filter((h) => h.length > 0));
  if (nativeHashes.size > 1) return "cross-host-drift";

  if (hasNative && !hasVault && !hasBundled) return "native-only";
  if (!hasNative && hasVault && !hasBundled) return "vault-only";
  if (!hasNative && !hasVault && hasBundled) return "bundled-only";

  const nativeHash = native[0]?.hash;
  if (hasVault && hasNative && nativeHash && view.vault!.hash !== nativeHash) {
    return "vault-drift";
  }
  if (hasBundled && hasNative && nativeHash && view.bundled!.hash !== nativeHash) {
    return "bundled-drift";
  }
  if (hasVault && hasBundled && view.vault!.hash !== view.bundled!.hash) {
    return "vault-drift";
  }
  return "identical";
}

export type ScanInput = {
  bundledRoot?: string;
  profileRoots?: Record<string, string>;
  discover?: boolean;
};

export async function scanDrift(input: ScanInput = {}): Promise<DriftReport> {
  const config = loadConfig();
  const bundledRoot = input.bundledRoot ?? defaultBundledRoot();

  const discovered: Record<string, string> = input.discover
    ? await discoverProfileRoots()
    : {};
  const profileRoots = { ...discovered, ...(input.profileRoots ?? {}) };

  const vaultNames = await listInstalledSkillNames();
  const bundledNames = await listSkillNamesInDir(bundledRoot);
  const nativeListings: Array<{ agent: string; root: string; names: string[] }> = [];
  for (const [agent, root] of Object.entries(profileRoots)) {
    nativeListings.push({ agent, root, names: await listSkillNamesInDir(root) });
  }

  const allNames = new Set<string>();
  for (const name of vaultNames) allNames.add(name);
  for (const name of bundledNames) allNames.add(name);
  for (const listing of nativeListings) for (const name of listing.names) allNames.add(name);

  const skills: SkillView[] = [];
  for (const name of [...allNames].sort()) {
    const view: SkillView = {
      name,
      category: "identical",
      native: [],
      invalidReasons: []
    };

    if (vaultNames.includes(name)) {
      const vaultRoot = path.dirname(skillDir(name));
      view.vault = await loadSourceView("vault", vaultRoot, name);
      if (view.vault.loadError) {
        view.invalidReasons.push(`vault: ${view.vault.loadError}`);
        view.vault = undefined;
      }
    }

    if (bundledNames.includes(name)) {
      view.bundled = await loadSourceView("bundled", bundledRoot, name);
      if (view.bundled.loadError) {
        view.invalidReasons.push(`bundled: ${view.bundled.loadError}`);
        view.bundled = undefined;
      }
    }

    for (const listing of nativeListings) {
      if (!listing.names.includes(name)) continue;
      const native = await loadSourceView("native", listing.root, name, listing.agent, {
        runValidation: true
      });
      if (native.loadError) {
        view.invalidReasons.push(`${listing.agent}: ${native.loadError}`);
        continue;
      }
      view.native.push(native);
    }

    view.category = pickCategory(view);
    skills.push(view);
  }

  const totals: Record<DriftCategory, number> = {
    identical: 0,
    "vault-drift": 0,
    "bundled-drift": 0,
    "cross-host-drift": 0,
    "vault-only": 0,
    "native-only": 0,
    "bundled-only": 0,
    invalid: 0
  };
  let hasFailingValidation = false;
  for (const skill of skills) {
    totals[skill.category] += 1;
    for (const native of skill.native) {
      if (native.validation && !native.validation.valid) hasFailingValidation = true;
    }
  }

  return {
    storagePath: config.storagePath,
    bundledRoot,
    discovered,
    skills,
    totals,
    hasFailingValidation
  };
}

export function failingNativeSkills(report: DriftReport): SkillView[] {
  return report.skills.filter((skill) =>
    skill.native.some((native) => native.validation && !native.validation.valid)
  );
}

export function bundledNativeCollisions(report: DriftReport): SkillView[] {
  return report.skills.filter(
    (skill) =>
      skill.bundled !== undefined &&
      skill.native.length > 0 &&
      (skill.category === "bundled-drift" || skill.category === "vault-drift")
  );
}

export function adoptionCandidates(report: DriftReport): SkillView[] {
  return report.skills.filter(
    (skill) =>
      skill.native.length > 0 &&
      (skill.category === "native-only" ||
        skill.category === "vault-drift" ||
        skill.category === "bundled-drift" ||
        skill.category === "cross-host-drift")
  );
}
