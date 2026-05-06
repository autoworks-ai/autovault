import path from "node:path";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { canonicalRelPath } from "../util/path.js";
import {
  MAX_RESOURCE_BYTES,
  MAX_RESOURCES,
  MAX_SKILL_MD_BYTES,
  MAX_TOTAL_BYTES
} from "../util/limits.js";
import { assertContentLength, fetchWithDeadline, readBoundedText } from "../util/bounded-fetch.js";
import type { FetchedSkill, FetchedSkillResource } from "./types.js";

// Cap on the GitHub commit API JSON body. A typical commit JSON is a few KiB
// (sha + author + parents + message). 256 KiB matches the SKILL.md cap and
// is generous enough for huge commit messages while bounding the worst case
// where a degraded/malicious upstream returns headers and then streams
// forever or ships a multi-MiB JSON to exhaust memory before validation
// runs. Round-39 fix: closes the unbounded `response.json()` window in
// resolveSha that fetchWithDeadline (request-level only) didn't cover.
const MAX_GITHUB_API_BYTES = 256 * 1024;

// Repo-root/tree URL discovery can legitimately return more JSON than a
// single commit object, but it is still untrusted network input. Keep the
// tree body bounded and ask callers to narrow with a tree URL if GitHub
// truncates or the candidate set is too broad.
const MAX_GITHUB_TREE_API_BYTES = 5 * 1024 * 1024;
const MAX_GITHUB_SKILL_CANDIDATES = 50;

type GithubRepoRef = {
  owner: string;
  repo: string;
  ref: string;
};

type GithubIdentifier = GithubRepoRef & {
  filePath: string;
};

type GithubExactIdentifier = GithubIdentifier & {
  kind: "exact";
  resolvedIdentifier?: string;
  alternatives?: GithubExactAlternative[];
};

type GithubExactAlternative = GithubIdentifier & {
  resolvedIdentifier?: string;
};

type GithubDiscoveryIdentifier = GithubDiscoveryAlternative & {
  kind: "discovery";
  alternatives?: GithubDiscoveryAlternative[];
};

type GithubDiscoveryAlternative = GithubRepoRef & {
  scopePath?: string;
};

type GithubParsedIdentifier = GithubExactIdentifier | GithubDiscoveryIdentifier;

export type GitHubSkillCandidate = {
  name: string;
  description: string;
  path: string;
  identifier: string;
};

export class GitHubSkillCandidatesError extends Error {
  readonly candidates: GitHubSkillCandidate[];

  constructor(repo: string, candidates: GitHubSkillCandidate[]) {
    super(`Found ${candidates.length} skills in ${repo}; choose one to import.`);
    this.name = "GitHubSkillCandidatesError";
    this.candidates = candidates;
  }
}

export class GitHubSkillNotFoundError extends Error {
  constructor(repo: string, scopePath?: string) {
    super(`No SKILL.md found in ${repo}${scopePath ? ` under ${scopePath}` : ""}`);
    this.name = "GitHubSkillNotFoundError";
  }
}

export function isGitHubSkillCandidatesError(
  error: unknown
): error is GitHubSkillCandidatesError {
  return (
    error instanceof GitHubSkillCandidatesError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "GitHubSkillCandidatesError" &&
      Array.isArray((error as { candidates?: unknown }).candidates))
  );
}

export function isGitHubSkillNotFoundError(error: unknown): error is GitHubSkillNotFoundError {
  return (
    error instanceof GitHubSkillNotFoundError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "GitHubSkillNotFoundError")
  );
}

export function parseGithubIdentifier(identifier: string): GithubIdentifier {
  const parsed = parseGithubSourceIdentifier(identifier);
  if (parsed.kind !== "exact") {
    throw new Error(
      `Invalid GitHub identifier: ${identifier}. Expected owner/repo[@ref][:path/to/SKILL.md] or a GitHub blob URL.`
    );
  }
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    ref: parsed.ref,
    filePath: parsed.filePath
  };
}

function parseGithubSourceIdentifier(identifier: string): GithubParsedIdentifier {
  const trimmed = identifier.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return parseGithubUrlIdentifier(trimmed);
  }
  return parseCompactGithubIdentifier(trimmed);
}

