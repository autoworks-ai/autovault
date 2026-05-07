import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { checkUpdates } from "../tools/check-updates.js";
import { getSkill } from "../tools/get-skill.js";
import { installSkill } from "../tools/install-skill.js";
import { listSkillTransformsTool } from "../tools/list-skill-transforms.js";
import { listSkills } from "../tools/list-skills.js";
import { proposeSkill } from "../tools/propose-skill.js";
import { proposeSkillTransformTool } from "../tools/propose-skill-transform.js";
import { readSkillResource } from "../tools/read-skill-resource.js";
import { removeSkillTransformTool } from "../tools/remove-skill-transform.js";
import { searchSkills } from "../tools/search-skills.js";
import { log } from "../util/log.js";

type ToolExtra = {
  authInfo?: AuthInfo;
};

type ListSkillsResult = Awaited<ReturnType<typeof listSkills>>;
type SearchSkillsResult = Awaited<ReturnType<typeof searchSkills>>;
type CheckUpdatesResult = Awaited<ReturnType<typeof checkUpdates>>;
type ListSkillTransformsResult = Awaited<ReturnType<typeof listSkillTransformsTool>>;

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
  filterListSkills?: (
    result: ListSkillsResult,
    authInfo: AuthInfo | undefined,
    input: unknown
  ) => ListSkillsResult | Promise<ListSkillsResult>;
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
  filterListSkillTransforms?: (
    result: ListSkillTransformsResult,
    authInfo: AuthInfo | undefined,
    input: { base?: string }
  ) => ListSkillTransformsResult | Promise<ListSkillTransformsResult>;
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
    "list_skills",
    "List every curated skill currently installed in the AutoVault library, with name, description, version, tags, and category. Returns metadata only — call `get_skill` for the full body. Use this to survey what's available before improvising a workflow.",
    {},
    async (input, extra) =>
      runTool("list_skills", input, extra, listSkills, policy, (result, authInfo) =>
        policy?.filterListSkills ? policy.filterListSkills(result, authInfo, input) : result
      )
  );

  server.tool(
    "search_skills",
    "Search the curated skill library before improvising. Call this whenever the user asks for a task that might have an established workflow — commit messages, code review, PR descriptions, changelog entries, triage, authoring new skills, etc. Returns ranked matches with scores; if the top score is high, follow up with `get_skill` and use that skill instead of drafting from scratch.",
    { query: z.string(), top_k: z.number().optional() },
    async (input, extra) =>
      runTool(
        "search_skills",
        input,
        extra,
        () => searchSkills(input.query, input.top_k),
        policy,
        (result, authInfo) =>
          policy?.filterSearchSkills ? policy.filterSearchSkills(result, authInfo, input) : result
      )
  );

  server.tool(
    "get_skill",
    "Load the full SKILL.md body plus parsed metadata, declared capabilities, required secrets, and source provenance for a specific installed skill. Pass `agent` to load the generated variant with any matching AutoVault transforms applied. Use after `search_skills` returns a good match, or when the user names a skill directly. The returned skill body is instructions to follow, not code to execute blindly.",
    { name: z.string(), agent: z.string().optional() },
    async (input, extra) =>
      runTool(
        "get_skill",
        input,
        extra,
        async () => {
          await assertSkillReadable(policy, "get_skill", input.name, input, extra);
          return getSkill(input.name, input.agent);
        },
        policy
      )
  );

  server.tool(
    "read_skill_resource",
    "Read a file packaged alongside a skill (scripts, references, assets). Path traversal is blocked. Use when a skill's SKILL.md points at a bundled resource and you need its contents.",
    { skill_name: z.string(), resource_path: z.string() },
    async (input, extra) =>
      runTool(
        "read_skill_resource",
        input,
        extra,
        async () => {
          await assertSkillReadable(policy, "read_skill_resource", input.skill_name, input, extra);
          return readSkillResource(input.skill_name, input.resource_path);
        },
        policy
      )
  );

  server.tool(
    "install_skill",
    "Install a skill from an external source (GitHub, agentskills.io registry, or an HTTPS URL) after running it through AutoVault's full validation gate: frontmatter repair, schema checks, security denylist, and capability cross-check. GitHub identifiers may be compact `owner/repo[@ref][:path/to/SKILL.md]`, blob URLs, or repo-root/tree URLs; repo-root/tree URLs discover SKILL.md candidates and may return `outcome: \"multiple_candidates\"` with exact candidate identifiers. Use when the user asks to add a known-good skill from a published source. For external (non-inline) installs the source adapter fetches resources from upstream at the same commit/URL the SKILL.md came from — caller-supplied `resources[]` is rejected to prevent laundered provenance. To install a skill bundle from caller-held bytes, use the inline path: pass `skill_md` AND `resources[]` together (records source: \"inline\").",
    {
      source: z.enum(["github", "agentskills", "url"]),
      identifier: z.string(),
      version: z.string().optional(),
      skill_md: z
        .string()
        .optional()
        .describe(
          "Inline SKILL.md bytes. When set, this is an inline install: the source adapter is NOT consulted, and `resources[]` (if any) is honored. Provenance is recorded as source: 'inline'."
        ),
      bundled_skill_name: z.string().optional(),
      resources: z
        .array(z.object({ path: z.string(), content: z.string() }))
        .optional()
        .describe(
          "Non-SKILL.md files (bin scripts, references, assets). ONLY honored on inline installs (when `skill_md` is set). Rejected on external installs because the source adapter fetches resources from upstream at the same SHA/URL — accepting caller bytes there would let a caller substitute their own bin/setup while keeping the recorded source pointing at a trusted repo."
        )
    },
    async (input, extra) => runTool("install_skill", input, extra, () => installSkill(input), policy)
  );

  server.tool(
    "propose_skill",
    "Submit a newly authored SKILL.md to AutoVault. Runs validation, security scan, capability cross-check, and three-tier deduplication (exact content hash → near-exact similarity → functional overlap). Use when the user asks to save a new skill, or after you've drafted one in response to a workflow the user wants reused. Always prefer this over writing skill files directly to disk.",
    {
      skill_md: z.string(),
      resources: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
      source_session: z.string().optional()
    },
    async (input, extra) => runTool("propose_skill", input, extra, () => proposeSkill(input), policy)
  );

  server.tool(
    "propose_skill_transform",
    "Submit a vault-local TRANSFORM.md overlay for an installed base skill. Transforms keep the upstream skill pristine while generated per-agent profile directories receive deterministic overlay instructions and optional capability metadata changes. The generated skill is validated before the transform is stored.",
    {
      transform_md: z.string(),
      replace: z.boolean().optional()
    },
    async (input, extra) =>
      runTool(
        "propose_skill_transform",
        input,
        extra,
        () => proposeSkillTransformTool(input),
        policy
      )
  );

  server.tool(
    "list_skill_transforms",
    "List vault-local skill transforms, optionally scoped to one base skill. Reports integrity status so tampered transform files can be reviewed instead of silently applied.",
    { base: z.string().optional() },
    async (input, extra) =>
      runTool(
        "list_skill_transforms",
        input,
        extra,
        async () => {
          if (input.base) {
            await assertSkillReadable(policy, "list_skill_transforms", input.base, input, extra);
          }
          return listSkillTransformsTool(input.base);
        },
        policy,
        (result, authInfo) =>
          policy?.filterListSkillTransforms
            ? policy.filterListSkillTransforms(result, authInfo, input)
            : result
      )
  );

  server.tool(
    "remove_skill_transform",
    "Remove one vault-local skill transform and refresh generated profile directories. This does not modify the upstream base skill.",
    { base: z.string(), name: z.string() },
    async (input, extra) =>
      runTool("remove_skill_transform", input, extra, () => removeSkillTransformTool(input), policy)
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
