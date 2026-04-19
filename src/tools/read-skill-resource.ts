import fs from "node:fs/promises";
import path from "node:path";
import { skillDir } from "../storage/index.js";

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
  if (!skillName || skillName.includes("/") || skillName.includes("..")) {
    throw new Error("Invalid skill name");
  }
  if (path.isAbsolute(resourcePath) || resourcePath.includes("..")) {
    throw new Error("Invalid resource path");
  }
  const skillRoot = path.resolve(skillDir(skillName));
  const fullPath = path.resolve(skillRoot, resourcePath);
  if (fullPath !== skillRoot && !fullPath.startsWith(skillRoot + path.sep)) {
    throw new Error("Invalid resource path");
  }
  const content = await fs.readFile(fullPath, "utf-8");
  const ext = path.extname(fullPath).toLowerCase();
  return { content, mime_type: MIME_BY_EXT[ext] ?? "text/plain" };
}