function parseCompactGithubIdentifier(identifier: string): GithubExactIdentifier {
  const pathSep = identifier.indexOf(":");
  const repoPart = pathSep === -1 ? identifier : identifier.slice(0, pathSep);
  const pathPart = pathSep === -1 ? undefined : identifier.slice(pathSep + 1);
  const [ownerRepo, refRaw] = splitOnce(repoPart, "@");
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Invalid GitHub identifier: ${identifier}. Expected owner/repo[@ref][:path/to/SKILL.md]`
    );
  }
  return {
    kind: "exact",
    owner,
    repo,
    ref: refRaw && refRaw.length > 0 ? refRaw : "HEAD",
    filePath: pathPart && pathPart.length > 0 ? pathPart : "SKILL.md"
  };
}

function parseGithubUrlIdentifier(identifier: string): GithubParsedIdentifier {
  rejectEncodedDotSegments(identifier);
  let url: URL;
  try {
    url = new URL(identifier);
  } catch {
    throw new Error(`Invalid GitHub URL: ${identifier}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(
      `Invalid GitHub URL: ${identifier}. Expected an https://github.com/<owner>/<repo> URL.`
    );
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeGithubUrlSegment(segment));
  const [owner, repo, shape] = segments;
  if (!owner || !repo) {
    throw new Error(
      `Invalid GitHub URL: ${identifier}. Expected https://github.com/<owner>/<repo>.`
    );
  }

  if (!shape) {
    return { kind: "discovery", owner, repo, ref: "HEAD" };
  }

  if (shape === "blob") {
    const alternatives = buildBlobUrlAlternatives(owner, repo, segments.slice(3));
    if (alternatives.length === 0) {
      throw new Error(
        `Invalid GitHub blob URL: ${identifier}. Expected https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md.`
      );
    }
    const firstSegmentRef = alternatives.find(
      (candidate) => candidate.ref === segments[3] && candidate.filePath === segments.slice(4).join("/")
    );
    const selected = firstSegmentRef ?? alternatives[0];
    return {
      kind: "exact",
      owner,
      repo,
      ref: selected.ref,
      filePath: selected.filePath,
      resolvedIdentifier: selected.resolvedIdentifier,
      alternatives
    };
  }

  if (shape === "tree") {
    const alternatives = buildTreeUrlAlternatives(owner, repo, segments.slice(3));
    if (alternatives.length === 0) {
      throw new Error(
        `Invalid GitHub tree URL: ${identifier}. Expected https://github.com/<owner>/<repo>/tree/<ref>/<path?>.`
      );
    }
    const firstSegmentRef = alternatives.find(
      (candidate) =>
        candidate.ref === segments[3] &&
        (candidate.scopePath ?? "") === segments.slice(4).join("/")
    );
    const selected = firstSegmentRef ?? alternatives[0];
    return {
      kind: "discovery",
      owner,
      repo,
      ref: selected.ref,
      scopePath: selected.scopePath,
      alternatives
    };
  }

  throw new Error(
    `Invalid GitHub URL: ${identifier}. Expected a repo root, tree URL, or blob URL.`
  );
}

function buildBlobUrlAlternatives(
  owner: string,
  repo: string,
  tail: string[]
): GithubExactAlternative[] {
  const alternatives: GithubExactAlternative[] = [];
  for (let refLength = tail.length - 1; refLength >= 1; refLength -= 1) {
    const ref = tail.slice(0, refLength).join("/");
    const rawPath = tail.slice(refLength).join("/");
    if (!ref || !rawPath || !isSkillMarkdownPath(rawPath)) continue;
    const filePath = canonicalGithubFilePath("SKILL.md", rawPath);
    alternatives.push({
      owner,
      repo,
      ref,
      filePath,
      resolvedIdentifier: compactGithubIdentifier(owner, repo, ref, filePath)
    });
  }
  return alternatives;
}

function buildTreeUrlAlternatives(
  owner: string,
  repo: string,
  tail: string[]
): GithubDiscoveryAlternative[] {
  const alternatives: GithubDiscoveryAlternative[] = [];
  for (let refLength = tail.length; refLength >= 1; refLength -= 1) {
    const ref = tail.slice(0, refLength).join("/");
    if (!ref) continue;
    const rawScopePath = tail.slice(refLength).join("/");
    alternatives.push({
      owner,
      repo,
      ref,
      scopePath: rawScopePath
        ? canonicalGithubFilePath("tree scope", rawScopePath)
        : undefined
    });
  }
  return alternatives;
}

