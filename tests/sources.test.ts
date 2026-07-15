import { describe, expect, it, vi } from "vitest";
import {
  fetchSkillFromGitHub,
  GitHubSkillCandidatesError,
  parseGithubIdentifier
} from "../src/sources/github.js";
import { fetchSkillFromAgentSkills } from "../src/sources/agentskills.js";
import { fetchSkillFromUrl } from "../src/sources/url.js";

function makeResponse(
  body: string,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {}
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
    headers: {
      get: (name: string) => init.headers?.[name.toLowerCase()] ?? init.headers?.[name] ?? null
    },
    text: async () => body,
    json: async () => JSON.parse(body)
  } as unknown as Response;
}

function requestUrl(input: string | URL): URL {
  return input instanceof URL ? input : new URL(input);
}

function isGitHubApiPath(input: string | URL, prefix: string): boolean {
  const url = requestUrl(input);
  return url.hostname === "api.github.com" && url.pathname.startsWith(prefix);
}

function isGitHubApiExactPath(input: string | URL, path: string): boolean {
  const url = requestUrl(input);
  return url.hostname === "api.github.com" && url.pathname === path;
}

function isRawGitHubPath(input: string | URL, suffix: string): boolean {
  const url = requestUrl(input);
  return url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith(suffix);
}

