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
    version: "0.1.0"
  });

  server.tool("list_skills", "List installed skill metadata only", {}, async () =>
    runTool("list_skills", listSkills)
  );

  server.tool(
    "search_skills",
    "Search installed skills by query",
    { query: z.string(), top_k: z.number().optional() },
    async ({ query, top_k }) => runTool("search_skills", () => searchSkills(query, top_k))
  );

  server.tool("get_skill", "Return full SKILL.md and metadata", { name: z.string() }, async ({ name }) =>
    runTool("get_skill", () => getSkill(name))
  );

  server.tool(
    "read_skill_resource",
    "Read a specific skill resource file",
    { skill_name: z.string(), resource_path: z.string() },
    async ({ skill_name, resource_path }) =>
      runTool("read_skill_resource", () => readSkillResource(skill_name, resource_path))
  );

  server.tool(
    "install_skill",
    "Install a skill from source and run validation gate",
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
    "Propose a new skill with dedup and security gating",
    {
      skill_md: z.string(),
      resources: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
      source_session: z.string().optional()
    },
    async (input) => runTool("propose_skill", () => proposeSkill(input))
  );

  server.tool(
    "check_updates",
    "Check installed skills for upstream drift",
    { skill: z.string().optional() },
    async ({ skill }) => runTool("check_updates", () => checkUpdates(skill))
  );

  return server;
}
