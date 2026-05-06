import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listInstalledSkillNames,
  readSkill,
  readSkillSourceStatus,
  verifyInstalledIntegrity,
  type SkillSource
} from "../storage/index.js";
import { fetchSkillFromAgentSkills } from "../sources/agentskills.js";
import { fetchSkillFromGitHub } from "../sources/github.js";
import { fetchSkillFromUrl } from "../sources/url.js";
import type { FetchedSkill } from "../sources/types.js";
import { listTransformReviews, type TransformReview } from "../transforms/index.js";
import { bundleHash, type HashedResource } from "../util/hash.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { attemptRepair } from "../validation/frontmatter.js";

type DriftEntry = {
  name: string;
  source: SkillSource["source"];
  identifier: string;
  reason: string;
  upstreamSha?: string;
};

type UncheckedEntry = {
  name: string;
  source: SkillSource["source"];
  identifier: string;
  reason: string;
};

export type CheckUpdatesDeps = {
  fetchers?: {
    github?: typeof fetchSkillFromGitHub;
    agentskills?: typeof fetchSkillFromAgentSkills;
    url?: typeof fetchSkillFromUrl;
  };
  bundledSkillsDir?: string;
};

function defaultBundledSkillsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "skills");
}

async function readBundledInlineBundle(
  source: SkillSource,
  deps: CheckUpdatesDeps
): Promise<{ skillMd: string; resources: HashedResource[] } | null> {
  if (!source.bundledSkillName) return null;
  const bundledName = source.bundledSkillName;
  assertSafeSkillName(bundledName);
  const bundledRoot = deps.bundledSkillsDir ?? defaultBundledSkillsDir();
  const skillRoot = path.join(bundledRoot, bundledName);
  const raw = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf-8");
  const { output } = attemptRepair(raw);

  const resources: HashedResource[] = [];
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.name !== "SKILL.md" && !entry.name.startsWith(".autovault-")) {
        const content = await fs.readFile(abs, "utf-8");
        resources.push({ path: rel, content });
      }
    }
  }
  await walk(skillRoot, "");
  return { skillMd: output, resources };
}

async function fetchForSource(
  source: SkillSource,
  deps: CheckUpdatesDeps
): Promise<FetchedSkill | null> {
  switch (source.source) {
    case "github":
      return (deps.fetchers?.github ?? fetchSkillFromGitHub)(source.identifier);
    case "agentskills":
      return (deps.fetchers?.agentskills ?? fetchSkillFromAgentSkills)(source.identifier);
    case "url":
      return (deps.fetchers?.url ?? fetchSkillFromUrl)(source.identifier);
    case "inline":
      return null;
  }
}

