import type { FetchedSkill } from "./types.js";

type GithubIdentifier = {
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
};

export function parseGithubIdentifier(identifier: string): GithubIdentifier {
  const [repoPart, pathPart] = identifier.split(":");
  const [ownerRepo, refRaw] = repoPart.split("@");
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Invalid GitHub identifier: ${identifier}. Expected owner/repo[@ref][:path/to/SKILL.md]`
    );
  }
  return {
    owner,
    repo,
    ref: refRaw && refRaw.length > 0 ? refRaw : "HEAD",
    filePath: pathPart && pathPart.length > 0 ? pathPart : "SKILL.md"
  };
}

async function resolveSha(
  ident: GithubIdentifier,
  fetcher: typeof fetch,
  token?: string
): Promise<string | undefined> {
  if (ident.ref !== "HEAD" && /^[0-9a-f]{40}$/i.test(ident.ref)) {
    return ident.ref;
  }
  const ref = ident.ref === "HEAD" ? "" : ident.ref;
  const url = `https://api.github.com/repos/${ident.owner}/${ident.repo}/commits/${ref || "HEAD"}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "autovault"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher(url, { headers });
  if (!response.ok) return undefined;
  const data = (await response.json()) as { sha?: string };
  return typeof data.sha === "string" ? data.sha : undefined;
}

export async function fetchSkillFromGitHub(
  identifier: string,
  options: { fetch?: typeof fetch; token?: string } = {}
): Promise<FetchedSkill> {
  const fetcher = options.fetch ?? fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const ident = parseGithubIdentifier(identifier);

  const upstreamSha = await resolveSha(ident, fetcher, token);
  const ref = upstreamSha ?? (ident.ref === "HEAD" ? "main" : ident.ref);
  const rawUrl = `https://raw.githubusercontent.com/${ident.owner}/${ident.repo}/${ref}/${ident.filePath}`;
  const headers: Record<string, string> = { "User-Agent": "autovault" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher(rawUrl, { headers });
  if (!response.ok) {
    throw new Error(`GitHub fetch failed: ${response.status} ${response.statusText} (${rawUrl})`);
  }
  const skillMd = await response.text();
  return { skillMd, upstreamSha, sourceUrl: rawUrl };
}
