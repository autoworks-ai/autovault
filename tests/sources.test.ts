import { describe, expect, it, vi } from "vitest";
import {
  fetchSkillFromGitHub,
  parseGithubIdentifier
} from "../src/sources/github.js";
import { fetchSkillFromAgentSkills } from "../src/sources/agentskills.js";
import { fetchSkillFromUrl } from "../src/sources/url.js";

function makeResponse(body: string, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
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
    const fetcher = vi.fn(async () => makeResponse("not found", { ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(
      fetchSkillFromGitHub("owner/repo@abc", { fetch: fetcher })
    ).rejects.toThrow(/GitHub fetch failed/);
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
