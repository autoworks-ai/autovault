import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { openCapabilityDb } from "../capabilities/db.js";
import { matchesAny } from "../capabilities/match.js";
import { resolveCapabilities } from "../capabilities/resolver.js";
import {
  listInstalledSkillNames,
  listInstalledSkillNamesUnlocked,
  readSkill,
  readSkillSummary,
  readSkillUnlocked
} from "../storage/index.js";
import { withStorageLock } from "../storage/lock.js";
import type { SkillSummary } from "../types.js";
import { hasScope, isOwner, remoteAuthContext } from "./auth.js";

type CheckUpdatesLike = {
  drifted: Array<{ name: string }>;
  up_to_date: string[];
  unchecked: Array<{ name: string }>;
  errors: Array<{ name: string }>;
  transform_reviews: Array<{ base: string }>;
};

type TransformListLike = {
  transforms?: Array<{ base?: string }>;
};

const WRITE_TOOLS = new Set([
  "add_skill",
  "update_skill",
  "delete_skill",
  "propose_skill",
]);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export function assertRemoteToolAllowed(toolName: string, authInfo: AuthInfo | undefined): void {
  if (isWriteTool(toolName) && !hasScope(authInfo, "autovault:write")) {
    throw new Error(`Permission denied: ${toolName} requires autovault:write`);
  }
  if (!hasScope(authInfo, "autovault:read")) {
    throw new Error(`Permission denied: ${toolName} requires autovault:read`);
  }
}

export async function filterSkillSummariesForAuth(
  summaries: SkillSummary[],
  authInfo: AuthInfo | undefined,
  query = ""
): Promise<SkillSummary[]> {
  if (isOwner(authInfo)) return summaries;
  const allowed = await allowedSkillNames(authInfo, query);
  return summaries.filter((summary) => allowed.has(summary.name));
}

export async function filterSearchResultsForAuth<T extends { name: string }>(
  matches: T[],
  authInfo: AuthInfo | undefined,
  query = ""
): Promise<T[]> {
  if (isOwner(authInfo)) return matches;
  const allowed = await allowedSkillNames(authInfo, query);
  return matches.filter((match) => allowed.has(match.name));
}

export async function filterCheckUpdatesForAuth<T extends CheckUpdatesLike>(
  result: T,
  authInfo: AuthInfo | undefined,
  query = ""
): Promise<T> {
  if (isOwner(authInfo)) return result;
  const allowed = await allowedSkillNames(authInfo, query);
  return {
    ...result,
    drifted: result.drifted.filter((entry) => allowed.has(entry.name)),
    up_to_date: result.up_to_date.filter((name) => allowed.has(name)),
    unchecked: result.unchecked.filter((entry) => allowed.has(entry.name)),
    errors: result.errors.filter((entry) => allowed.has(entry.name)),
    transform_reviews: result.transform_reviews.filter((entry) => allowed.has(entry.base))
  };
}

export async function filterSkillTransformsForAuth<T extends TransformListLike>(
  result: T,
  authInfo: AuthInfo | undefined,
  query = ""
): Promise<T> {
  if (isOwner(authInfo) || !Array.isArray(result.transforms)) return result;
  const allowed = await allowedSkillNames(authInfo, query);
  return {
    ...result,
    transforms: result.transforms.filter((entry) =>
      typeof entry.base === "string" && allowed.has(entry.base)
    )
  };
}

export async function assertCanReadSkill(
  name: string,
  authInfo: AuthInfo | undefined,
  query = name
): Promise<void> {
  if (isOwner(authInfo)) return;
  const allowed = await allowedSkillNames(authInfo, query);
  if (!allowed.has(name)) {
    throw new Error(`Permission denied: skill '${name}' is not available to this caller`);
  }
}

export async function allowedSkillNames(
  authInfo: AuthInfo | undefined,
  query = ""
): Promise<Set<string>> {
  const context = remoteAuthContext(authInfo);
  if (!context) return new Set();

  if (context.role === "owner") {
    return new Set(await listInstalledSkillNames());
  }

  const resolved = await resolveCapabilities({
    caller_id: context.caller_id,
    platform: "remote-mcp",
    query
  });
  const groups = resolved.matched_groups;
  const explicitSkillNames = skillNamesForGroups(groups);
  const allowedToolPatterns = resolved.tools.map((tool) => tool.pattern);
  const allowed = new Set<string>();

  await withStorageLock(async () => {
    for (const name of await listInstalledSkillNamesUnlocked()) {
      if (explicitSkillNames.has(name)) {
        allowed.add(name);
        continue;
      }
      const record = await readSkillUnlocked(name);
      if (!record) continue;
      if (skillToolsAllowed(record.capabilities.tools, allowedToolPatterns)) {
        allowed.add(name);
      }
    }
  });

  return allowed;
}

export async function readableSkillSummaries(
  authInfo: AuthInfo | undefined,
  query = ""
): Promise<SkillSummary[]> {
  const allowed = await allowedSkillNames(authInfo, query);
  const summaries: SkillSummary[] = [];
  for (const name of await listInstalledSkillNames()) {
    if (!isOwner(authInfo) && !allowed.has(name)) continue;
    const summary = await readSkillSummary(name);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

function skillNamesForGroups(groups: string[]): Set<string> {
  const names = new Set<string>();
  if (groups.length === 0) return names;
  const db = openCapabilityDb();
  const stmt = db.prepare("SELECT skill_name FROM group_skills WHERE group_name = ?");

  for (const group of groups) {
    for (const row of stmt.all(group) as Array<{ skill_name: string }>) {
      names.add(row.skill_name);
    }
  }
  return names;
}

function skillToolsAllowed(requiredTools: string[], allowedPatterns: string[]): boolean {
  if (requiredTools.length === 0) return true;
  if (allowedPatterns.length === 0) return false;
  return requiredTools.every((tool) => matchesAny(tool, allowedPatterns));
}
