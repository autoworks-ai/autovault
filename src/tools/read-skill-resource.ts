import fs from "node:fs/promises";
import path from "node:path";
import { readSkillManifestStatus, validateResourcePath } from "../storage/index.js";
import { canonicalRelPath } from "../util/path.js";
import { verifyFile } from "../util/sign.js";
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
  const key = canonicalRelPath(resourcePath);

  // Round-61: hard-fail on any integrity problem before returning content.
  // Earlier this path returned bytes with a stderr-only warning, but stderr
  // never reaches the MCP caller — an agent consuming the result couldn't
  // distinguish a tampered file from a clean one. The CLI exec/print path
  // hard-fails on the same conditions, so the MCP read path now matches.
  // verifyFile binds the signature to (skill, path, content) so a manifest
  // entry copied across skills or paths still fails closed here.
  const status = await readSkillManifestStatus(skillName);
  if (status.kind === "absent") {
    throw new Error(
      `Refusing to read: no signed manifest for skill '${skillName}'. Reinstall the skill.`
    );
  }
  if (status.kind === "corrupt") {
    throw new Error(
      `Refusing to read: signed manifest for skill '${skillName}' is corrupt. Reinstall the skill.`
    );
  }

  const content = await fs.readFile(fullPath, "utf-8");
  const result = await verifyFile(status.manifest, skillName, key, content);
  if (!result.present) {
    throw new Error(
      `Refusing to read: '${key}' is not covered by the signed manifest for skill '${skillName}'. Reinstall the skill.`
    );
  }
  if (!result.valid) {
    throw new Error(
      `Refusing to read: signature mismatch for '${key}' in skill '${skillName}'. The file may have been tampered with — reinstall the skill.`
    );
  }

  const ext = path.extname(fullPath).toLowerCase();
  return { content, mime_type: MIME_BY_EXT[ext] ?? "text/plain" };
}
