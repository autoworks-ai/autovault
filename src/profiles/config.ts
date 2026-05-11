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
};

export type NamedProfileConfig = {
  path: string;
  profiles: NamedProfile[];
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
  exclude_tags: tagArray("exclude_tags").optional()
});

const profileConfigSchema = z.object({
  profiles: z.array(rawProfileSchema).default([])
});

export function normalizeProfileTarget(target: string): string {
  return path.resolve(expandHome(target));
}

export async function loadNamedProfileConfig(
  configPath = loadConfig().profileConfigPath
): Promise<NamedProfileConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: configPath, profiles: [] };
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid AutoVault profile config: ${configPath}: ${String(error)}`);
  }

  const parsed = profileConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid AutoVault profile config: ${issues}`);
  }

  const names = new Map<string, number>();
  const targets = new Map<string, string>();
  const profiles = parsed.data.profiles.map((profile, index): NamedProfile => {
    const existing = names.get(profile.name);
    if (existing !== undefined) {
      throw new Error(
        `Invalid AutoVault profile config: Duplicate named profile "${profile.name}" at profiles.${existing} and profiles.${index}`
      );
    }
    names.set(profile.name, index);

    const target = expandHome(profile.target);
    const normalizedTarget = normalizeProfileTarget(target);
    const existingTarget = targets.get(normalizedTarget);
    if (existingTarget) {
      throw new Error(
        `Invalid AutoVault profile config: Duplicate named profile target "${normalizedTarget}" for "${existingTarget}" and "${profile.name}"`
      );
    }
    targets.set(normalizedTarget, profile.name);

    return {
      name: profile.name,
      agent: profile.agent,
      target,
      includeTags: profile.include_tags ?? "*",
      excludeTags: profile.exclude_tags ?? []
    };
  });

  return { path: configPath, profiles };
}
