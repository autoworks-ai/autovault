import { describe, expect, it, vi } from "vitest";
import {
  fetchSkillFromGitHub,
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
  });

  it("rejects malformed identifiers", () => {
    expect(() => parseGithubIdentifier("nope")).toThrow();
  });

  it("fetches raw content using a resolved sha", async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("api.github.com")) {
        return makeResponse(JSON.stringify({ sha: "1234567890abcdef1234567890abcdef12345678" }));
      }
      return makeResponse("---\nname: x\n---\n");
    }) as unknown as typeof fetch;

    const result = await fetchSkillFromGitHub("owner/repo", { fetch: fetcher });
    expect(result.upstreamSha).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(result.sourceUrl).toContain("raw.githubusercontent.com");
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
      if (u.includes("api.github.com")) {
        commitsUrl = u;
        return makeResponse(JSON.stringify({ sha: "1".repeat(40) }));
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