describe("github source", () => {
  it("parses owner/repo[@ref][:path]", () => {
    expect(parseGithubIdentifier("owner/repo")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "HEAD",
      filePath: "SKILL.md"
    });
    expect(parseGithubIdentifier("owner/repo@v1:skills/foo/SKILL.md")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "v1",
      filePath: "skills/foo/SKILL.md"
    });
    expect(parseGithubIdentifier("owner/repo@v1:skills/foo:name/SKILL.md")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "v1",
      filePath: "skills/foo:name/SKILL.md"
    });
    expect(parseGithubIdentifier("owner/repo@v1:skills/foo")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "v1",
      filePath: "skills/foo/SKILL.md"
    });
  });

  it("parses GitHub blob URLs as exact skill targets", () => {
    expect(
      parseGithubIdentifier("https://github.com/owner/repo/blob/main/skills/foo/SKILL.md")
    ).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "main",
      filePath: "skills/foo/SKILL.md"
    });
    expect(
      parseGithubIdentifier("https://github.com/owner/repo/blob/main/skills/foo")
    ).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "main",
      filePath: "skills/foo/SKILL.md"
    });
  });

  it("rejects malformed identifiers", () => {
    expect(() => parseGithubIdentifier("nope")).toThrow();
  });

  it("rejects non-GitHub URLs before network I/O", async () => {
    const fetcher = vi.fn(async () => makeResponse("never reached")) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("https://raw.githubusercontent.com/owner/repo/main/SKILL.md", {
        fetch: fetcher
      })
    ).rejects.toThrow(/github\.com/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects traversal in GitHub blob URLs before network I/O", async () => {
    const fetcher = vi.fn(async () => makeResponse("never reached")) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("https://github.com/owner/repo/blob/main/skills/%2E%2E/SKILL.md", {
        fetch: fetcher
      })
    ).rejects.toThrow(/Unsafe GitHub URL path segment/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches raw content using a resolved sha", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          tree: [{ path: "SKILL.md", type: "blob", mode: "100644" }]
        }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1234567890abcdef1234567890abcdef12345678" }));
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("owner/repo", { fetch: fetcher });
    expect(result.upstreamSha).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(result.sourceUrl).toContain("raw.githubusercontent.com");
  });

  it("fetches blob URL content pinned to the resolved sha", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (u.endsWith("/commits/main")) {
        return makeResponse(JSON.stringify({ sha: "1234567890abcdef1234567890abcdef12345678" }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          tree: [{ path: "skills/foo/SKILL.md", type: "blob", mode: "100644" }]
        }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse("not found", { ok: false, status: 404 });
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub(
      "https://github.com/owner/repo/blob/main/skills/foo/SKILL.md",
      { fetch: fetcher }
    );
    const raw = requested.find((u) => u.includes("raw.githubusercontent.com"));
    expect(raw).toContain("/1234567890abcdef1234567890abcdef12345678/skills/foo/SKILL.md");
    expect(raw).not.toContain("/main/skills/foo/SKILL.md");
    expect(result.resolvedIdentifier).toBe("owner/repo@main:skills/foo/SKILL.md");
  });

  it("fetches GitHub directory identifiers by appending SKILL.md", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          tree: [{ path: "skills/foo/SKILL.md", type: "blob", mode: "100644" }]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: x\n---\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const compact = await fetchSkillFromGitHub("owner/repo:skills/foo", { fetch: fetcher });
    const blob = await fetchSkillFromGitHub(
      "https://github.com/owner/repo/blob/main/skills/foo",
      { fetch: fetcher }
    );

    expect(compact.sourceUrl).toContain("/skills/foo/SKILL.md");
    expect(blob.sourceUrl).toContain("/skills/foo/SKILL.md");
    expect(blob.resolvedIdentifier).toBe("owner/repo@main:skills/foo/SKILL.md");
    expect(requested.some((u) => isRawGitHubPath(u, "/skills/foo"))).toBe(false);
  });

  it("resolves GitHub blob URLs whose branch names contain slashes", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiExactPath(url, "/repos/owner/repo/commits/feature%2Fskill-import")) {
        return makeResponse(JSON.stringify({ sha: "3".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          tree: [{ path: "skills/foo/SKILL.md", type: "blob", mode: "100644" }]
        }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/")) {
        return makeResponse("not found", { ok: false, status: 404 });
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: x\n---\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub(
      "https://github.com/owner/repo/blob/feature/skill-import/skills/foo/SKILL.md",
      { fetch: fetcher }
    );
    expect(result.upstreamSha).toBe("3".repeat(40));
    expect(result.resolvedIdentifier).toBe(
      "owner/repo@feature/skill-import:skills/foo/SKILL.md"
    );
    expect(
      requested.some((u) =>
        isGitHubApiExactPath(u, "/repos/owner/repo/commits/feature%2Fskill-import")
      )
    ).toBe(true);
  });

  it("discovers one SKILL.md from a GitHub repo-root URL and auto-selects it", async () => {
    const skillMd = `---
name: discovered-skill
description: This description is intentionally long enough to satisfy schema length checks.
---

# Body
`;
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/HEAD")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(
          JSON.stringify({ tree: [{ path: "skills/foo/SKILL.md", type: "blob" }] })
        );
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse(skillMd);
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("https://github.com/owner/repo", {
      fetch: fetcher
    });
    expect(result.skillMd).toBe(skillMd);
    expect(result.upstreamSha).toBe("1".repeat(40));
    expect(result.resolvedIdentifier).toBe("owner/repo:skills/foo/SKILL.md");
    expect(
      requested.some((u) =>
        isGitHubApiPath(u, `/repos/owner/repo/git/trees/${"1".repeat(40)}`)
      )
    ).toBe(true);
  });

  it("returns candidate metadata when repo-root discovery finds multiple skills", async () => {
    const skillA = `---
name: alpha-skill
description: Alpha skill description long enough for display.
---

# Alpha
`;
    const skillB = `---
name: beta-skill
description: Beta skill description long enough for display.
---

# Beta
`;
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/HEAD")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(
          JSON.stringify({
            tree: [
              { path: "skills/b/SKILL.md", type: "blob" },
              { path: "skills/a/SKILL.md", type: "blob" }
            ]
          })
        );
      }
      if (isRawGitHubPath(url, "/skills/a/SKILL.md")) return makeResponse(skillA);
      if (isRawGitHubPath(url, "/skills/b/SKILL.md")) return makeResponse(skillB);
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    try {
      await fetchSkillFromGitHub("https://github.com/owner/repo", { fetch: fetcher });
      throw new Error("expected candidates error");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubSkillCandidatesError);
      expect((error as GitHubSkillCandidatesError).candidates).toEqual([
        {
          name: "alpha-skill",
          description: "Alpha skill description long enough for display.",
          path: "skills/a/SKILL.md",
          identifier: "owner/repo:skills/a/SKILL.md"
        },
        {
          name: "beta-skill",
          description: "Beta skill description long enough for display.",
          path: "skills/b/SKILL.md",
          identifier: "owner/repo:skills/b/SKILL.md"
        }
      ]);
    }
  });

  it("scopes tree URL discovery and accepts lowercase skill.md", async () => {
    const skillMd = `---
name: scoped-skill
description: This description is intentionally long enough to satisfy schema length checks.
---

# Body
`;
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/main")) {
        return makeResponse(JSON.stringify({ sha: "2".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(
          JSON.stringify({
            tree: [
              { path: "other/SKILL.md", type: "blob" },
              { path: "skills/nested/skill.md", type: "blob" }
            ]
          })
        );
      }
      if (isRawGitHubPath(url, "/skills/nested/skill.md")) {
        return makeResponse(skillMd);
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub(
      "https://github.com/owner/repo/tree/main/skills/nested",
      { fetch: fetcher }
    );
    expect(result.skillMd).toBe(skillMd);
    expect(result.resolvedIdentifier).toBe("owner/repo@main:skills/nested/skill.md");
  });

  it("resolves GitHub tree URLs whose branch names contain slashes", async () => {
    const skillMd = `---
name: slash-branch-skill
description: This description is intentionally long enough to satisfy schema length checks.
---

# Body
`;
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiExactPath(url, "/repos/owner/repo/commits/feature%2Fskill-import")) {
        return makeResponse(JSON.stringify({ sha: "4".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse("not found", { ok: false, status: 404 });
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(
          JSON.stringify({
            tree: [{ path: "skills/nested/SKILL.md", type: "blob" }]
          })
        );
      }
      if (isRawGitHubPath(url, "/skills/nested/SKILL.md")) {
        return makeResponse(skillMd);
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub(
      "https://github.com/owner/repo/tree/feature/skill-import/skills/nested",
      { fetch: fetcher }
    );
    expect(result.skillMd).toBe(skillMd);
    expect(result.resolvedIdentifier).toBe(
      "owner/repo@feature/skill-import:skills/nested/SKILL.md"
    );
    expect(
      requested.some((u) =>
        isGitHubApiExactPath(u, "/repos/owner/repo/commits/feature%2Fskill-import")
      )
    ).toBe(true);
  });

  it("reports a clean error when repo-root discovery finds no skill", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/HEAD")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ tree: [{ path: "README.md", type: "blob" }] }));
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("https://github.com/owner/repo", { fetch: fetcher })
    ).rejects.toThrow(/No SKILL\.md found in owner\/repo/);
  });

  it("throws when raw fetch fails", async () => {
    // Use a fully-resolved 40-char SHA so we bypass the API resolution path and
    // exercise the raw fetch failure specifically.
    const fetcher = vi.fn(async () => makeResponse("not found", { ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub(`owner/repo@${"a".repeat(40)}`, { fetch: fetcher })
    ).rejects.toThrow(/GitHub fetch failed/);
  });

  it("fetches declared bin and resource files at the same SHA", async () => {
    const skillMd = `---
name: bin-skill
description: This description is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
resources:
  - path: references/notes.md
    type: file
bin:
  setup:
    command: bin/setup
---

# Body
`;
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ tree: [
          { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
          { path: "skills/foo/bin/setup", type: "blob", mode: "100755" },
          { path: "skills/foo/references/notes.md", type: "blob", mode: "100644" }
        ] }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (u.endsWith("/skills/foo/SKILL.md")) {
        return makeResponse(skillMd);
      }
      if (u.endsWith("/skills/foo/bin/setup")) {
        return makeResponse("#!/usr/bin/env bash\necho ok\n");
      }
      if (u.endsWith("/skills/foo/references/notes.md")) {
        return makeResponse("# notes\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", {
      fetch: fetcher
    });
    expect(result.resources).toBeDefined();
    expect(result.resources!.map((r) => r.path).sort()).toEqual([
      "bin/setup",
      "references/notes.md"
    ]);
    // Each resource fetch must use the resolved SHA, not HEAD or another ref.
    for (const url of requested.filter((u) => u.includes("raw.githubusercontent"))) {
      expect(url).toContain("/" + "1".repeat(40) + "/");
    }
  });

  it("collects undeclared nested sibling resources in stable order and ignores artifacts", async () => {
    const bundleSkillMd = `---
name: complete-bundle
description: This description is intentionally long enough to satisfy schema length checks.
agents: [codex]
metadata:
  version: "1.0.0"
---

# Body
`;
    const sha = "5".repeat(40);
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          truncated: false,
          tree: [
            { path: "skills/other/README.md", type: "blob", mode: "100644" },
            { path: "skills/foo/z-last.txt", type: "blob", mode: "100644" },
            { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
            { path: "skills/foo/nested/a-first.md", type: "blob", mode: "100644" },
            { path: "skills/foo/.DS_Store", type: "blob", mode: "100644" },
            { path: "skills/foo/nested/._a-first.md", type: "blob", mode: "100644" },
            { path: "skills/foo/.autovault-source.json", type: "blob", mode: "100644" }
          ]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) return makeResponse(bundleSkillMd);
      if (isRawGitHubPath(url, "/skills/foo/nested/a-first.md")) return makeResponse("a\n");
      if (isRawGitHubPath(url, "/skills/foo/z-last.txt")) return makeResponse("z\n");
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", {
      fetch: fetcher
    });

    expect(result.resources).toEqual([
      { path: "nested/a-first.md", content: "a\n" },
      { path: "z-last.txt", content: "z\n" }
    ]);
    expect(requested.filter((u) => u.includes("raw.githubusercontent"))).toHaveLength(3);
    expect(requested.every((u) => !u.includes(".DS_Store") && !u.includes("._a-first"))).toBe(true);
  });

  it("does not fetch an ignored artifact even when upstream declares it", async () => {
    const bundleSkillMd = `---
name: ignored-declared-resource
description: This description is intentionally long enough to satisfy schema length checks.
agents: [codex]
metadata:
  version: "1.0.0"
resources:
  - path: .DS_Store
    type: file
---

# Body
`;
    const sha = "a".repeat(40);
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          truncated: false,
          tree: [
            { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
            { path: "skills/foo/.DS_Store", type: "blob", mode: "100644" }
          ]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) return makeResponse(bundleSkillMd);
      if (isRawGitHubPath(url, "/skills/foo/.DS_Store")) return makeResponse("finder\n");
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", {
      fetch: fetcher
    });

    expect(result.resources).toEqual([]);
    expect(requested.some((u) => isRawGitHubPath(u, "/skills/foo/.DS_Store"))).toBe(false);
  });

  it("does not collect descendants of ignored or AutoVault metadata directories", async () => {
    const bundleSkillMd = `---
name: ignored-directory-descendants
description: This description is intentionally long enough to satisfy schema length checks.
agents: [codex]
metadata:
  version: "1.0.0"
---

# Body
`;
    const sha = "b".repeat(40);
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          truncated: false,
          tree: [
            { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
            { path: "skills/foo/.autovault-cache", type: "tree", mode: "040000" },
            { path: "skills/foo/.autovault-cache/state.json", type: "blob", mode: "100644" },
            { path: "skills/foo/nested/.DS_Store", type: "tree", mode: "040000" },
            { path: "skills/foo/nested/.DS_Store/state.json", type: "blob", mode: "100644" },
            { path: "skills/foo/references/keep.md", type: "blob", mode: "100644" }
          ]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) return makeResponse(bundleSkillMd);
      if (isRawGitHubPath(url, "/skills/foo/references/keep.md")) return makeResponse("keep\n");
      if (u.includes("state.json")) return makeResponse("{}\n");
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", {
      fetch: fetcher
    });

    expect(result.resources).toEqual([
      { path: "references/keep.md", content: "keep\n" }
    ]);
    expect(requested.some((u) => u.includes("state.json"))).toBe(false);
  });

  it("fails closed when the exact bundle tree is truncated", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha: "6".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          truncated: true,
          tree: [{ path: "skills/foo/SKILL.md", type: "blob", mode: "100644" }]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: exact-skill\n---\n\n# Body\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/truncated.*incomplete skill bundle/i);
  });

  it("refuses an exact bundle tree response that exceeds the API body cap", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha: "6".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse("{}", {
          headers: { "content-length": String(6 * 1024 * 1024) }
        });
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: exact-skill\n---\n\n# Body\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/declares 6291456 bytes.*5242880/);
  });

  it("fails closed when the exact bundle tree response has no tree entries", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha: "6".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ sha: "not-a-tree-listing" }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: exact-skill\n---\n\n# Body\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/missing a tree array/i);
  });

  it("fails closed when the exact tree does not contain the selected SKILL.md", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha: "6".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          tree: [{ path: "skills/other/SKILL.md", type: "blob", mode: "100644" }]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: exact-skill\n---\n\n# Body\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/does not contain selected SKILL\.md/i);
  });

  it.each([
    ["symlink", { path: "skills/foo/link", type: "blob", mode: "120000" }],
    ["submodule", { path: "skills/foo/vendor", type: "commit", mode: "160000" }]
  ])("fails closed on a %s inside the selected skill directory", async (_kind, unsafeEntry) => {
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha: "7".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          truncated: false,
          tree: [
            { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
            unsafeEntry
          ]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: exact-skill\n---\n\n# Body\n");
      }
      return makeResponse("linked content\n");
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/symlink|submodule/i);
  });

  it("rejects an exact bundle with more than the resource-count limit", async () => {
    const resources = Array.from({ length: 51 }, (_, index) => ({
      path: `skills/foo/docs/${String(index).padStart(2, "0")}.md`,
      type: "blob",
      mode: "100644"
    }));
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha: "8".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          truncated: false,
          tree: [
            { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
            ...resources
          ]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: exact-skill\n---\n\n# Body\n");
      }
      return makeResponse("resource\n");
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/resources exceed limit: 51 > 50/i);
  });

  it("rejects an exact bundle whose cumulative bytes exceed the total limit", async () => {
    const resources = Array.from({ length: 6 }, (_, index) => ({
      path: `skills/foo/docs/${index}.txt`,
      type: "blob",
      mode: "100644"
    }));
    const resourceBody = "x".repeat(900 * 1024);
    const fetcher = vi.fn(async (url: string | URL) => {
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        return makeResponse(JSON.stringify({ sha: "9".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          truncated: false,
          tree: [
            { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
            ...resources
          ]
        }));
      }
      if (isRawGitHubPath(url, "/skills/foo/SKILL.md")) {
        return makeResponse("---\nname: exact-skill\n---\n\n# Body\n");
      }
      return makeResponse(resourceBody);
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/Total skill bundle bytes exceeded/);
  });

  it("dedups declared resource paths by canonical form (round-46)", async () => {
    // Before the fix, raw-string dedup let `./bin/setup` and `bin/setup`
    // (or the same file referenced from both `resources[].path` and
    // `bin.<action>.command`) survive as two entries. Each was fetched
    // separately, then writeSkill canonicalized both to the same path and
    // the validator rejected the install for duplicate canonical resources.
    const skillMd = `---
name: dedup-skill
description: This description is intentionally long enough to satisfy schema length checks.
resources:
  - path: ./bin/setup
    type: file
bin:
  setup:
    command: bin/setup
---

# Body
`;
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ tree: [
          { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
          { path: "skills/foo/bin/setup", type: "blob", mode: "100755" }
        ] }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (u.endsWith("/skills/foo/SKILL.md")) {
        return makeResponse(skillMd);
      }
      if (u.endsWith("/skills/foo/bin/setup")) {
        return makeResponse("#!/usr/bin/env bash\necho ok\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", {
      fetch: fetcher
    });
    expect(result.resources).toBeDefined();
    expect(result.resources!.map((r) => r.path)).toEqual(["bin/setup"]);
    const rawFetches = requested.filter((u) => u.includes("raw.githubusercontent"));
    // One SKILL.md + one bin/setup. The duplicate spelling must not
    // produce a second round trip.
    expect(rawFetches).toHaveLength(2);
  });

  it("discovers declared resources after frontmatter repair (round-59)", async () => {
    // install_skill runs attemptRepair on the fetched SKILL.md before
    // validation, normalizing tabs to spaces and stripping trailing
    // whitespace. The GitHub adapter previously parsed the *raw* fetched
    // bytes for resource discovery, so a SKILL.md whose YAML mixed tabs
    // (which gray-matter rejects) silently returned an empty resource list:
    // declaredResourcePaths(skillMd) caught the parse error and returned
    // []. Install would then succeed against the repaired body but the
    // declared bin script would never have been fetched, leaving the user
    // with a half-installed skill. Mirror the repair pass at fetch time so
    // resource enumeration sees the same bytes install validates.
    // Tabs in YAML indentation are a hard error in js-yaml (which gray-matter
    // uses), so the raw fetched bytes parse to {}/throw and resource
    // discovery comes up empty. attemptRepair rewrites every tab as two
    // spaces; with two tabs (== four spaces) the `command:` line lands
    // properly nested under `setup:` and the bin/setup declaration becomes
    // visible.
    const tabbed = [
      "---",
      "name: tab-skill",
      "description: This description is intentionally long enough to satisfy schema length checks.",
      "metadata:",
      "  version: \"1.0.0\"",
      "resources:",
      "  - path: references/notes.md",
      "    type: file",
      "bin:",
      "  setup:",
      "\t\tcommand: bin/setup",
      "---",
      "",
      "# Body",
      ""
    ].join("\n");

    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ tree: [
          { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
          { path: "skills/foo/bin/setup", type: "blob", mode: "100755" },
          { path: "skills/foo/references/notes.md", type: "blob", mode: "100644" }
        ] }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (u.endsWith("/skills/foo/SKILL.md")) {
        return makeResponse(tabbed);
      }
      if (u.endsWith("/skills/foo/bin/setup")) {
        return makeResponse("#!/usr/bin/env bash\necho ok\n");
      }
      if (u.endsWith("/skills/foo/references/notes.md")) {
        return makeResponse("# notes\n");
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", {
      fetch: fetcher
    });
    expect(result.resources).toBeDefined();
    expect(result.resources!.map((r) => r.path).sort()).toEqual([
      "bin/setup",
      "references/notes.md"
    ]);
  });

  it("rejects declared resource paths that escape the skill directory", async () => {
    const skillMd = `---
name: traversal
description: This description is intentionally long enough to satisfy schema length checks.
bin:
  setup:
    command: ../../etc/passwd
---

# Body
`;
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ tree: [
          { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" }
        ] }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      return makeResponse(skillMd);
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/unsafe/);
  });

  it("fails fast when HEAD sha resolution fails", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        return makeResponse("rate-limited", { ok: false, status: 403 });
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;
    await expect(fetchSkillFromGitHub("owner/repo", { fetch: fetcher })).rejects.toThrow(
      /refusing to fetch from a mutable ref/
    );
  });

  it("fails fast when sha resolution fails for a named ref (no fallback)", async () => {
    // Before the fix, a named ref (branch/tag) would silently fall through to
    // the mutable name when SHA resolution failed — meaning SKILL.md and
    // bin/setup could come from different commits if upstream moved.
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        return makeResponse("rate-limited", { ok: false, status: 403 });
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("owner/repo@main", { fetch: fetcher })
    ).rejects.toThrow(/refusing to fetch from a mutable ref/);
  });

  it("rejects an install that declares more than MAX_RESOURCES files", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      lines.push(`  - path: file${i}.md`);
      lines.push(`    type: file`);
    }
    const skillMd = `---
name: oversized
description: This description is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
resources:
${lines.join("\n")}
---

# Body
`;
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ tree: [
          { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" }
        ] }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (u.endsWith("/skills/foo/SKILL.md")) {
        return makeResponse(skillMd);
      }
      return makeResponse("ok");
    }) as unknown as typeof fetch;

    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/exceed limit/);
  });

  // Round-39 fix: resolveSha used to call response.json() with no body cap,
  // so a degraded/malicious commit API that ships headers and then streams
  // a multi-MiB JSON body could exhaust memory before SKILL.md fetching ran.
  // Bound the body and reject the install fast.
  it("refuses a commit-API JSON body that exceeds the cap (round-39)", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        // Lying Content-Length forces the early assertContentLength reject —
        // same pattern as the existing SKILL.md cap test.
        return makeResponse("{}", {
          headers: { "content-length": String(10 * 1024 * 1024) }
        });
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;
    // The bounded-read fails loud with "Fetch refused" so the install
    // surfaces the DoS attempt rather than silently falling through to the
    // generic SHA-resolution-failed path. Either error class is acceptable
    // user-facing output — the point is the install does not hang or buffer
    // the multi-MiB body.
    await expect(
      fetchSkillFromGitHub("owner/repo", { fetch: fetcher })
    ).rejects.toThrow(/Fetch refused.*declares 10485760 bytes/);
  });

  it("refuses a commit-API JSON body whose actual bytes exceed the cap (round-39)", async () => {
    // No Content-Length header — exercises the bounded-read path on the body
    // itself, the same way the SKILL.md regression at line 218 does.
    const oversize = "{".padEnd(256 * 1024 + 1, "a") + "}";
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        return makeResponse(oversize);
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("owner/repo", { fetch: fetcher })
    ).rejects.toThrow(/Fetch refused.*body exceeds 262144 bytes/);
  });

  it("returns undefined sha (and the install fails loud) when commit JSON is malformed", async () => {
    // Defensive: if the body fits under the cap but is not valid JSON, do not
    // crash with a SyntaxError — return undefined so the caller surfaces the
    // SHA-resolution error message and refuses the install.
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        return makeResponse("not json at all");
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("owner/repo", { fetch: fetcher })
    ).rejects.toThrow(/SHA resolution failed/);
  });

  it("refuses to read a SKILL.md whose Content-Length blows the cap", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      return makeResponse("body", {
        headers: { "content-length": String(10 * 1024 * 1024) }
      });
    }) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("owner/repo", { fetch: fetcher })
    ).rejects.toThrow(/refused/);
  });

  it("refuses oversized SKILL.md body bytes when Content-Length is missing", async () => {
    // Without a streaming bound, an upstream that omits Content-Length and
    // returns a multi-MiB body would force the MCP process to buffer the whole
    // payload before bundle-size validation runs. Caller never set a header,
    // so this exercises the bounded-read path on the body itself.
    const oversize = "x".repeat(256 * 1024 + 1);
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      return makeResponse(oversize);
    }) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("owner/repo", { fetch: fetcher })
    ).rejects.toThrow(/exceeds/);
  });

  // Round-44 fix: a named ref containing a slash (e.g. `feature/setup-bin`)
  // used to be interpolated raw into the commits API URL, so GitHub saw
  // `/commits/feature/setup-bin` and parsed `setup-bin` as an extra path
  // segment, returning 404. resolveSha then returned undefined, the install
  // failed loud — but the regression silently broke every common branch
  // naming scheme (feature/, hotfix/, release/) until users hand-pinned a
  // 40-char SHA. The fix encodes the ref as one path segment.
  it("URL-encodes a named ref containing slashes (round-44)", async () => {
    let commitsUrl: string | undefined;
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (isGitHubApiPath(url, "/repos/owner/repo/commits/")) {
        commitsUrl = u;
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({
          tree: [{ path: "SKILL.md", type: "blob", mode: "100644" }]
        }));
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;
    await fetchSkillFromGitHub("owner/repo@feature/setup-bin", { fetch: fetcher });
    // The slash in the ref must be encoded so GitHub treats the whole ref
    // as a single segment of the commits endpoint.
    expect(commitsUrl).toBeDefined();
    expect(commitsUrl).toContain("/commits/feature%2Fsetup-bin");
    expect(commitsUrl).not.toContain("/commits/feature/setup-bin");
  });

  // Round-42 fix: caller-controlled paths flowed unchecked into rawUrl(), so
  // URL dot-segment normalization would collapse `:../../other/main/SKILL.md`
  // into a different repo's raw URL — the bytes would no longer match the
  // recorded SHA and provenance would be silently broken. Reject before any
  // network call.
  it("refuses a SKILL.md path with traversal segments before any fetch (round-42)", async () => {
    const fetcher = vi.fn(async () => makeResponse("never reached")) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub(`owner/repo@${"a".repeat(40)}:../../other/main/SKILL.md`, {
        fetch: fetcher
      })
    ).rejects.toThrow(/unsafe GitHub/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a SKILL.md path that is absolute (round-42)", async () => {
    const fetcher = vi.fn(async () => makeResponse("never reached")) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub(`owner/repo@${"a".repeat(40)}:/etc/passwd`, { fetch: fetcher })
    ).rejects.toThrow(/unsafe GitHub/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a Windows drive-qualified SKILL.md path before any fetch", async () => {
    const fetcher = vi.fn(async () => makeResponse("never reached")) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub(`owner/repo@${"a".repeat(40)}:C:/temp/SKILL.md`, { fetch: fetcher })
    ).rejects.toThrow(/unsafe GitHub/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a declared resource whose join with skillDir would traverse (round-42)", async () => {
    // SKILL.md path is safe ("skills/foo/SKILL.md"), but the declared resource
    // "../../../etc/passwd" would post-join become "../etc/passwd" — a
    // traversal that survives because the canonicalizer rejects each segment
    // before path.posix.join silently absorbs it.
    const skillMd = `---
name: traversal-resource
description: This description is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
resources:
  - path: ../../../etc/passwd
    type: file
---

# Body
`;
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (u.endsWith("/skills/foo/SKILL.md")) {
        return makeResponse(skillMd);
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/unsafe GitHub/);
  });

  it("URL-encodes path segments so spaces and percents stay intact (round-42)", async () => {
    // Belt-and-suspenders: even after canonicalization, a filename with
    // spaces/percents must not be interpreted by URL parsing. Encode each
    // segment so the request hits the literal filename on raw.githubusercontent.
    const requested: string[] = [];
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      requested.push(u);
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ tree: [
          { path: "dir%20with%20spaces/SKILL.md", type: "blob", mode: "100644" }
        ] }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;
    await fetchSkillFromGitHub("owner/repo:dir%20with%20spaces/SKILL.md", { fetch: fetcher });
    const raw = requested.find((u) => u.includes("raw.githubusercontent"));
    expect(raw).toBeDefined();
    // The original `%20` must be re-encoded to `%2520` (encodeURIComponent
    // double-encodes existing percents) — proving each segment was passed
    // through encodeURIComponent rather than spliced raw.
    expect(raw).toContain("dir%2520with%2520spaces/SKILL.md");
  });

  it("refuses oversized resource body bytes when Content-Length is missing", async () => {
    const skillMd = `---
name: oversize-resource
description: This description is intentionally long enough to satisfy schema length checks.
metadata:
  version: "1.0.0"
resources:
  - path: big.bin
    type: file
---

# Body
`;
    const oversize = "y".repeat(1 * 1024 * 1024 + 1);
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (isGitHubApiPath(url, "/repos/owner/repo/git/trees/")) {
        return makeResponse(JSON.stringify({ tree: [
          { path: "skills/foo/SKILL.md", type: "blob", mode: "100644" },
          { path: "skills/foo/big.bin", type: "blob", mode: "100644" }
        ] }));
      }
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
      }
      if (u.endsWith("/skills/foo/SKILL.md")) {
        return makeResponse(skillMd);
      }
      if (u.endsWith("/skills/foo/big.bin")) {
        return makeResponse(oversize);
      }
      return makeResponse("not found", { ok: false, status: 404 });
    }) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("owner/repo:skills/foo/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/exceeds/);
  });
});