function rejectEncodedDotSegments(identifier: string): void {
  const pathOnly = identifier.split(/[?#]/, 1)[0];
  if (/(?:^|\/)(?:\.\.|%2e%2e|%2e\.|\.%2e)(?:\/|$)/i.test(pathOnly)) {
    throw new Error("Unsafe GitHub URL path segment: \"..\"");
  }
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const index = value.indexOf(sep);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + sep.length)];
}

function decodeGithubUrlSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error(`Invalid GitHub URL path segment: ${segment}`);
  }
  if (
    decoded.length === 0 ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\")
  ) {
    throw new Error(`Unsafe GitHub URL path segment: ${JSON.stringify(decoded)}`);
  }
  return decoded;
}

function isSkillMarkdownPath(filePath: string): boolean {
  return path.posix.basename(filePath).toLowerCase() === "skill.md";
}

function compactGithubIdentifier(owner: string, repo: string, ref: string, filePath: string): string {
  const repoRef = ref === "HEAD" ? `${owner}/${repo}` : `${owner}/${repo}@${ref}`;
  return `${repoRef}:${filePath}`;
}

// Round-42 fix: caller-controlled paths flowing into rawUrl() were trusted
// verbatim, so a `:../../other/main/SKILL.md` SKILL.md path or an
// `../../../etc/passwd` declared resource would let URL dot-segment
// normalization cross owner/repo/ref boundaries. The bytes would then come
// from a different upstream than the resolved SHA recorded in
// .autovault-source.json, breaking provenance and confusing check_updates.
// Canonicalize every caller-controlled segment before building any URL.
function canonicalGithubFilePath(label: string, raw: string): string {
  const canonical = canonicalRelPath(raw);
  if (canonical.length === 0) {
    throw new Error(
      `unsafe GitHub ${label} path: ${JSON.stringify(raw)} (absolute, traversal, or empty after normalization)`
    );
  }
  return canonical;
}

