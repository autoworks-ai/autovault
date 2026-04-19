import type { FetchedSkill } from "./types.js";

export async function fetchSkillFromUrl(
  identifier: string,
  options: { fetch?: typeof fetch } = {}
): Promise<FetchedSkill> {
  const fetcher = options.fetch ?? fetch;
  let url: URL;
  try {
    url = new URL(identifier);
  } catch {
    throw new Error(`Invalid URL identifier: ${identifier}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Only https URLs are supported (got ${url.protocol})`);
  }
  const response = await fetcher(url, { headers: { "User-Agent": "autovault" } });
  if (!response.ok) {
    throw new Error(`URL fetch failed: ${response.status} ${response.statusText} (${url})`);
  }
  const skillMd = await response.text();
  return { skillMd, sourceUrl: url.toString() };
}
