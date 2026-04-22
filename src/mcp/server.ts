import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkUpdates } from "../tools/check-updates.js";
import { getSkill } from "../tools/get-skill.js";
import { installSkill } from "../tools/install-skill.js";
import { listSkills } from "../tools/list-skills.js";
import { proposeSkill } from "../tools/propose-skill.js";
import { readSkillResource } from "../tools/read-skill-resource.js";
import { searchSkills } from "../tools/search-skills.js";
import { log } from "../util/log.js";

type ToolHandler<T> = () => Promise<T>;

async function runTool<T>(name: string, handler: ToolHandler<T>): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    const result = await handler();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    log.error("tool.failed", { tool: name, error: String(error) });
    throw error;
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "autovault",
    version: "0.2.0"
  });

  server.tool(
    "list_skills",
    "List every curated skill currently installed in the AutoVault library, with name, description, version, tags, and category. Returns metadata only — call `get_skill` for the full body. Use this to survey what's available before improvising a workflow.",
    {},
    async () => runTool("list_skills", listSkills)
  );

  server.tool(
    "search_skills",
    "Search the curated skill library before improvising. Call this whenever the user asks for a task that might have an established workflow — commit messages, code review, PR descriptions, changelog entries, triage, authoring new skills, etc. Returns ranked matches with scores; if the top score is high, follow up with `get_skill` and use that skill instead of drafting from scratch.",
    { query: z.string(), top_k: z.number().optional() },
    async ({ query, top_k }) => runTool("search_skills", () => searchSkills(query, top_k))
  );

  server.tool(
    "get_skill",
    "Load the full SKILL.md body plus parsed metadata, declared capabilities, required secrets, and source provenance for a specific installed skill. Use after `search_skills` returns a good match, or when the user names a skill directly. The returned skill body is instructions to follow, not code to execute blindly.",
    { name: z.string() },
    async ({ name }) => runTool("get_skill", () => getSkill(name))
  );

  server.tool(
    "read_skill_resource",
    "Read a file packaged alongside a skill (scripts, references, assets). Path traversal is blocked. Use when a skill's SKILL.md points at a bundled resource and you need its contents.",
    { skill_name: z.string(), resource_path: z.string() },
    async ({ skill_name, resource_path }) =>
      runTool("read_skill_resource", () => readSkillResource(skill_name, resource_path))
  );

  server.tool(
    "install_skill",
    "Install a skill from an external source (GitHub, agentskills.io registry, or an HTTPS URL) after running it through AutoVault's full validation gate: frontmatter repair, schema checks, security denylist, and capability cross-check. Use when the user asks to add a known-good skill from a published source.",
    {
      source: z.enum(["github", "agentskills", "url"]),
      identifier: z.string(),
      version: z.string().optional(),
      skill_md: z.string().optional()
    },
    async (input) => runTool("install_skill", () => installSkill(input))
  );

  server.tool(
    "propose_skill",
    "Submit a newly authored SKILL.md to AutoVault. Runs validation, security scan, capability cross-check, and three-tier deduplication (exact content hash → near-exact similarity → functional overlap). Use when the user asks to save a new skill, or after you've drafted one in response to a workflow the user wants reused. Always prefer this over writing skill files directly to disk.",
    {
      skill_md: z.string(),
      resources: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
      source_session: z.string().optional()
    },
    async (input) => runTool("propose_skill", () => proposeSkill(input))
  );

  server.tool(
    "check_updates",
    "Detect upstream drift for skills installed from `github`, `agentskills`, or `url`. Compares each skill's stored content hash against the current upstream state. Use periodically for maintenance, or when the user asks whether a skill is stale. Inline-proposed skills never drift and are always reported up-to-date.",
    { skill: z.string().optional() },
    async ({ skill }) => runTool("check_updates", () => checkUpdates(skill))
  );

  return server;
}
