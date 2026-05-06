import path from "node:path";
import { attemptRepair, parseFrontmatter } from "../validation/frontmatter.js";
import { canonicalRelPath } from "../util/path.js";
import {
  MAX_RESOURCE_BYTES,
  MAX_RESOURCES,
  MAX_SKILL_MD_BYTES,
  MAX_TOTAL_BYTES
} from "../util/limits.js";

// Cap on the GitHub commit API JSON body. A typical commit JSON is a few KiB
// (sha + author + parents + message). 256 KiB matches the SKILL.md cap and
// is generous enough for huge commit messages while bounding the worst case
// where a degraded/malicious upstream returns headers and then streams
// forever or ships a multi-MiB JSON to exhaust memory before validation
// runs. Round-39 fix: closes the unbounded `response.json()` window in
// resolveSha that fetchWithDeadline (request-level only) didn't cover.
const MAX_GITHUB_API_BYTES = 256 * 1024;
import { assertContentLength, fetchWithDeadline, readBoundedText } from "../util/bounded-fetch.js";
import type { FetchedSkill, FetchedSkillResource } from "./types.js";

type GithubIdentifier = {
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
};

export function parseGithubIdentifier(identifier: string): GithubIdentifier {
  const pathSep = identifier.indexOf(":");
  const repoPart = pathSep === -1 ? identifier : identifier.slice(0, pathSep);
  const pathPart = pathSep === -1 ? undefined : identifier.slice(pathSep + 1);
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
  ident: GithubIdentifier,
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
  const ident = parseGithubIdentifier(identifier);
  // Canonicalize before SHA resolution so the cheapest reject (no network)
  // catches a hostile identifier; resolveSha is unaffected by filePath but
  // the early check fails fast and keeps the error class crisp.
  const skillFilePath = canonicalGithubFilePath("SKILL.md", ident.filePath);

  const upstreamSha = await resolveSha(ident, fetcher, token);
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

  return { skillMd, upstreamSha, sourceUrl: skillUrl, resources };
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
