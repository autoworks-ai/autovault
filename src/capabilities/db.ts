import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config.js";

export type CapabilityDb = Database.Database;

let cachedDb: CapabilityDb | null = null;

export function openCapabilityDb(dbPath = loadConfig().dbPath): CapabilityDb {
  if (cachedDb && cachedDb.name === dbPath) return cachedDb;
  cachedDb?.close();
  cachedDb = null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateCapabilityDb(db);
  cachedDb = db;
  return db;
}

export function closeCapabilityDb(): void {
  cachedDb?.close();
  cachedDb = null;
}

export function resetCapabilityDbForTests(): void {
  closeCapabilityDb();
}

export function migrateCapabilityDb(db: CapabilityDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      groups_json TEXT NOT NULL DEFAULT '[]',
      no_intent_expansion INTEGER NOT NULL DEFAULT 0,
      allow_full_on_request INTEGER NOT NULL DEFAULT 0,
      expand_intent_servers INTEGER NOT NULL DEFAULT 1,
      bypass_disabled_on_intent INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS callers (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      role TEXT NOT NULL DEFAULT 'guest',
      platform_overrides_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS channel_overrides (
      caller_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      channel TEXT NOT NULL,
      groups_added_json TEXT NOT NULL DEFAULT '[]',
      groups_removed_json TEXT NOT NULL DEFAULT '[]',
      tools_added_json TEXT NOT NULL DEFAULT '[]',
      profile_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (caller_id, platform, channel)
    );

    CREATE TABLE IF NOT EXISTS tool_groups (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS group_tools (
      group_name TEXT NOT NULL REFERENCES tool_groups(name) ON DELETE CASCADE,
      pattern TEXT NOT NULL,
      PRIMARY KEY (group_name, pattern)
    );

    CREATE TABLE IF NOT EXISTS group_servers (
      group_name TEXT NOT NULL REFERENCES tool_groups(name) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      PRIMARY KEY (group_name, server_name)
    );

    CREATE TABLE IF NOT EXISTS group_skills (
      group_name TEXT NOT NULL REFERENCES tool_groups(name) ON DELETE CASCADE,
      skill_name TEXT NOT NULL,
      PRIMARY KEY (group_name, skill_name)
    );

    CREATE TABLE IF NOT EXISTS group_aliases (
      alias TEXT NOT NULL,
      group_name TEXT NOT NULL,
      PRIMARY KEY (alias, group_name)
    );

    CREATE TABLE IF NOT EXISTS context_rules (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      groups_json TEXT NOT NULL DEFAULT '[]',
      servers_json TEXT NOT NULL DEFAULT '[]',
      profiles_json TEXT NOT NULL DEFAULT '[]',
      exclude_profiles_json TEXT NOT NULL DEFAULT '[]',
      grant_server_tools INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS always_enabled (
      pattern TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS disabled_patterns (
      pattern TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      frontmatter_json TEXT NOT NULL DEFAULT '{}',
      agents_json TEXT NOT NULL DEFAULT '[]',
      installed_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'local',
      signature TEXT
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      name TEXT PRIMARY KEY,
      command TEXT NOT NULL DEFAULT '',
      args_json TEXT NOT NULL DEFAULT '[]',
      env_required_json TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      auto_load INTEGER NOT NULL DEFAULT 0,
      local INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS remote_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      caller_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_oauth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES remote_users(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      resource TEXT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_oauth_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES remote_users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      resource TEXT,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_group_tools_group ON group_tools(group_name);
    CREATE INDEX IF NOT EXISTS idx_group_servers_group ON group_servers(group_name);
    CREATE INDEX IF NOT EXISTS idx_context_rules_priority ON context_rules(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_remote_oauth_codes_expires ON remote_oauth_codes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_remote_oauth_tokens_user ON remote_oauth_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_remote_oauth_tokens_expires ON remote_oauth_tokens(expires_at);
  `);

  const contextRuleColumns = new Set(
    (
      db.prepare("PRAGMA table_info(context_rules)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name)
  );
  if (!contextRuleColumns.has("profiles_json")) {
    db.prepare(
      "ALTER TABLE context_rules ADD COLUMN profiles_json TEXT NOT NULL DEFAULT '[]'"
    ).run();
  }
  if (!contextRuleColumns.has("exclude_profiles_json")) {
    db.prepare(
      "ALTER TABLE context_rules ADD COLUMN exclude_profiles_json TEXT NOT NULL DEFAULT '[]'"
    ).run();
  }
  if (!contextRuleColumns.has("grant_server_tools")) {
    db.prepare(
      "ALTER TABLE context_rules ADD COLUMN grant_server_tools INTEGER NOT NULL DEFAULT 1"
    ).run();
  }

  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function jsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
