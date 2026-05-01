import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { listInstalledSkillNames, readSkill } from "../storage/index.js";
import {
  openCapabilityDb,
  jsonArray,
  parseJsonArray,
  parseJsonObject,
  type CapabilityDb
} from "./db.js";
import { matchesAny, parseContextPattern, serverFromToolPattern, wildcardMatches } from "./match.js";

export type ResolveCapabilitiesInput = {
  query: string;
  caller_id: string;
  platform: "slack" | "cli" | "voice" | "web" | "discord" | "whatsapp" | string;
  channel?: string;
  mode?: "hard" | "semantic" | "auto";
};

export type ResolvedTool = {
  name: string;
  pattern: string;
  mcp_server?: string;
  group: string;
  permission_scope: string;
};

export type ResolvedSkill = {
  name: string;
  path: string;
  frontmatter: Record<string, unknown>;
  agents: string[];
};

export type ResolvedMcpServer = {
  name: string;
  command: string;
  args: string[];
  env_required: string[];
};

export type ResolveCapabilitiesResult = {
  tools: ResolvedTool[];
  skills: ResolvedSkill[];
  mcp_servers: ResolvedMcpServer[];
  matched_groups: string[];
  cache_key: string;
};

type ProfileRow = {
  id: string;
  groups_json: string;
  no_intent_expansion: number;
};

type CallerRow = {
  id: string;
  profile_id: string;
  role: string;
};

type ContextRuleRow = {
  id: string;
  pattern: string;
  priority: number;
  groups_json: string;
  servers_json: string;
};

type McpServerRow = {
  name: string;
  command: string;
  args_json: string;
  env_required_json: string;
  disabled: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function boolNumber(value: unknown): number {
  return value === true ? 1 : 0;
}

function cacheKey(input: ResolveCapabilitiesInput, groups: string[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      caller_id: input.caller_id,
      platform: input.platform,
      channel: input.channel ?? "",
      mode: input.mode ?? "hard",
      query: input.query,
      groups
    }))
    .digest("hex");
}