describe("url source", () => {
  it("rejects non-https URLs", async () => {
    await expect(fetchSkillFromUrl("http://example.com")).rejects.toThrow(/https/);
  });

  it("returns body on success", async () => {
    const fetcher = vi.fn(async () => makeResponse("body")) as unknown as typeof fetch;
    const result = await fetchSkillFromUrl("https://example.com/SKILL.md", { fetch: fetcher });
    expect(result.skillMd).toBe("body");
  });

  it("follows https redirects and returns final body", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://example.com/SKILL.md") {
        return makeResponse("", {
          ok: false,
          status: 302,
          headers: { location: "https://cdn.example.com/skill.md" }
        });
      }
      return makeResponse("redirected-body");
    }) as unknown as typeof fetch;
    const result = await fetchSkillFromUrl("https://example.com/SKILL.md", { fetch: fetcher });
    expect(result.skillMd).toBe("redirected-body");
    expect(result.sourceUrl).toBe("https://cdn.example.com/skill.md");
  });

  it("rejects redirects to non-https", async () => {
    const fetcher = vi.fn(async () =>
      makeResponse("", {
        ok: false,
        status: 302,
        headers: { location: "http://example.com/plaintext.md" }
      })
    ) as unknown as typeof fetch;
    await expect(fetchSkillFromUrl("https://example.com/SKILL.md", { fetch: fetcher })).rejects.toThrow(
      /non-https/
    );
  });

  it("refuses oversized SKILL.md by Content-Length", async () => {
    // The MCP server must not buffer arbitrarily-large bodies before bundle
    // limits run — without this gate, an untrusted https endpoint could DoS
    // the validator with a multi-megabyte response.
    const fetcher = vi.fn(async () =>
      makeResponse("body", { headers: { "content-length": String(10 * 1024 * 1024) } })
    ) as unknown as typeof fetch;
    await expect(
      fetchSkillFromUrl("https://example.com/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/declares.*bytes/);
  });

  it("refuses oversized SKILL.md by body bytes when Content-Length is missing", async () => {
    const oversize = "x".repeat(256 * 1024 + 1);
    const fetcher = vi.fn(async () => makeResponse(oversize)) as unknown as typeof fetch;
    await expect(
      fetchSkillFromUrl("https://example.com/SKILL.md", { fetch: fetcher })
    ).rejects.toThrow(/exceeds/);
  });
});

describe("agentskills source", () => {
  it("resolves slug@version against the configured base", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      expect(url.toString()).toContain("/skills/my-skill/1.0.0/SKILL.md");
      return makeResponse("body");
    }) as unknown as typeof fetch;
    const result = await fetchSkillFromAgentSkills("my-skill@1.0.0", { fetch: fetcher });
    expect(result.skillMd).toBe("body");
  });
});