// URL-encode each segment so an exotic filename ("foo bar.md", "a%b.md")
// cannot decode into traversal or alter the path during fetch. The canonical
// form already has no `.`/`..` segments, so encoding is purely defense in
// depth against unicode/percent oddities.
function encodeGithubPath(canonical: string): string {
  return canonical
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function resolveSha(
  ident: GithubRepoRef,
  fetcher: typeof fetch,
  token?: string
): Promise<string | undefined> {
  if (ident.ref !== "HEAD" && /^[0-9a-f]{40}$/i.test(ident.ref)) {
    return ident.ref;
  }
  const ref = ident.ref === "HEAD" ? "" : ident.ref;
  // Round-44 fix: a branch like `feature/setup-bin` was being interpolated
  // raw, so the URL became `/commits/feature/setup-bin` and GitHub treated
  // the slash as path separators (404). encodeURIComponent on the single
  // ref segment keeps slashes/special chars intact as one path segment;
  // the API endpoint accepts the encoded form for branch and tag names.
  const refSegment = encodeURIComponent(ref || "HEAD");
  const url = `https://api.github.com/repos/${ident.owner}/${ident.repo}/commits/${refSegment}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "autovault"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchWithDeadline(fetcher, url, { headers }, url);
  if (!response.ok) return undefined;
  // Cap and time-bound the JSON body before parsing. response.json() is
  // unbounded — a server can ship headers and then stream forever or return
  // a multi-MiB body, which is the same DoS class that fetchWithDeadline
  // closes for the request handshake.
  assertContentLength(url, response.headers.get("content-length"), MAX_GITHUB_API_BYTES);
  const body = await readBoundedText(response, MAX_GITHUB_API_BYTES, url);
  let data: { sha?: string };
  try {
    data = JSON.parse(body) as { sha?: string };
  } catch {
    return undefined;
  }
  return typeof data.sha === "string" ? data.sha : undefined;
}

export async function fetchSkillFromGitHub(
  identifier: string,
  options: { fetch?: typeof fetch; token?: string } = {}
): Promise<FetchedSkill> {
  const fetcher = options.fetch ?? fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const parsed = parseGithubSourceIdentifier(identifier);

  if (parsed.kind === "discovery") {
    return fetchDiscoveredSkill(parsed, fetcher, token);
  }
  return fetchExactSkill(parsed, fetcher, token);
}

async function fetchDiscoveredSkill(
  ident: GithubDiscoveryIdentifier,
  fetcher: typeof fetch,
  token?: string
): Promise<FetchedSkill> {
  if (ident.alternatives && ident.alternatives.length > 0) {
    let lastError: unknown;
    for (const alternative of ident.alternatives) {
      try {
        return await fetchDiscoveredSkillOnce(alternative, fetcher, token);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return fetchDiscoveredSkillOnce(ident, fetcher, token);
}

async function fetchDiscoveredSkillOnce(
  ident: GithubDiscoveryAlternative,
  fetcher: typeof fetch,
  token?: string
): Promise<FetchedSkill> {
  const upstreamSha = await resolveSha(ident, fetcher, token);
  if (!upstreamSha) {
    throw new Error(
      `GitHub SHA resolution failed for ${ident.owner}/${ident.repo}@${ident.ref}; refusing to fetch from a mutable ref. Pin to a 40-char commit SHA.`
    );
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "autovault"
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const paths = await discoverSkillPaths({
    fetcher,
    headers,
    owner: ident.owner,
    repo: ident.repo,
    ref: upstreamSha,
    scopePath: ident.scopePath
  });
  if (paths.length === 0) {
    throw new GitHubSkillNotFoundError(`${ident.owner}/${ident.repo}`, ident.scopePath);
  }
  if (paths.length > MAX_GITHUB_SKILL_CANDIDATES) {
    throw new Error(
      `Found ${paths.length} skills in ${ident.owner}/${ident.repo}; narrow the import with a tree URL.`
    );
  }

  const candidates = await hydrateSkillCandidates({
    fetcher,
    headers,
    owner: ident.owner,
    repo: ident.repo,
    ref: upstreamSha,
    originalRef: ident.ref,
    paths
  });

  if (candidates.length > 1) {
    throw new GitHubSkillCandidatesError(`${ident.owner}/${ident.repo}`, candidates);
  }

  return fetchExactSkill(
    {
      kind: "exact",
      owner: ident.owner,
      repo: ident.repo,
      ref: ident.ref,
      filePath: candidates[0].path,
      resolvedIdentifier: candidates[0].identifier
    },
    fetcher,
    token,
    upstreamSha
  );
}

async function discoverSkillPaths(args: {
  fetcher: typeof fetch;
  headers: Record<string, string>;
  owner: string;
  repo: string;
  ref: string;
  scopePath?: string;
}): Promise<string[]> {
  const treeUrl = `https://api.github.com/repos/${args.owner}/${args.repo}/git/trees/${encodeURIComponent(
    args.ref
  )}?recursive=1`;
  const response = await fetchWithDeadline(args.fetcher, treeUrl, { headers: args.headers }, treeUrl);
  if (!response.ok) {
    throw new Error(`GitHub tree fetch failed: ${response.status} ${response.statusText} (${treeUrl})`);
  }
  assertContentLength(treeUrl, response.headers.get("content-length"), MAX_GITHUB_TREE_API_BYTES);
  const body = await readBoundedText(response, MAX_GITHUB_TREE_API_BYTES, treeUrl);
  let data: {
    tree?: Array<{ path?: string; type?: string }>;
    truncated?: boolean;
  };
  try {
    data = JSON.parse(body) as {
      tree?: Array<{ path?: string; type?: string }>;
      truncated?: boolean;
    };
  } catch {
    throw new Error(`GitHub tree fetch returned invalid JSON (${treeUrl})`);
  }
  if (data.truncated) {
    throw new Error(
      `GitHub tree listing for ${args.owner}/${args.repo} was truncated; import an exact SKILL.md identifier or blob URL instead of relying on a recursive tree listing.`
    );
  }
  if (!Array.isArray(data.tree)) return [];

  const scope = args.scopePath;
  const candidates = data.tree
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => canonicalGithubFilePath("tree entry", entry.path as string))
    .filter((entryPath) => {
      if (!isSkillMarkdownPath(entryPath)) return false;
      if (!scope) return true;
      return entryPath === scope || entryPath.startsWith(`${scope}/`);
    })
    .sort((a, b) => a.localeCompare(b));

  return candidates;
}

async function hydrateSkillCandidates(args: {
  fetcher: typeof fetch;
  headers: Record<string, string>;
  owner: string;
  repo: string;
  ref: string;
  originalRef: string;
  paths: string[];
}): Promise<GitHubSkillCandidate[]> {
  const candidates: GitHubSkillCandidate[] = [];
  for (const filePath of args.paths) {
    const url = rawUrl(args.owner, args.repo, args.ref, filePath);
    const response = await fetchWithDeadline(args.fetcher, url, { headers: args.headers }, url);
    if (!response.ok) {
      throw new Error(`GitHub candidate fetch failed: ${response.status} ${response.statusText} (${url})`);
    }
    assertContentLength(url, response.headers.get("content-length"), MAX_SKILL_MD_BYTES);
    const skillMd = await readBoundedText(response, MAX_SKILL_MD_BYTES, url);
    const metadata = candidateMetadata(skillMd, filePath);
    candidates.push({
      ...metadata,
      path: filePath,
      identifier: compactGithubIdentifier(args.owner, args.repo, args.originalRef, filePath)
    });
  }
  return candidates;
}

function candidateMetadata(
  skillMd: string,
  filePath: string
): Pick<GitHubSkillCandidate, "name" | "description"> {
  try {
    const { output: normalized } = attemptRepair(skillMd);
    const data = parseFrontmatter(normalized).data as Record<string, unknown>;
    return {
      name: typeof data.name === "string" ? data.name : fallbackCandidateName(filePath),
      description: typeof data.description === "string" ? data.description : ""
    };
  } catch {
    return { name: fallbackCandidateName(filePath), description: "" };
  }
}

function fallbackCandidateName(filePath: string): string {
  const dir = path.posix.basename(path.posix.dirname(filePath));
  return dir && dir !== "." ? dir : path.posix.basename(filePath, path.posix.extname(filePath));
}

async function fetchExactSkill(
  ident: GithubExactIdentifier,
  fetcher: typeof fetch,
  token?: string,
  resolvedSha?: string
): Promise<FetchedSkill> {
  if (!resolvedSha && ident.alternatives && ident.alternatives.length > 0) {
    let lastError: unknown;
    for (const alternative of ident.alternatives) {
      try {
        return await fetchExactSkillOnce(alternative, fetcher, token);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return fetchExactSkillOnce(ident, fetcher, token, resolvedSha);
}

async function fetchExactSkillOnce(
  ident: GithubExactAlternative,
  fetcher: typeof fetch,
  token?: string,
  resolvedSha?: string
): Promise<FetchedSkill> {
  // Canonicalize before SHA resolution so the cheapest reject (no network)
  // catches a hostile identifier; resolveSha is unaffected by filePath but
  // the early check fails fast and keeps the error class crisp.
  const skillFilePath = canonicalGithubFilePath("SKILL.md", ident.filePath);

  const upstreamSha = resolvedSha ?? (await resolveSha(ident, fetcher, token));
  if (!upstreamSha) {
    throw new Error(
      `GitHub SHA resolution failed for ${ident.owner}/${ident.repo}@${ident.ref}; refusing to fetch from a mutable ref. Pin to a 40-char commit SHA.`
    );
  }
  // Every fetch — SKILL.md and any declared resource — uses the resolved SHA so
  // they are guaranteed to come from one immutable commit. Falling back to the
  // named ref would let upstream move between fetches and ship a Frankenskill.
  const ref = upstreamSha;
  const headers: Record<string, string> = { "User-Agent": "autovault" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const skillUrl = rawUrl(ident.owner, ident.repo, ref, skillFilePath);
  const response = await fetchWithDeadline(fetcher, skillUrl, { headers }, skillUrl);
  if (!response.ok) {
    throw new Error(`GitHub fetch failed: ${response.status} ${response.statusText} (${skillUrl})`);
  }
  assertContentLength(skillUrl, response.headers.get("content-length"), MAX_SKILL_MD_BYTES);
  // Stream-bounded read so a missing or lying Content-Length cannot force
  // buffering past the cap before validation runs.
  const skillMd = await readBoundedText(response, MAX_SKILL_MD_BYTES, skillUrl);

  const resources = await fetchDeclaredResources({
    fetcher,
    headers,
    owner: ident.owner,
    repo: ident.repo,
    ref,
    skillFilePath,
    skillMd
  });

  return {
    skillMd,
    upstreamSha,
    sourceUrl: skillUrl,
    resolvedIdentifier: ident.resolvedIdentifier,
    resources
  };
}

// `filePath` here is already canonical (no `..`, no leading `/`, no empty
// segments); encodeGithubPath is a belt-and-suspenders pass that escapes
// per-segment so a filename containing spaces/percents/unicode cannot
// re-introduce path-shaped behavior in the URL.
function rawUrl(owner: string, repo: string, ref: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${encodeGithubPath(filePath)}`;
}

