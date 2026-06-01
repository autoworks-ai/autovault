import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import matter from "gray-matter";
import { z } from "zod";
import { openCapabilityDb, parseJsonArray } from "../capabilities/db.js";
import { loadConfig } from "../config.js";
import { loadNamedProfileConfig, saveNamedProfileConfig } from "../profiles/config.js";
import { listConfiguredProfiles, syncProfiles } from "../profiles/sync.js";
import {
  ensureStorage,
  listInstalledSkillNames,
  readSkillSourceStatus,
  readVerifiedSkillResources,
  readSkill,
  type SkillSource
} from "../storage/index.js";
import type { SkillRecord, SkillSummary } from "../types.js";
import { resourcePathsForSkill } from "../util/skill-resource-paths.js";
import { assertSafeSkillName } from "../util/skill-name.js";
import { checkUpdates } from "../tools/check-updates.js";
import { deleteSkill } from "../tools/delete-skill.js";
import { addSkill } from "../tools/add-skill.js";
import { installSkill } from "../tools/install-skill.js";
import { updateSkill } from "../tools/update-skill.js";
import {
  completeEnrollment,
  initEnrollment,
  installSyncResource,
  listEnrolledUpstreams,
  listSyncUpdates,
  revokeEnrollment
} from "../sync/local.js";
import {
  DEFAULT_UI_CHANNEL,
  MANAGEMENT_API_VERSION,
  type ResolvedUiBundleAssets
} from "./bundle.js";

export type ManagementAuthContext = {
  mode: "local" | "remote";
  role: "owner" | "editor" | "viewer";
  user_id?: string;
  email?: string;
};

export type ManagementAuthResult =
  | { ok: true; context: ManagementAuthContext }
  | { ok: false; status: 401 | 403; error: string };

export type ManagementAuthAdapter = {
  read: (req: Request) => ManagementAuthResult | Promise<ManagementAuthResult>;
  write: (req: Request) => ManagementAuthResult | Promise<ManagementAuthResult>;
};

export type ManagementApiOptions = {
  auth: ManagementAuthAdapter;
  mode: "local" | "remote";
  ui?: ResolvedUiBundleAssets;
};

type SkillSummaryResponse = Omit<SkillSummary, "requiresSecrets"> & {
  actions: string[];
  resource_count: number;
};

type SkillDetailResponse = SkillSummaryResponse & {
  skill_md: string;
  frontmatter: Record<string, unknown>;
  resources: SkillRecord["resources"];
  bin: SkillRecord["bin"];
  bundle: {
    root: "SKILL.md";
    files: SkillBundleFileResponse[];
  };
  provenance: SkillProvenanceResponse;
};

type SkillBundleFileResponse = {
  path: string;
  kind: "markdown" | "data" | "script" | "svg" | "text" | "file";
  group: "root" | "resources" | "actions";
  title: string;
  type: string;
  summary: string;
  preview_status: "loaded" | "unavailable";
  preview?: string;
};

type SkillProvenanceResponse = {
  integrity: "signed";
  source: {
    status: "present" | "legacy" | "tampered" | "unparseable" | "absent";
    label: string;
    identifier?: string;
    fetched_at?: string;
    content_hash?: string;
    reason?: string;
  };
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const stringListSchema = z.array(z.string().trim().min(1)).max(128);
const metadataPatchSchema = z.record(z.string(), z.unknown());

const frontmatterPatchSchema = z
  .object({
    title: z.string().trim().min(1).nullable().optional(),
    description: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).nullable().optional(),
    tags: stringListSchema.optional(),
    agents: stringListSchema.optional(),
    when_to_use: z.string().trim().min(1).nullable().optional(),
    when_not_to_use: z.string().trim().min(1).nullable().optional(),
    risk_level: z.string().trim().min(1).nullable().optional(),
    metadata: metadataPatchSchema.optional()
  })
  .strict();

const skillCreateSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("inline"),
      identifier: z.string().trim().min(1).optional(),
      skill_md: z.string().min(1),
      resources: z
        .array(z.object({
          path: z.string().min(1),
          content: z.string()
        }).strict())
        .optional()
    })
    .strict(),
  z
    .object({
      source: z.enum(["github", "agentskills", "url"]),
      identifier: z.string().trim().min(1),
      version: z.string().trim().min(1).optional()
    })
    .strict(),
  z
    .object({
      source: z.literal("local"),
      identifier: z.string().trim().min(1).optional(),
      skill_dir: z.string().trim().min(1)
    })
    .strict()
]);

