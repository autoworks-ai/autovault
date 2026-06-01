import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";

export type NamedProfile = {
  name: string;
  agent: string;
  target: string;
  includeTags: "*" | string[];
  excludeTags: string[];
  // Opt-in (claude-code only): also emit a `skillOverrides` block to a Claude
  // Code settings.json so the agent's live manifest actually shrinks. The
  // per-project symlink farm alone is additive — Claude Code merges it with
  // ~/.claude/skills/ — so without this flag the project still loads every
  // global skill. `true` → derived path `<dirname(target)>/settings.json`;
  // a string → absolute or resolved against `dirname(target)`. AutoVault owns
  // the `skillOverrides` key entirely for managed projects; manual edits to
  // that key are overwritten on next sync.
  exportSkillOverrides?: boolean | string;
};

export type NamedProfileConfig = {
  path: string;
  profiles: NamedProfile[];
};

export type SaveNamedProfile = {
  name: string;
  agent: string;
  target: string;
  include_tags?: "*" | string[];
  exclude_tags?: string[];
  export_skill_overrides?: boolean | string;
};

export type SaveNamedProfileConfigInput = {
  profiles: SaveNamedProfile[];
};

const SAFE_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

const tagArray = (fieldName: string) =>
  z
    .array(z.string())
    .min(1, `${fieldName} must not be empty`)
    .transform((tags, ctx) => {
      const normalized: string[] = [];
      for (const tag of tags) {
        const value = normalizeTag(tag);
        if (value.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${fieldName} must not contain empty tags`
          });
          return z.NEVER;
        }
        if (!normalized.includes(value)) normalized.push(value);
      }
      return normalized;
    });

const rawProfileSchema = z.object({
  name: z
    .string()
    .regex(SAFE_SLUG_PATTERN, "profile name must match ^[a-z][a-z0-9-]*$"),
  agent: z
    .string()
    .regex(SAFE_SLUG_PATTERN, "agent must match ^[a-z][a-z0-9-]*$"),
  target: z.string().min(1),
  include_tags: z.union([z.literal("*"), tagArray("include_tags")]).optional(),
  exclude_tags: tagArray("exclude_tags").optional(),
  export_skill_overrides: z.union([z.boolean(), z.string().min(1)]).optional()
});

const profileConfigSchema = z.object({
  profiles: z.array(rawProfileSchema).default([])
});

export function normalizeProfileTarget(target: string): string {
  return path.resolve(expandHome(target));
}

function parseProfileConfig(
  parsed: z.infer<typeof profileConfigSchema>,
  resolvedPath: string
): NamedProfileConfig {
  const names = new Map<string, number>();
  const targets = new Map<string, string>();
  const profiles = parsed.profiles.map((profile, index): NamedProfile => {
    const existing = names.get(profile.name);
    if (existing !== undefined) {
      throw new Error(
        `Invalid AutoVault profile config: ${resolvedPath}: Duplicate named profile "${profile.name}" at profiles.${existing} and profiles.${index}`
      );
    }
    names.set(profile.name, index);

    const target = expandHome(profile.target);
    const normalizedTarget = normalizeProfileTarget(target);
    const existingTarget = targets.get(normalizedTarget);
    if (existingTarget) {
      throw new Error(
        `Invalid AutoVault profile config: ${resolvedPath}: Duplicate named profile target "${normalizedTarget}" for "${existingTarget}" and "${profile.name}"`
      );
    }
    targets.set(normalizedTarget, profile.name);

    return {
      name: profile.name,
      agent: profile.agent,
      target,
      includeTags: profile.include_tags ?? "*",
      excludeTags: profile.exclude_tags ?? [],
      exportSkillOverrides: profile.export_skill_overrides
    };
  });

  return { path: resolvedPath, profiles };
}

export async function loadNamedProfileConfig(
  configPath = loadConfig().profileConfigPath
): Promise<NamedProfileConfig> {
  const resolvedPath = path.resolve(expandHome(configPath));
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: resolvedPath, profiles: [] };
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid AutoVault profile config: ${resolvedPath}: ${String(error)}`);
  }

  const parsed = profileConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid AutoVault profile config: ${resolvedPath}: ${issues}`);
  }

  return parseProfileConfig(parsed.data, resolvedPath);
}

export async function saveNamedProfileConfig(
  input: SaveNamedProfileConfigInput,
  configPath = loadConfig().profileConfigPath
): Promise<NamedProfileConfig> {
  const resolvedPath = path.resolve(expandHome(configPath));
  const parsed = profileConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid AutoVault profile config: ${resolvedPath}: ${issues}`);
  }
  const normalized = parseProfileConfig(parsed.data, resolvedPath);
  const serializable = {
    profiles: parsed.data.profiles.map((profile) => ({
      name: profile.name,
      agent: profile.agent,
      target: profile.target,
      include_tags: profile.include_tags ?? "*",
      exclude_tags: profile.exclude_tags ?? [],
      ...(profile.export_skill_overrides === undefined
        ? {}
        : { export_skill_overrides: profile.export_skill_overrides })
    }))
  };

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const tmp = `${resolvedPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(serializable, null, 2)}\n`, {
    mode: 0o600
  });
  await fs.rename(tmp, resolvedPath);
  await fs.chmod(resolvedPath, 0o600).catch(() => {});
  return normalized;
}