// Round-46 fix: dedup against the canonical form so spelling variants
// (`./bin/setup` vs `bin/setup`, or the same file referenced from both
// `resources[].path` and `bin.<action>.command`) collapse to one fetch and
// one resource entry. Raw-string dedup let benign skills become uninstallable
// because writeSkill canonicalizes downstream and the validator then rejected
// the duplicate canonical paths. Traversal/absolute paths still throw at
// enumeration time via canonicalGithubFilePath, preserving the round-42
// reject-before-fetch posture.
function declaredResourcePaths(skillMd: string): string[] {
  // Round-59 fix: parse against the repaired form so a SKILL.md with tabs or
  // trailing whitespace in its frontmatter — which install_skill silently
  // repairs via attemptRepair before validation — does not slip past resource
  // discovery and ship a half-installed skill (declared bin/resource files
  // never fetched). Mirroring the repair pass here keeps fetch-time
  // enumeration consistent with the bytes that install actually validates.
  let data: Record<string, unknown>;
  try {
    const { output: normalized } = attemptRepair(skillMd);
    data = parseFrontmatter(normalized).data;
  } catch {
    return [];
  }
  const paths = new Set<string>();
  if (Array.isArray(data.resources)) {
    for (const entry of data.resources) {
      if (entry && typeof entry === "object") {
        const p = (entry as Record<string, unknown>).path;
        if (typeof p === "string" && p.length > 0) {
          paths.add(canonicalGithubFilePath(`resource ${JSON.stringify(p)}`, p));
        }
      }
    }
  }
  if (data.bin && typeof data.bin === "object") {
    for (const [action, value] of Object.entries(data.bin as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const cmd = (value as Record<string, unknown>).command;
        if (typeof cmd === "string" && cmd.length > 0) {
          paths.add(canonicalGithubFilePath(`bin/${action} command ${JSON.stringify(cmd)}`, cmd));
        }
      }
    }
  }
  return Array.from(paths);
}