const profilesPutSchema = z
  .object({
    profiles: z.array(
      z
        .object({
          name: z.string(),
          agent: z.string(),
          target: z.string(),
          include_tags: z.union([z.literal("*"), z.array(z.string())]).optional(),
          exclude_tags: z.array(z.string()).optional(),
          export_skill_overrides: z.union([z.boolean(), z.string()]).optional()
        })
        .strict()
    )
  })
  .strict();

const confirmSchema = z
  .object({
    confirm: z.literal(true)
  })
  .strict();

const enrollmentUpstreamSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal("file"),
    catalog_path: z.string().min(1),
    public_key: z.string().min(1)
  })
  .strict();

const enrollmentSchema = z
  .object({
    upstream: enrollmentUpstreamSchema
  })
  .strict();

const revokeEnrollmentSchema = z
  .object({
    upstream_id: z.string().min(1)
  })
  .strict();

const installResourceSchema = z
  .object({
    upstream_id: z.string().min(1),
    accept: z.boolean().optional()
  })
  .strict();

export function createManagementApiRouter(options: ManagementApiOptions): express.Router {
  const router = express.Router();

  router.get(
    "/context",
    requireManagementAuth(options.auth, "read"),
    asyncHandler(async (_req, res) => {
      res.json({ context: managementContext(options) });
    })
  );

  router.get(
    "/upstreams",
    requireManagementAuth(options.auth, "read"),
    asyncHandler(async (_req, res) => {
      res.json(await listEnrolledUpstreams());
    })
  );

  router.get("/skills", requireManagementAuth(options.auth, "read"), asyncHandler(async (_req, res) => {
    res.json({ skills: await listSkills() });
  }));

  router.post(
    "/skills",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const input = parseBody(skillCreateSchema, req.body);
      const result = input.source === "inline"
        ? await installSkill({
            source: "url",
            identifier: input.identifier ?? "dashboard-inline",
            skill_md: input.skill_md,
            resources: input.resources ?? []
          })
        : await addSkill(input.source === "local"
            ? {
                source: "local",
                identifier: input.identifier,
                skill_dir: input.skill_dir,
                sync_profiles: true,
                discover_profile_roots: true
              }
            : {
                source: input.source,
                identifier: input.identifier,
                version: input.version,
                sync_profiles: true,
                discover_profile_roots: true
              });
      if (result.success !== true) {
        throw new ApiError(400, `Skill install failed: ${formatWarnings(result)}`);
      }
      const name = typeof result.name === "string" ? result.name : "";
      if (!name) throw new ApiError(500, "Skill install succeeded without returning a name");
      const skill = await readSkill(name);
      if (!skill) throw new ApiError(500, `Installed skill could not be read: ${name}`);
      res.status(201).json({ skill: await skillDetail(skill), result });
    })
  );

  router.get(
    "/skills/:name",
    requireManagementAuth(options.auth, "read"),
    asyncHandler(async (req, res) => {
      const name = safeSkillName(req.params.name);
      const skill = await readSkill(name);
      if (!skill) throw new ApiError(404, `Skill not found: ${name}`);
      res.json({ skill: await skillDetail(skill) });
    })
  );

  router.patch(
    "/skills/:name/frontmatter",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const name = safeSkillName(req.params.name);
      const patch = parseBody(frontmatterPatchSchema, req.body);
      const existing = await readSkill(name);
      if (!existing) throw new ApiError(404, `Skill not found: ${name}`);
      const skillMd = rebuildSkillMarkdown(name, existing.skillMd, patch);
      const update = await updateSkill({
        name,
        source: "inline",
        identifier: `inline:${name}`,
        skill_md: skillMd,
        reuse_existing_resources: true,
        sync_profiles: true,
        discover_profile_roots: true
      });
      if (update.success !== true) {
        throw new ApiError(400, `Frontmatter update failed: ${formatWarnings(update)}`);
      }
      const updated = await readSkill(name);
      if (!updated) throw new ApiError(500, `Skill disappeared after update: ${name}`);
      res.json({ skill: await skillDetail(updated), update });
    })
  );

  router.delete(
    "/skills/:name",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const name = safeSkillName(req.params.name);
      parseBody(confirmSchema, req.body);
      const result = await deleteSkill({
        name,
        discover_profile_roots: true
      });
      res.json({ result });
    })
  );

  router.get(
    "/profiles",
    requireManagementAuth(options.auth, "read"),
    asyncHandler(async (_req, res) => {
      res.json({ profiles: await profilesPayload() });
    })
  );

  router.put(
    "/profiles",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const input = parseBody(profilesPutSchema, req.body);
      await saveNamedProfileConfig(input);
      res.json({ profiles: await profilesPayload() });
    })
  );

  router.post(
    "/profiles/sync",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (_req, res) => {
      const result = await syncProfiles({ discover: true });
      res.json({ result });
    })
  );

  router.get(
    "/updates",
    requireManagementAuth(options.auth, "read"),
    asyncHandler(async (_req, res) => {
      res.json({ updates: await checkUpdates(), sync: await listSyncUpdates() });
    })
  );

  router.post(
    "/resources/:id/install",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const input = parseBody(installResourceSchema, req.body);
      const result = await installSyncResource({
        resource_id: resourceId(req.params.id),
        upstream_id: input.upstream_id,
        accept: input.accept
      });
      res.json({ result });
    })
  );

  router.post(
    "/enrollments/init",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const input = parseBody(enrollmentSchema, req.body);
      const enrollment = await initEnrollment(input);
      res.json({ enrollment });
    })
  );

  router.post(
    "/enrollments/complete",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const input = parseBody(enrollmentSchema, req.body);
      const enrollment = await completeEnrollment(input);
      res.json({ enrollment });
    })
  );

  router.post(
    "/enrollments/revoke",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const input = parseBody(revokeEnrollmentSchema, req.body);
      const enrollment = await revokeEnrollment(input);
      res.json({ enrollment });
    })
  );

  router.post(
    "/skills/:name/update",
    requireManagementAuth(options.auth, "write"),
    asyncHandler(async (req, res) => {
      const name = safeSkillName(req.params.name);
      parseBody(confirmSchema, req.body);
      const result = await updateSkill({
        name,
        sync_profiles: true,
        discover_profile_roots: true
      });
      res.json({ result });
    })
  );

  router.get(
    "/permissions",
    requireManagementAuth(options.auth, "read"),
    asyncHandler(async (_req, res) => {
      res.json({
        permissions: {
          mode: options.mode,
          roles: ["owner", "editor", "viewer"],
          account: managementAccount(options.mode),
          abilities: managementAbilities(options.mode),
          profiles: await listConfiguredProfiles(),
          capability_groups: listCapabilityGroups()
        }
      });
    })
  );

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  return router;
}

