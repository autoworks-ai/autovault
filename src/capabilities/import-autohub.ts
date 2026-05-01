import fs from "node:fs/promises";
import path from "node:path";
import { openCapabilityDb, type CapabilityDb, jsonArray } from "./db.js";
import { DEFAULT_GROUP_ALIASES, DEFAULT_GROUP_SERVERS } from "./defaults.js";
import { log } from "../util/log.js";

type JsonRecord = Record<string, unknown>;

export type ImportAutohubInput = {
  toolFiltersPath: string;
  mcpServersPath?: string;
  db?: CapabilityDb;
  reset?: boolean;
};

export type ImportAutohubResult = {
  profiles: number;
  toolGroups: number;
  contextRules: number;
  mcpServers: number;
  warnings: string[];
};

function parseJsonWithComments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    let cleaned = text.replace(/\/\*[\s\S]*?\*\//g, "");
    cleaned = cleaned
      .split("\n")
      .map((line) => (/^\s*\/\//.test(line) ? "" : line))
      .join("\n");
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleaned);
  }
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = parseJsonWithComments(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed as JsonRecord;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function bool(value: unknown): number {
  return value === true ? 1 : 0;
}

function isLikelySecretArg(arg: string): boolean {
  if (arg.includes("${")) return false;
  if (arg.includes("/") || arg.startsWith(".") || arg.startsWith("-")) return false;
  if (/^(xox[abp]-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|AC[a-f0-9]{32})/i.test(arg)) return true;
  return arg.length > 40 && /[:=_-]/.test(arg);
}

function sanitizeArgs(args: unknown, warnings: string[], serverName: string): string[] {
  return asStringArray(args).map((arg, index) => {
    if (!isLikelySecretArg(arg)) return arg;
    warnings.push(`Redacted likely secret argument ${index} for MCP server "${serverName}".`);
    return `<redacted:arg_${index}>`;
  });
}

function envRequired(env: unknown, warnings: string[], serverName: string): string[] {
  const record = asRecord(env);
  const required: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    required.push(key);
    if (typeof value === "string" && value && !value.includes("${")) {
      warnings.push(`Dropped literal env value for ${serverName}.${key}; only the env var name was stored.`);
    }
  }
  return required;
}

function resetTables(db: CapabilityDb): void {
  db.exec(`
    DELETE FROM channel_overrides;
    DELETE FROM callers;
    DELETE FROM profiles;
    DELETE FROM group_tools;
    DELETE FROM group_servers;
    DELETE FROM group_skills;
    DELETE FROM group_aliases;
    DELETE FROM context_rules;
    DELETE FROM always_enabled;
    DELETE FROM disabled_patterns;
    DELETE FROM tool_groups;
    DELETE FROM mcp_servers;
  `);
}

function insertCaller(db: CapabilityDb, id: string, profileId: string, role: string): void {
  db.prepare(
    `INSERT INTO callers(id, profile_id, role)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, role = excluded.role`
  ).run(id, profileId, role);
}

function insertChannelOverride(
  db: CapabilityDb,
  callerId: string,
  platform: string,
  channel: string,
  grant: JsonRecord,
  description = ""
): void {
  db.prepare(
    `INSERT INTO channel_overrides(
       caller_id, platform, channel, groups_added_json, groups_removed_json, tools_added_json, profile_id, description
     ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)
     ON CONFLICT(caller_id, platform, channel) DO UPDATE SET
       groups_added_json = excluded.groups_added_json,
       tools_added_json = excluded.tools_added_json,
       profile_id = excluded.profile_id,
       description = excluded.description`
  ).run(
    callerId,
    platform,
    channel,
    jsonArray(grant.allowGroups),
    jsonArray(grant.allowTools),
    typeof grant.profile === "string" ? grant.profile : null,
    description || String(grant.description ?? "")
  );
}

function importAccessGrants(db: CapabilityDb, accessGrants: JsonRecord): void {
  const slack = asRecord(accessGrants.slack);
  const slackWorkspaces = asRecord(slack.workspaces);
  for (const workspace of Object.values(slackWorkspaces)) {
    const workspaceRecord = asRecord(workspace);
    const channels = asRecord(workspaceRecord.channels);
    for (const [channelId, channelGrant] of Object.entries(channels)) {
      const grant = asRecord(channelGrant);
      insertChannelOverride(db, "guest", "slack", channelId, grant, String(grant.description ?? ""));
      const users = asRecord(grant.users);
      for (const [userId, userGrant] of Object.entries(users)) {
        insertCaller(db, userId, "auto", "user");
        insertChannelOverride(db, userId, "slack", channelId, asRecord(userGrant), String(asRecord(userGrant).description ?? ""));
      }
    }
  }
  const slackUsers = asRecord(slack.users);
  for (const [userId, grant] of Object.entries(slackUsers)) {
    const profile = typeof asRecord(grant).profile === "string" ? String(asRecord(grant).profile) : "auto";
    insertCaller(db, userId, profile, profile === "full" ? "owner" : "user");
  }

  const discord = asRecord(accessGrants.discord);
  const guilds = asRecord(discord.guilds);
  for (const guild of Object.values(guilds)) {
    const channels = asRecord(asRecord(guild).channels);
    for (const [channelId, grant] of Object.entries(channels)) {
      insertChannelOverride(db, "guest", "discord", channelId, asRecord(grant), String(asRecord(grant).description ?? ""));
    }
  }
}

function importAliases(db: CapabilityDb): void {
  const insert = db.prepare("INSERT OR IGNORE INTO group_aliases(alias, group_name) VALUES (?, ?)");
  for (const [alias, target] of Object.entries(DEFAULT_GROUP_ALIASES)) {
    const groups = Array.isArray(target) ? target : [target];
    for (const group of groups) insert.run(alias, group);
  }
}

function importGroupServers(db: CapabilityDb): void {
  const insert = db.prepare("INSERT OR IGNORE INTO group_servers(group_name, server_name) VALUES (?, ?)");
  const ensureGroup = db.prepare("INSERT OR IGNORE INTO tool_groups(name, description, tags_json) VALUES (?, '', '[]')");
  for (const [group, servers] of Object.entries(DEFAULT_GROUP_SERVERS)) {
    ensureGroup.run(group);
    for (const server of servers) insert.run(group, server);
  }
}

export async function importAutohubCapabilities(input: ImportAutohubInput): Promise<ImportAutohubResult> {
  const db = input.db ?? openCapabilityDb();
  const warnings: string[] = [];
  const toolFilters = await readJson(input.toolFiltersPath);
  const mcpServers = input.mcpServersPath ? await readJson(input.mcpServersPath) : {};

  if (input.reset) resetTables(db);

  const tx = db.transaction(() => {
    const profiles = asRecord(toolFilters.profiles);
    db.prepare(
      `INSERT INTO meta(key, value) VALUES ('active_profile', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(typeof toolFilters.activeProfile === "string" ? toolFilters.activeProfile : "auto");

    const insertProfile = db.prepare(
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
    for (const [id, profileValue] of Object.entries(profiles)) {
      const profile = asRecord(profileValue);
      const ownerFeatures = asRecord(profile.ownerFeatures);
      insertProfile.run(
        id,
        String(profile.description ?? ""),
        jsonArray(profile.groups),
        bool(profile.noIntentExpansion),
        bool(ownerFeatures.allowFullOnRequest),
        ownerFeatures.expandIntentServers === false ? 0 : 1,
        bool(ownerFeatures.bypassDisabledOnIntent)
      );
    }

    insertCaller(db, "owner", "owner-auto", "owner");
    insertCaller(db, "guest", "auto", "guest");
    insertCaller(db, "autojack", "owner-auto", "owner");

    const toolGroups = asRecord(toolFilters.toolGroups);
    const meta = asRecord(toolFilters.toolGroupMeta);
    const insertGroup = db.prepare(
      `INSERT INTO tool_groups(name, description, tags_json)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET description = excluded.description, tags_json = excluded.tags_json`
    );
    const insertTool = db.prepare("INSERT OR IGNORE INTO group_tools(group_name, pattern) VALUES (?, ?)");
    for (const [name, tools] of Object.entries(toolGroups)) {
      const groupMeta = asRecord(meta[name]);
      insertGroup.run(name, String(groupMeta.description ?? ""), jsonArray(groupMeta.tags));
      for (const tool of asStringArray(tools)) insertTool.run(name, tool);
    }

    const insertRule = db.prepare(
      `INSERT INTO context_rules(id, pattern, priority, groups_json, servers_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pattern = excluded.pattern,
         priority = excluded.priority,
         groups_json = excluded.groups_json,
         servers_json = excluded.servers_json`
    );
    for (const ruleValue of Array.isArray(toolFilters.contextRules) ? toolFilters.contextRules : []) {
      const rule = asRecord(ruleValue);
      const id = typeof rule.id === "string" ? rule.id : `rule-${String(rule.pattern ?? "").slice(0, 32)}`;
      insertRule.run(id, String(rule.pattern ?? ""), Number(rule.priority ?? 0), jsonArray(rule.enableGroups), jsonArray(rule.startServers));
    }

    const insertAlways = db.prepare("INSERT OR IGNORE INTO always_enabled(pattern) VALUES (?)");
    for (const pattern of asStringArray(toolFilters.alwaysEnabled)) insertAlways.run(pattern);

    const insertDisabled = db.prepare("INSERT OR IGNORE INTO disabled_patterns(pattern) VALUES (?)");
    for (const pattern of asStringArray(toolFilters.disabled)) insertDisabled.run(pattern);

    importAliases(db);
    importGroupServers(db);
    importAccessGrants(db, asRecord(toolFilters.accessGrants));

    const servers = asRecord(mcpServers.servers);
    const insertServer = db.prepare(
      `INSERT INTO mcp_servers(name, command, args_json, env_required_json, description, auto_load, local, disabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         command = excluded.command,
         args_json = excluded.args_json,
         env_required_json = excluded.env_required_json,
         description = excluded.description,
         auto_load = excluded.auto_load,
         local = excluded.local,
         disabled = excluded.disabled`
    );
    for (const [name, serverValue] of Object.entries(servers)) {
      const server = asRecord(serverValue);
      insertServer.run(
        name,
        String(server.command ?? ""),
        jsonArray(sanitizeArgs(server.args, warnings, name)),
        jsonArray(envRequired(server.env, warnings, name)),
        String(server.description ?? ""),
        bool(server.autoLoad),
        bool(server.local),
        bool(server.disabled)
      );
    }
  });

  tx();
  log.info("capabilities.import_autohub", {
    toolFiltersPath: path.resolve(input.toolFiltersPath),
    mcpServersPath: input.mcpServersPath ? path.resolve(input.mcpServersPath) : null
  });

  const count = (table: string): number =>
    Number((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);

  return {
    profiles: count("profiles"),
    toolGroups: count("tool_groups"),
    contextRules: count("context_rules"),
    mcpServers: count("mcp_servers"),
    warnings
  };
}

export async function ensureAutohubSeeded(input: Omit<ImportAutohubInput, "reset">): Promise<boolean> {
  const db = input.db ?? openCapabilityDb();
  const existing = db.prepare("SELECT count(*) AS count FROM tool_groups").get() as { count: number };
  if (Number(existing.count) > 0) return false;
  await importAutohubCapabilities({ ...input, db, reset: true });
  return true;
}
