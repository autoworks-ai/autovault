import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { addSkill } from "../tools/add-skill.js";
import { checkUpdates } from "../tools/check-updates.js";
import { deleteSkill } from "../tools/delete-skill.js";
import { getSkill } from "../tools/get-skill.js";
import { proposeSkill } from "../tools/propose-skill.js";
import { searchSkills } from "../tools/search-skills.js";
import { updateSkill } from "../tools/update-skill.js";
import { log } from "../util/log.js";

type ToolExtra = {
  authInfo?: AuthInfo;
};

type SearchSkillsResult = Awaited<ReturnType<typeof searchSkills>>;
type CheckUpdatesResult = Awaited<ReturnType<typeof checkUpdates>>;

export type McpToolPolicy = {
  assertToolAllowed?: (
    toolName: string,
    input: unknown,
    authInfo: AuthInfo | undefined
  ) => void | Promise<void>;
  assertCanReadSkill?: (
    skillName: string,
    authInfo: AuthInfo | undefined,
    context?: { toolName: string; input: unknown }
  ) => void | Promise<void>;
  filterSearchSkills?: (
    result: SearchSkillsResult,
    authInfo: AuthInfo | undefined,
    input: { query: string; top_k?: number }
  ) => SearchSkillsResult | Promise<SearchSkillsResult>;
  filterCheckUpdates?: (
    result: CheckUpdatesResult,
    authInfo: AuthInfo | undefined,
    input: { skill?: string }
  ) => CheckUpdatesResult | Promise<CheckUpdatesResult>;
};

export type CreateServerOptions = {
  policy?: McpToolPolicy;
};

type ToolHandler<T> = () => Promise<T>;

async function runTool<T>(
  name: string,
  input: unknown,
  extra: ToolExtra,
  handler: ToolHandler<T>,
  policy?: McpToolPolicy,
  filter?: (result: T, authInfo: AuthInfo | undefined) => T | Promise<T>
): Promise<{ content: [{ type: "text"; text: string }] }> {
  try {
    await policy?.assertToolAllowed?.(name, input, extra.authInfo);
    const result = await handler();
    const filtered = filter ? await filter(result, extra.authInfo) : result;
    return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
  } catch (error) {
    log.error("tool.failed", { tool: name, error: String(error) });
    throw error;
  }
}