function managementContext(options: ManagementApiOptions): Record<string, unknown> {
  const config = loadConfig();
  const compatibility = options.ui?.compatibility ?? {
    status: "compatible",
    api_version: MANAGEMENT_API_VERSION,
    min_api_version: MANAGEMENT_API_VERSION
  };
  return {
    mode: options.mode,
    api_version: compatibility.api_version,
    ui_bundle_version: options.ui?.version ?? (options.mode === "local" ? "bundled" : "hosted"),
    ui_channel: options.ui?.channel ?? DEFAULT_UI_CHANNEL,
    ui_delivery: {
      source: options.ui?.source ?? (options.mode === "local" ? "bundled" : "hosted"),
      fallback_reason: options.ui?.fallbackReason
    },
    abilities: managementAbilities(options.mode),
    account: managementAccount(options.mode),
    vault: {
      mode: config.mode,
      storage_path: config.storagePath,
      db_path: config.dbPath
    },
    compatibility
  };
}

function managementAccount(mode: ManagementApiOptions["mode"]): {
  mode: "local" | "remote";
  label: string;
  provider: string;
} {
  return {
    mode,
    label: mode === "local" ? "Local operator" : "Cloud account",
    provider: mode === "local" ? "loopback session" : "remote auth"
  };
}

function managementAbilities(mode: ManagementApiOptions["mode"]): {
  can_add_skill: boolean;
  can_manage_users: boolean;
  can_invite_users: boolean;
  can_manage_billing: boolean;
  can_install_local: boolean;
  can_manage_upstreams: boolean;
} {
  return {
    can_add_skill: true,
    can_manage_users: mode === "remote",
    can_invite_users: mode === "remote",
    can_manage_billing: mode === "remote",
    can_install_local: mode === "local",
    can_manage_upstreams: true
  };
}

function requireManagementAuth(
  auth: ManagementAuthAdapter,
  access: "read" | "write"
): RequestHandler {
  return (req, res, next): void => {
    void Promise.resolve(access === "read" ? auth.read(req) : auth.write(req))
      .then((result) => {
        if (!result.ok) {
          res.status(result.status).json({ error: result.error });
          return;
        }
        res.locals.managementAuth = result.context;
        next();
      })
      .catch(next);
  };
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): RequestHandler {
  return (req, res, next): void => {
    void handler(req, res).catch(next);
  };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new ApiError(400, issues);
  }
  return parsed.data;
}