function expandGroupStar(db: CapabilityDb, groups: string[]): string[] {
  if (!groups.includes("*")) return groups;
  const rows = db.prepare("SELECT name FROM tool_groups ORDER BY name").all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function addGroup(target: Map<string, string>, group: string, scope: string): void {
  if (!group) return;
  if (!target.has(group)) target.set(group, scope);
}

function matchQueryGroups(db: CapabilityDb, query: string): Array<{ group: string; scope: string; servers: string[] }> {
  const normalized = query.toLowerCase().trim();
  if (!normalized) return [];
  const groups: Array<{ group: string; scope: string; servers: string[] }> = [];

  const groupRows = db.prepare("SELECT name, description, tags_json FROM tool_groups").all() as Array<{
    name: string;
    description: string;
    tags_json: string;
  }>;
  for (const row of groupRows) {
    const lowerName = row.name.toLowerCase();
    if (normalized === lowerName || lowerName.startsWith(normalized) || normalized.includes(lowerName.replace(/_/g, " "))) {
      groups.push({ group: row.name, scope: "query", servers: [] });
    }
  }

  const aliasRows = db.prepare("SELECT alias, group_name FROM group_aliases").all() as Array<{ alias: string; group_name: string }>;
  for (const row of aliasRows) {
    const alias = row.alias.toLowerCase();
    const pattern = new RegExp(`(^|\\W)${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`, "i");
    if (normalized === alias || pattern.test(normalized)) {
      groups.push({ group: row.group_name, scope: "alias", servers: [] });
    }
  }

  if (groups.length === 0) {
    for (const row of groupRows) {
      const description = row.description.toLowerCase();
      const tags = parseJsonArray(row.tags_json).map((tag) => tag.toLowerCase());
      if (description.includes(normalized) || tags.some((tag) => tag.includes(normalized) || (tag.length >= 3 && normalized.includes(tag)))) {
        groups.push({ group: row.name, scope: "keyword", servers: [] });
      }
    }
  }

  return groups;
}

function matchContextRules(db: CapabilityDb, query: string, noIntentExpansion: boolean): Array<{ group: string; scope: string; servers: string[] }> {
  if (noIntentExpansion || !query) return [];
  const rows = db
    .prepare("SELECT id, pattern, priority, groups_json, servers_json FROM context_rules ORDER BY priority DESC")
    .all() as ContextRuleRow[];
  const matches: Array<{ group: string; scope: string; servers: string[] }> = [];
  for (const row of rows) {
    const regex = parseContextPattern(row.pattern);
    if (!regex) continue;
    regex.lastIndex = 0;
    if (!regex.test(query)) continue;
    const servers = parseJsonArray(row.servers_json);
    for (const group of parseJsonArray(row.groups_json)) {
      matches.push({ group, scope: "context", servers });
    }
  }
  return matches;
}

function applyChannelOverride(
  db: CapabilityDb,
  input: ResolveCapabilitiesInput,
  groups: Map<string, string>
): { extraTools: Array<{ pattern: string; scope: string }>; profileId?: string } {
  if (!input.channel) return { extraTools: [] };
  const row = db
    .prepare(
      `SELECT groups_added_json, groups_removed_json, tools_added_json, profile_id
       FROM channel_overrides
       WHERE caller_id = ? AND platform = ? AND channel = ?`
    )
    .get(input.caller_id, input.platform, input.channel) as
    | { groups_added_json: string; groups_removed_json: string; tools_added_json: string; profile_id: string | null }
    | undefined;
  const fallbackRow = input.caller_id === "guest"
    ? undefined
    : db
      .prepare(
        `SELECT groups_added_json, groups_removed_json, tools_added_json, profile_id
         FROM channel_overrides
         WHERE caller_id = 'guest' AND platform = ? AND channel = ?`
      )
      .get(input.platform, input.channel) as
      | { groups_added_json: string; groups_removed_json: string; tools_added_json: string; profile_id: string | null }
      | undefined;

  const apply = (override: typeof row): Array<{ pattern: string; scope: string }> => {
    if (!override) return [];
    for (const group of parseJsonArray(override.groups_removed_json)) groups.delete(group);
    for (const group of parseJsonArray(override.groups_added_json)) addGroup(groups, group, "channel");
    return parseJsonArray(override.tools_added_json).map((pattern) => ({ pattern, scope: "channel" }));
  };

  return {
    extraTools: [...apply(fallbackRow), ...apply(row)],
    profileId: row?.profile_id ?? fallbackRow?.profile_id ?? undefined
  };
}

function buildTools(
  db: CapabilityDb,
  groupScopes: Map<string, string>,
  extraTools: Array<{ pattern: string; scope: string }>
): ResolvedTool[] {
  const disabled = new Set(
    (db.prepare("SELECT pattern FROM disabled_patterns").all() as Array<{ pattern: string }>).map((row) => row.pattern)
  );
  const results: ResolvedTool[] = [];
  const seen = new Set<string>();

  const addTool = (pattern: string, group: string, scope: string): void => {
    if (matchesAny(pattern, disabled)) return;
    if ([...disabled].some((disabledPattern) => wildcardMatches(disabledPattern, pattern))) return;
    const key = `${group}:${pattern}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      name: pattern,
      pattern,
      mcp_server: serverFromToolPattern(pattern),
      group,
      permission_scope: scope
    });
  };

  for (const row of db.prepare("SELECT pattern FROM always_enabled").all() as Array<{ pattern: string }>) {
    addTool(row.pattern, "always", "always");
  }

  for (const [group, scope] of groupScopes.entries()) {
    const rows = db.prepare("SELECT pattern FROM group_tools WHERE group_name = ?").all(group) as Array<{ pattern: string }>;
    for (const row of rows) addTool(row.pattern, group, scope);
  }

  for (const tool of extraTools) addTool(tool.pattern, "direct", tool.scope);
  return results;
}

async function resolvedSkills(db: CapabilityDb, groups: string[]): Promise<ResolvedSkill[]> {
  const names = new Set<string>();
  for (const group of groups) {
    const rows = db.prepare("SELECT skill_name FROM group_skills WHERE group_name = ?").all(group) as Array<{ skill_name: string }>;
    rows.forEach((row) => names.add(row.skill_name));
  }

  const dbRows = db.prepare("SELECT name FROM skills").all() as Array<{ name: string }>;
  dbRows.forEach((row) => names.add(row.name));
  if (names.size === 0) {
    for (const name of await listInstalledSkillNames()) names.add(name);
  }

  const root = loadConfig().storagePath;
  const skills: ResolvedSkill[] = [];
  for (const name of [...names].sort()) {
    const record = await readSkill(name);
    if (!record) continue;
    const skillPath = `${root}/skills/${name}/SKILL.md`;
    skills.push({
      name,
      path: skillPath,
      frontmatter: {
        name: record.name,
        description: record.description,
        tags: record.tags,
        category: record.category,
        version: record.version
      },
      agents: record.agents
    });
  }
  return skills;
}

function resolvedServers(db: CapabilityDb, groups: string[], extraServers: string[], tools: ResolvedTool[]): ResolvedMcpServer[] {
  const serverNames = new Set(extraServers);
  for (const group of groups) {
    const rows = db.prepare("SELECT server_name FROM group_servers WHERE group_name = ?").all(group) as Array<{ server_name: string }>;
    rows.forEach((row) => row.server_name && serverNames.add(row.server_name));
  }
  for (const tool of tools) {
    if (tool.mcp_server) serverNames.add(tool.mcp_server);
  }

  const servers: ResolvedMcpServer[] = [];
  for (const name of [...serverNames].sort()) {
    const row = db.prepare("SELECT name, command, args_json, env_required_json, disabled FROM mcp_servers WHERE name = ?").get(name) as McpServerRow | undefined;
    if (!row || row.disabled) continue;
    servers.push({
      name: row.name,
      command: row.command,
      args: parseJsonArray(row.args_json),
      env_required: parseJsonArray(row.env_required_json)
    });
  }
  return servers;
}

export async function resolveCapabilities(
  input: ResolveCapabilitiesInput,
  db: CapabilityDb = openCapabilityDb()
): Promise<ResolveCapabilitiesResult> {
  const caller = db.prepare("SELECT id, profile_id, role FROM callers WHERE id = ?").get(input.caller_id) as CallerRow | undefined;
  if (!caller) {
    return { tools: [], skills: [], mcp_servers: [], matched_groups: [], cache_key: cacheKey(input, []) };
  }

  let profile = db.prepare("SELECT id, groups_json, no_intent_expansion FROM profiles WHERE id = ?").get(caller.profile_id) as ProfileRow | undefined;
  if (!profile) {
    return { tools: [], skills: [], mcp_servers: [], matched_groups: [], cache_key: cacheKey(input, []) };
  }

  const groupScopes = new Map<string, string>();
  for (const group of expandGroupStar(db, parseJsonArray(profile.groups_json))) {
    addGroup(groupScopes, group, "profile");
  }

  const channel = applyChannelOverride(db, input, groupScopes);
  if (channel.profileId) {
    const overrideProfile = db.prepare("SELECT id, groups_json, no_intent_expansion FROM profiles WHERE id = ?").get(channel.profileId) as ProfileRow | undefined;
    if (overrideProfile) {
      profile = overrideProfile;
      for (const group of expandGroupStar(db, parseJsonArray(profile.groups_json))) addGroup(groupScopes, group, "profile_override");
    }
  }

  const extraServers: string[] = [];
  for (const match of matchContextRules(db, input.query, Boolean(profile.no_intent_expansion))) {
    addGroup(groupScopes, match.group, match.scope);
    extraServers.push(...match.servers);
  }
  for (const match of matchQueryGroups(db, input.query)) {
    addGroup(groupScopes, match.group, match.scope);
    extraServers.push(...match.servers);
  }

  const groups = [...groupScopes.keys()].sort();
  const tools = buildTools(db, groupScopes, channel.extraTools);
  return {
    tools,
    skills: await resolvedSkills(db, groups),
    mcp_servers: resolvedServers(db, groups, extraServers, tools),
    matched_groups: groups,
    cache_key: cacheKey(input, groups)
  };
}

export const resolve_capabilities = resolveCapabilities;

export function exportCapabilityConfig(db: CapabilityDb = openCapabilityDb()): Record<string, unknown> {
  const activeProfile = (db.prepare("SELECT value FROM meta WHERE key = 'active_profile'").get() as { value?: string } | undefined)?.value ?? "auto";
  const profiles: Record<string, unknown> = {};
  for (const row of db.prepare("SELECT * FROM profiles").all() as Array<Record<string, unknown>>) {
    profiles[String(row.id)] = {
      description: row.description,
      groups: parseJsonArray(row.groups_json),
      noIntentExpansion: Boolean(row.no_intent_expansion),
      ownerFeatures: {
        allowFullOnRequest: Boolean(row.allow_full_on_request),
        expandIntentServers: Boolean(row.expand_intent_servers),
        bypassDisabledOnIntent: Boolean(row.bypass_disabled_on_intent)
      }
    };
  }

  const toolGroups: Record<string, string[]> = {};
  for (const row of db.prepare("SELECT name FROM tool_groups").all() as Array<{ name: string }>) {
    toolGroups[row.name] = (db.prepare("SELECT pattern FROM group_tools WHERE group_name = ?").all(row.name) as Array<{ pattern: string }>)
      .map((tool) => tool.pattern);
  }

  const toolGroupMeta: Record<string, unknown> = {};
  for (const row of db.prepare("SELECT name, description, tags_json FROM tool_groups").all() as Array<{ name: string; description: string; tags_json: string }>) {
    toolGroupMeta[row.name] = { description: row.description, tags: parseJsonArray(row.tags_json) };
  }

  const contextRules = (db.prepare("SELECT id, pattern, priority, groups_json, servers_json FROM context_rules ORDER BY priority DESC").all() as ContextRuleRow[])
    .map((rule) => ({
      id: rule.id,
      pattern: rule.pattern,
      priority: rule.priority,
      enableGroups: parseJsonArray(rule.groups_json),
      startServers: parseJsonArray(rule.servers_json)
    }));

  const aliases: Record<string, string[]> = {};
  for (const row of db.prepare("SELECT alias, group_name FROM group_aliases").all() as Array<{ alias: string; group_name: string }>) {
    aliases[row.alias] = aliases[row.alias] ?? [];
    aliases[row.alias].push(row.group_name);
  }

  const groupServers: Record<string, string[]> = {};
  for (const row of db.prepare("SELECT group_name, server_name FROM group_servers").all() as Array<{ group_name: string; server_name: string }>) {
    groupServers[row.group_name] = groupServers[row.group_name] ?? [];
    groupServers[row.group_name].push(row.server_name);
  }

  const callers = Object.fromEntries((db.prepare("SELECT id, profile_id, role, platform_overrides_json FROM callers").all() as Array<{
    id: string;
    profile_id: string;
    role: string;
    platform_overrides_json: string;
  }>).map((caller) => [caller.id, {
    profile: caller.profile_id,
    role: caller.role,
    platformOverrides: parseJsonObject(caller.platform_overrides_json)
  }]));

  const profileGroups = (profileId: string): string[] => parseJsonArray(
    String((db.prepare("SELECT groups_json FROM profiles WHERE id = ?").get(profileId) as { groups_json?: string } | undefined)?.groups_json ?? "[]")
  );

  const channelOverrides = (db.prepare("SELECT * FROM channel_overrides").all() as Array<Record<string, unknown>>)
    .map((row) => ({
      callerId: row.caller_id,
      platform: row.platform,
      channel: row.channel,
      allowGroups: parseJsonArray(row.groups_added_json),
      denyGroups: parseJsonArray(row.groups_removed_json),
      allowTools: parseJsonArray(row.tools_added_json),
      profile: row.profile_id || undefined,
      description: row.description
    }));

  return {
    version: "sqlite",
    activeProfile,
    globalSettings: {
      maxToolsPerRequest: 100,
      enableContextAwareness: true,
      defaultMode: "contextual",
      lazyServerStartup: true
    },
    profiles,
    roles: {
      owner: {
        description: "Owner profile from AutoVault callers",
        defaultProfile: "owner-auto",
        groups: profileGroups("owner-auto"),
        bypassDisabled: true
      },
      nonOwner: {
        description: "Guest profile from AutoVault callers",
        defaultProfile: "auto",
        groups: profileGroups("auto"),
        bypassDisabled: false
      }
    },
    callers,
    toolGroups,
    toolGroupMeta,
    contextRules,
    alwaysEnabled: (db.prepare("SELECT pattern FROM always_enabled").all() as Array<{ pattern: string }>).map((row) => row.pattern),
    disabled: (db.prepare("SELECT pattern FROM disabled_patterns").all() as Array<{ pattern: string }>).map((row) => row.pattern),
    _channelOverrides: channelOverrides,
    _aliases: aliases,
    _groupServers: groupServers
  };
}

export function saveCapabilityConfig(config: Record<string, unknown>, db: CapabilityDb = openCapabilityDb()): void {
  const profiles = asRecord(config.profiles);
  const toolGroups = asRecord(config.toolGroups);
  const toolGroupMeta = asRecord(config.toolGroupMeta);
  const roles = asRecord(config.roles);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO meta(key, value) VALUES ('active_profile', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(typeof config.activeProfile === "string" ? config.activeProfile : "auto");

    const upsertProfile = db.prepare(
      `INSERT INTO profiles(
        id, description, groups_json, no_intent_expansion, allow_full_on_request,
        expand_intent_servers, bypass_disabled_on_intent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        groups_json = excluded.groups_json,
        no_intent_expansion = excluded.no_intent_expansion,
        allow_full_on_request = excluded.allow_full_on_request,
        expand_intent_servers = excluded.expand_intent_servers,
        bypass_disabled_on_intent = excluded.bypass_disabled_on_intent`
    );

    for (const [id, value] of Object.entries(profiles)) {
      const profile = asRecord(value);
      const ownerFeatures = asRecord(profile.ownerFeatures);
      upsertProfile.run(
        id,
        String(profile.description ?? ""),
        jsonArray(profile.groups),
        boolNumber(profile.noIntentExpansion),
        boolNumber(ownerFeatures.allowFullOnRequest),
        ownerFeatures.expandIntentServers === false ? 0 : 1,
        boolNumber(ownerFeatures.bypassDisabledOnIntent)
      );
    }

    for (const value of Object.values(roles)) {
      const role = asRecord(value);
      const profileId = typeof role.defaultProfile === "string" ? role.defaultProfile : typeof role.profile === "string" ? role.profile : "";
      if (!profileId || !Array.isArray(role.groups)) continue;
      const existing = asRecord(profiles[profileId]);
      upsertProfile.run(
        profileId,
        String(existing.description ?? role.description ?? ""),
        jsonArray(role.groups),
        boolNumber(existing.noIntentExpansion),
        boolNumber(asRecord(existing.ownerFeatures).allowFullOnRequest),
        asRecord(existing.ownerFeatures).expandIntentServers === false ? 0 : 1,
        boolNumber(asRecord(existing.ownerFeatures).bypassDisabledOnIntent)
      );
    }

    db.prepare("DELETE FROM group_tools").run();
    const upsertGroup = db.prepare(
      `INSERT INTO tool_groups(name, description, tags_json)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET description = excluded.description, tags_json = excluded.tags_json`
    );
    const insertGroupTool = db.prepare("INSERT OR IGNORE INTO group_tools(group_name, pattern) VALUES (?, ?)");
    for (const [name, patterns] of Object.entries(toolGroups)) {
      const meta = asRecord(toolGroupMeta[name]);
      upsertGroup.run(name, String(meta.description ?? ""), jsonArray(meta.tags));
      for (const pattern of asStringArray(patterns)) insertGroupTool.run(name, pattern);
    }
    for (const [name, metaValue] of Object.entries(toolGroupMeta)) {
      const meta = asRecord(metaValue);
      upsertGroup.run(name, String(meta.description ?? ""), jsonArray(meta.tags));
    }

    db.prepare("DELETE FROM context_rules").run();
    const insertRule = db.prepare(
      `INSERT INTO context_rules(id, pattern, priority, groups_json, servers_json)
       VALUES (?, ?, ?, ?, ?)`
    );
    const contextRules = Array.isArray(config.contextRules) ? config.contextRules : [];
    for (const ruleValue of contextRules) {
      const rule = asRecord(ruleValue);
      const id = typeof rule.id === "string" ? rule.id : `rule-${String(rule.pattern ?? "").slice(0, 32)}`;
      insertRule.run(id, String(rule.pattern ?? ""), Number(rule.priority ?? 0), jsonArray(rule.enableGroups), jsonArray(rule.startServers));
    }

    db.prepare("DELETE FROM always_enabled").run();
    const insertAlways = db.prepare("INSERT OR IGNORE INTO always_enabled(pattern) VALUES (?)");
    for (const pattern of asStringArray(config.alwaysEnabled)) insertAlways.run(pattern);

    db.prepare("DELETE FROM disabled_patterns").run();
    const insertDisabled = db.prepare("INSERT OR IGNORE INTO disabled_patterns(pattern) VALUES (?)");
    for (const pattern of asStringArray(config.disabled)) insertDisabled.run(pattern);
  });

  tx();
}
