import { fetchSkillFromUrl } from "./url.js";
import type { FetchedSkill } from "./types.js";

const DEFAULT_BASE = "https://agentskills.io/api/v1";

function resolveUrl(identifier: string): string {
  const base = (process.env.AUTOVAULT_AGENTSKILLS_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
  const [slug, version] = identifier.split("@");
  if (!slug) throw new Error(`Invalid agentskills identifier: ${identifier}`);
  const versionPart = version ? `/${encodeURIComponent(version)}` : "";
  return `${base}/skills/${encodeURIComponent(slug)}${versionPart}/SKILL.md`;
}

export async function fetchSkillFromAgentSkills(
  identifier: string,
  options: { fetch?: typeof fetch } = {}
): Promise<FetchedSkill> {
  const url = resolveUrl(identifier);
  return fetchSkillFromUrl(url, options);
}