function safeSkillName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "Skill name is required");
  }
  try {
    assertSafeSkillName(value);
    return value;
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : String(error));
  }
}

function resourceId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "Resource id is required");
  }
  return value;
}

async function listSkills(): Promise<SkillSummaryResponse[]> {
  await ensureStorage();
  const names = (await listInstalledSkillNames()).sort((a, b) => a.localeCompare(b));
  const records = await Promise.all(names.map((name) => readSkill(name)));
  return records
    .filter((record): record is SkillRecord => record !== null)
    .map((record) => skillSummary(record));
}

function skillSummary(skill: SkillRecord): SkillSummaryResponse {
  return {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    version: skill.version,
    tags: skill.tags,
    category: skill.category,
    agents: skill.agents,
    when_to_use: skill.when_to_use,
    when_not_to_use: skill.when_not_to_use,
    risk_level: skill.risk_level,
    capabilities: skill.capabilities,
    requires_tools: skill.requires_tools,
    requires_secrets: skill.requires_secrets,
    actions: Object.keys(skill.bin).sort((a, b) => a.localeCompare(b)),
    resource_count: skill.resources.length
  };
}

async function skillDetail(skill: SkillRecord): Promise<SkillDetailResponse> {
  const parsed = matter(skill.skillMd);
  return {
    ...skillSummary(skill),
    skill_md: skill.skillMd,
    frontmatter: normalizeFrontmatter(parsed.data),
    resources: skill.resources,
    bin: skill.bin,
    bundle: await skillBundle(skill),
    provenance: await skillProvenance(skill.name)
  };
}

async function skillBundle(skill: SkillRecord): Promise<SkillDetailResponse["bundle"]> {
  const paths = resourcePathsForSkill(skill);
  const previewMap = new Map<string, string>();
  if (paths.length > 0) {
    const result = await readVerifiedSkillResources(skill.name, paths);
    if (result.kind === "ok") {
      for (const resource of result.resources) previewMap.set(resource.path, resource.content);
    }
  }
  const actionPaths = new Set(Object.values(skill.bin).map((action) => action.command));
  return {
    root: "SKILL.md",
    files: [
      bundleFile("SKILL.md", "file", "root", skill.skillMd),
      ...paths.map((resourcePath) => {
        const declared = skill.resources.find((resource) => resource.path === resourcePath);
        return bundleFile(
          resourcePath,
          declared?.type ?? "file",
          actionPaths.has(resourcePath) ? "actions" : "resources",
          previewMap.get(resourcePath)
        );
      })
    ]
  };
}

function bundleFile(
  filePath: string,
  type: string,
  group: SkillBundleFileResponse["group"],
  content?: string
): SkillBundleFileResponse {
  const kind = classifyBundleFile(filePath, type);
  const title = filePath.split("/").pop() || filePath;
  return {
    path: filePath,
    kind,
    group,
    title,
    type,
    summary: summaryForBundleFile(filePath, kind, group),
    preview_status: content === undefined ? "unavailable" : "loaded",
    ...(content === undefined ? {} : { preview: previewContent(content, kind) })
  };
}

function classifyBundleFile(filePath: string, type: string): SkillBundleFileResponse["kind"] {
  const lowerPath = filePath.toLowerCase();
  const lowerType = type.toLowerCase();
  if (lowerPath.endsWith(".md") || lowerType === "markdown") return "markdown";
  if (lowerPath.endsWith(".svg") || lowerType === "svg") return "svg";
  if (/\.(json|ya?ml|toml)$/.test(lowerPath) || lowerType === "data") return "data";
  if (/\.(c?js|mjs|ts|tsx|jsx|sh|py|rb|go|rs)$/.test(lowerPath) || lowerType === "script") return "script";
  if (/\.(txt|css|html)$/.test(lowerPath)) return "text";
  return "file";
}

function summaryForBundleFile(
  filePath: string,
  kind: SkillBundleFileResponse["kind"],
  group: SkillBundleFileResponse["group"]
): string {
  if (filePath === "SKILL.md") return "Primary instruction file and frontmatter.";
  if (group === "actions") return "Declared action resource; inspect only from the dashboard.";
  if (kind === "svg") return "Static vector asset included with the skill.";
  if (kind === "script") return "Script-like file included with the skill; shown as text only.";
  return "Declared skill resource.";
}