async function assertSkillReadable(
  policy: McpToolPolicy | undefined,
  toolName: string,
  skillName: string,
  input: unknown,
  extra: ToolExtra
): Promise<void> {
  await policy?.assertCanReadSkill?.(skillName, extra.authInfo, { toolName, input });
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const { policy } = options;
  const server = new McpServer({
    name: "autovault",
    version: "0.2.0"
  });

  server.tool(
    "get_skill",
    "Find and load installed skills. Pass `name` for an exact skill, or `query` to search and load the best match while returning alternates. Set `include_resources` to inline packaged resource/bin file contents; otherwise resources are returned as metadata only. Pass `agent` to render the generated variant with matching AutoVault transforms applied.",
    {
      name: z.string().optional(),
      query: z.string().optional(),
      agent: z.string().optional(),
      top_k: z.number().int().positive().max(20).optional(),
      include_resources: z.boolean().optional()
    },
    async (input, extra) =>
      runTool(
        "get_skill",
        input,
        extra,
        async () => {
          if (input.name && input.query) {
            throw new Error("Pass either name or query, not both.");
          }
          if (input.name) {
            await assertSkillReadable(policy, "get_skill", input.name, input, extra);
            return getSkill(input.name, input.agent, {
              includeResources: input.include_resources
            });
          }
          if (!input.query) {
            throw new Error("get_skill requires name or query.");
          }
          const search = await searchSkills(input.query, input.top_k ?? 5);
          const filtered = policy?.filterSearchSkills
            ? await policy.filterSearchSkills(search, extra.authInfo, {
                query: input.query,
                top_k: input.top_k
              })
            : search;
          const match = filtered.matches[0];
          if (!match) {
            return { query: input.query, matches: [], skill: null };
          }
          await assertSkillReadable(policy, "get_skill", match.name, input, extra);
          return {
            query: input.query,
            matches: filtered.matches,
            skill: await getSkill(match.name, input.agent, {
              includeResources: input.include_resources
            })
          };
        },
        policy
      )
  );

  server.tool(
    "add_skill",
    "Add a known skill from a source. For GitHub, agentskills, and URL sources, pass `source` plus `identifier`; remote bytes are fetched and validated before storage. For local bundles, pass `source: \"local\"`, `skill_dir`, and `identifier` matching the CLI add-local --source value; configured profile links are synced by default unless `sync_profiles: false` is passed. Caller-authored SKILL.md bytes should use `propose_skill`, not add_skill.",
    {
      source: z.enum(["github", "agentskills", "url", "local"]),
      identifier: z.string(),
      version: z.string().optional(),
      skill_dir: z.string().optional(),
      sync_profiles: z.boolean().optional(),
      profile_roots: z.record(z.string()).optional(),
      discover_profile_roots: z.boolean().optional()
    },
    async (input, extra) => runTool("add_skill", input, extra, () => addSkill(input), policy)
  );

  server.tool(
    "propose_skill",
    "Submit a newly authored SKILL.md to AutoVault. Runs validation, security scan, capability cross-check, and three-tier deduplication (exact content hash → near-exact similarity → functional overlap). Use when the user asks to save a conversationally created skill, or after you've drafted one in response to a workflow the user wants reused. Always prefer this over writing skill files directly to disk.",
    {
      skill_md: z.string(),
      resources: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
      source_session: z.string().optional()
    },
    async (input, extra) => runTool("propose_skill", input, extra, () => proposeSkill(input), policy)
  );

  server.tool(
    "update_skill",
    "Update an installed skill. With only `name`, AutoVault refreshes the recorded GitHub/agentskills/URL source. To update from a new source, pass `source` and `identifier`; to update from a local bundle, pass `source: \"local\"`, `skill_dir`, and `identifier`; to explicitly replace from caller-held bytes, pass `source: \"inline\"` and `skill_md`. Updates refuse candidates whose frontmatter name does not match `name`.",
    {
      name: z.string(),
      source: z.enum(["github", "agentskills", "url", "local", "inline"]).optional(),
      identifier: z.string().optional(),
      version: z.string().optional(),
      skill_dir: z.string().optional(),
      skill_md: z.string().optional(),
      resources: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
      sync_profiles: z.boolean().optional(),
      profile_roots: z.record(z.string()).optional(),
      discover_profile_roots: z.boolean().optional()
    },
    async (input, extra) =>
      runTool(
        "update_skill",
        input,
        extra,
        async () => {
          await assertSkillReadable(policy, "update_skill", input.name, input, extra);
          return updateSkill(input);
        },
        policy
      )
  );

  server.tool(
    "delete_skill",
    "Delete an installed skill from the vault and refresh generated profiles. This also removes vault-local transforms for that skill.",
    { name: z.string() },
    async (input, extra) =>
      runTool(
        "delete_skill",
        input,
        extra,
        async () => {
          await assertSkillReadable(policy, "delete_skill", input.name, input, extra);
          return deleteSkill(input);
        },
        policy
      )
  );

  server.tool(
    "check_updates",
    "Detect upstream drift for skills installed from `github`, `agentskills`, `url`, or bundled inline sources. Compares each skill's stored content hash against the current source state. Non-bundled inline skills are reported as unchecked.",
    { skill: z.string().optional() },
    async (input, extra) =>
      runTool(
        "check_updates",
        input,
        extra,
        async () => {
          if (input.skill) {
            await assertSkillReadable(policy, "check_updates", input.skill, input, extra);
          }
          return checkUpdates(input.skill);
        },
        policy,
        (result, authInfo) =>
          policy?.filterCheckUpdates ? policy.filterCheckUpdates(result, authInfo, input) : result
      )
  );

  return server;
}