async function fetchDeclaredResources(args: {
  fetcher: typeof fetch;
  headers: Record<string, string>;
  owner: string;
  repo: string;
  ref: string;
  skillFilePath: string;
  skillMd: string;
}): Promise<FetchedSkillResource[]> {
  const declared = declaredResourcePaths(args.skillMd);
  if (declared.length === 0) return [];
  if (declared.length > MAX_RESOURCES) {
    throw new Error(
      `Declared resources exceed limit: ${declared.length} > ${MAX_RESOURCES}`
    );
  }
  const skillDirInRepo = path.posix.dirname(args.skillFilePath.replace(/\\/g, "/"));
  const results: FetchedSkillResource[] = [];
  let totalBytes = 0;
  for (const rel of declared) {
    // Canonicalize before joining with skillDirInRepo. A traversal segment
    // here is the same attack class as a traversal in the SKILL.md path —
    // path.posix.join would collapse `bin/setup` + `../../../etc/passwd`
    // into `../../etc/passwd` and rawUrl would happily build a URL whose
    // dot-segment normalization escapes the resolved SHA.
    const canonicalRel = canonicalGithubFilePath(`resource ${JSON.stringify(rel)}`, rel);
    const joined =
      skillDirInRepo === "" || skillDirInRepo === "."
        ? canonicalRel
        : path.posix.join(skillDirInRepo, canonicalRel);
    // Re-canonicalize after the join. skillDirInRepo is itself caller-derived
    // (it comes from the SKILL.md filePath we just canonicalized, but a
    // pathological combination could still surface a textual traversal).
    const repoPath = canonicalGithubFilePath(`resource ${JSON.stringify(rel)}`, joined);
    const url = rawUrl(args.owner, args.repo, args.ref, repoPath);
    const response = await fetchWithDeadline(args.fetcher, url, { headers: args.headers }, url);
    if (!response.ok) {
      throw new Error(
        `GitHub resource fetch failed: ${response.status} ${response.statusText} (${url})`
      );
    }
    assertContentLength(url, response.headers.get("content-length"), MAX_RESOURCE_BYTES);
    const content = await readBoundedText(response, MAX_RESOURCE_BYTES, url);
    totalBytes += Buffer.byteLength(content, "utf-8");
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `Total declared resource bytes exceeded: ${totalBytes} > ${MAX_TOTAL_BYTES}`
      );
    }
    // Emit the canonical path so downstream validation/storage sees one
    // stable form per declared file, regardless of how upstream spelled it.
    results.push({ path: canonicalRel, content });
  }
  return results;
}