function previewContent(content: string, kind: SkillBundleFileResponse["kind"]): string {
  const max = kind === "svg" ? 20_000 : 12_000;
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n... truncated ${content.length - max} characters`;
}

async function skillProvenance(name: string): Promise<SkillProvenanceResponse> {
  const status = await readSkillSourceStatus(name);
  if (status.kind === "present" || status.kind === "legacy") {
    return {
      integrity: "signed",
      source: {
        status: status.kind,
        label: sourceDisplayName(status.source.source),
        identifier: status.source.identifier,
        fetched_at: status.source.fetchedAt,
        content_hash: status.source.contentHash
      }
    };
  }
  if (status.kind === "tampered") {
    return {
      integrity: "signed",
      source: {
        status: "tampered",
        label: "Source metadata invalid",
        reason: status.reason
      }
    };
  }
  return {
    integrity: "signed",
    source: {
      status: status.kind,
      label: status.kind === "absent" ? "No source metadata" : "Source metadata unreadable"
    }
  };
}

function rebuildSkillMarkdown(
  name: string,
  skillMd: string,
  patch: z.infer<typeof frontmatterPatchSchema>
): string {
  const parsed = matter(skillMd);
  const frontmatter = normalizeFrontmatter(parsed.data);
  frontmatter.name = name;
  applyOptionalString(frontmatter, "title", patch.title);
  applyOptionalString(frontmatter, "description", patch.description);
  applyOptionalString(frontmatter, "category", patch.category);
  applyOptionalString(frontmatter, "when_to_use", patch.when_to_use);
  applyOptionalString(frontmatter, "when_not_to_use", patch.when_not_to_use);
  applyOptionalString(frontmatter, "risk_level", patch.risk_level);
  if (patch.tags) frontmatter.tags = uniqueCleanList(patch.tags);
  if (patch.agents) frontmatter.agents = uniqueCleanList(patch.agents);
  if (patch.metadata) {
    const currentMetadata =
      typeof frontmatter.metadata === "object" &&
      frontmatter.metadata !== null &&
      !Array.isArray(frontmatter.metadata)
        ? frontmatter.metadata as Record<string, unknown>
        : {};
    frontmatter.metadata = { ...currentMetadata, ...patch.metadata };
  }
  return matter.stringify(parsed.content, frontmatter);
}

function applyOptionalString(
  frontmatter: Record<string, unknown>,
  key: string,
  value: string | null | undefined
): void {
  if (value === undefined) return;
  if (value === null) {
    delete frontmatter[key];
    return;
  }
  frontmatter[key] = value;
}

function uniqueCleanList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeFrontmatter(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  return { ...input as Record<string, unknown> };
}

function formatWarnings(result: Record<string, unknown>): string {
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  if (warnings.length > 0) return warnings.join("; ");
  return "validation failed";
}

function listCapabilityGroups(): Array<{
  name: string;
  description: string;
  tags: string[];
}> {
  const db = openCapabilityDb();
  return (
    db.prepare("SELECT name, description, tags_json FROM tool_groups ORDER BY name ASC").all() as Array<{
      name: string;
      description: string;
      tags_json: string;
    }>
  ).map((row) => ({
    name: row.name,
    description: row.description,
    tags: parseJsonArray(row.tags_json)
  }));
}

async function profilesPayload(): Promise<Awaited<ReturnType<typeof listConfiguredProfiles>>> {
  const [membership, config] = await Promise.all([
    listConfiguredProfiles(),
    loadNamedProfileConfig()
  ]);
  const exportOverrides = new Map(
    config.profiles.map((profile) => [profile.name, profile.exportSkillOverrides])
  );
  return {
    ...membership,
    profiles: membership.profiles.map((profile) => {
      const value = exportOverrides.get(profile.name);
      return value === undefined
        ? profile
        : { ...profile, export_skill_overrides: value };
    })
  };
}

export function sourceDisplayName(source: SkillSource["source"]): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "agentskills":
      return "Agent Skills";
    case "url":
      return "URL";
    case "inline":
      return "Inline";
    case "local":
      return "Local";
  }
}

export function localManagementAuthContext(): ManagementAuthContext {
  return {
    mode: "local",
    role: "owner"
  };
}

export function remoteRoleCanWrite(role: ManagementAuthContext["role"]): boolean {
  return role === "owner" || role === "editor";
}

export function currentManagementMode(): "local" | "remote" {
  return loadConfig().mode;
}