export async function checkUpdates(
  skill?: string,
  deps: CheckUpdatesDeps = {}
): Promise<{
  drifted: DriftEntry[];
  up_to_date: string[];
  unchecked: UncheckedEntry[];
  errors: Array<{ name: string; error: string }>;
  transform_reviews: TransformReview[];
}> {
  if (skill !== undefined) assertSafeSkillName(skill);
  const names = skill ? [skill] : await listInstalledSkillNames();
  const drifted: DriftEntry[] = [];
  const upToDate: string[] = [];
  const unchecked: UncheckedEntry[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  const transformReviews: TransformReview[] = [];

  for (const name of names) {
    try {
      transformReviews.push(...await listTransformReviews(name));
    } catch (error) {
      errors.push({ name, error: `Transform review failed: ${String(error)}` });
    }

    const installed = await readSkill(name);
    if (!installed) {
      errors.push({ name, error: "Skill not installed" });
      continue;
    }
    // Round-55 fix: gate on local manifest integrity BEFORE trusting the
    // signed source.contentHash to declare up_to_date. The signed-source
    // check (round-54) closes contentHash/upstreamSha tampering in
    // source.json, but a local attacker who mutates SKILL.md or a signed
    // resource directly leaves source.json untouched. With matching
    // upstream bytes, check_updates would otherwise stamp the skill
    // up_to_date even though the live install is tampered. Recompute the
    // live integrity and bail with an error on any mismatch.
    const integrity = await verifyInstalledIntegrity(name);
    if (integrity.kind === "manifest_corrupt") {
      errors.push({ name, error: "Local manifest is corrupt; reinstall the skill" });
      continue;
    }
    if (integrity.kind === "tampered") {
      const detail = integrity.mismatches
        .map((m) => `${m.file} (${m.reason})`)
        .join(", ");
      errors.push({
        name,
        error: `Local integrity check failed: ${detail}; reinstall the skill`
      });
      continue;
    }
    // kind === "ok" or "no_manifest" (legacy installs pre-signing) fall
    // through. "no_manifest" preserves backward compat with installs that
    // predate the manifest writer; readSkill already logs on missing
    // manifest, so update-check stays usable.
    const sourceStatus = await readSkillSourceStatus(name);
    // Round-54: distinguish "no source recorded" from "source signature
    // invalid". A tampered source.json (manifest entry missing or
    // signature-mismatch) must surface as an actionable error rather than
    // the generic "No source metadata recorded" message — the latter hides
    // the integrity failure behind what looks like a hand-built install.
    if (sourceStatus.kind === "tampered") {
      errors.push({
        name,
        error: `Source metadata signature invalid (${sourceStatus.reason}); reinstall the skill`
      });
      continue;
    }
    if (sourceStatus.kind === "unparseable") {
      errors.push({ name, error: "Source metadata is unparseable; reinstall the skill" });
      continue;
    }
    if (sourceStatus.kind === "absent") {
      errors.push({ name, error: "No source metadata recorded" });
      continue;
    }
    if (sourceStatus.kind === "legacy") {
      // Round-56: legacy installs (pre-v1 manifest signing) carry a valid
      // detached SKILL.md signature but unsigned source.json. We can't
      // verify the source metadata without the manifest, so treating drift
      // results as authoritative would inherit a known integrity gap. Mark
      // unchecked with a clear reinstall path so the user can migrate when
      // they're ready, rather than seeing a hard tamper error on every
      // legitimate pre-upgrade install.
      unchecked.push({
        name,
        source: sourceStatus.source.source,
        identifier: sourceStatus.source.identifier,
        reason: "legacy install (pre-v1 manifest); reinstall the skill to enable update checks"
      });
      continue;
    }
    const source = sourceStatus.source;
    try {
      if (source.source === "inline") {
        const bundle = await readBundledInlineBundle(source, deps);
        if (!bundle) {
          unchecked.push({
            name,
            source: source.source,
            identifier: source.identifier,
            reason: "inline skill has no checkable upstream"
          });
          continue;
        }
        const bundledHash = bundleHash(bundle.skillMd, bundle.resources);
        if (bundledHash !== source.contentHash) {
          drifted.push({
            name,
            source: source.source,
            identifier: source.identifier,
            reason: "bundled content hash changed"
          });
        } else {
          upToDate.push(name);
        }
        continue;
      }

      const fetched = await fetchForSource(source, deps);
      if (!fetched) {
        unchecked.push({
          name,
          source: source.source,
          identifier: source.identifier,
          reason: "source has no checkable upstream"
        });
        continue;
      }
      // Round-53 fix: install_skill records contentHash from
      // bundleHash(normalizedSkillMd, resources) where normalizedSkillMd is the
      // output of attemptRepair (tabs → spaces, trailing whitespace stripped).
      // The bundled-inline path above already mirrors this. The remote path
      // previously hashed raw `fetched.skillMd`, so any GitHub/URL/agentskills
      // skill whose upstream SKILL.md needed repair would install fine but
      // permanently report `content hash changed` — drift output becomes noise
      // and users learn to ignore it. Apply attemptRepair before hashing so
      // install-time and check_updates-time hashes agree on a stable, repaired
      // form.
      const { output: normalizedUpstream } = attemptRepair(fetched.skillMd);
      const upstreamHash = bundleHash(normalizedUpstream, fetched.resources ?? []);
      if (
        upstreamHash !== source.contentHash ||
        (fetched.upstreamSha && source.upstreamSha && fetched.upstreamSha !== source.upstreamSha)
      ) {
        drifted.push({
          name,
          source: source.source,
          identifier: source.identifier,
          reason: upstreamHash !== source.contentHash ? "content hash changed" : "upstream sha changed",
          upstreamSha: fetched.upstreamSha
        });
      } else {
        upToDate.push(name);
      }
    } catch (error) {
      errors.push({ name, error: String(error) });
    }
  }

  return { drifted, up_to_date: upToDate, unchecked, errors, transform_reviews: transformReviews };
}
