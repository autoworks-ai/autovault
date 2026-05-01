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
      servers_json TEXT NOT NULL DEFAULT '[]'
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

    CREATE INDEX IF NOT EXISTS idx_group_tools_group ON group_tools(group_name);
    CREATE INDEX IF NOT EXISTS idx_group_servers_group ON group_servers(group_name);
    CREATE INDEX IF NOT EXISTS idx_context_rules_priority ON context_rules(priority DESC);
  `);

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
