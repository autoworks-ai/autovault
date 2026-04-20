import fs from "node:fs/promises";
import path from "node:path";
import { validateResourcePath } from "../storage/index.js";
import { assertSafeSkillName } from "../util/skill-name.js";

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".sh": "application/x-sh"
};

export async function readSkillResource(skillName: string, resourcePath: string): Promise<{
  content: string;
  mime_type: string;
}> {
  assertSafeSkillName(skillName);
  const fullPath = validateResourcePath(skillName, resourcePath);
  const content = await fs.readFile(fullPath, "utf-8");
  const ext = path.extname(fullPath).toLowerCase();
  return { content, mime_type: MIME_BY_EXT[ext] ?? "text/plain" };
}
