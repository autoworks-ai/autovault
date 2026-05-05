import fs from "node:fs/promises";
import path from "node:path";
import { readSkillManifestStatus, validateResourcePath } from "../storage/index.js";
import { canonicalRelPath } from "../util/path.js";
import { log } from "../util/log.js";
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
  const content = await fs.readFile(fullPath, "utf-8");

  // Match readSkill's V1 log-only enforcement: a tampered, corrupt, or missing
  // manifest must surface a warning, not silently feed agents bytes whose
  // signature we never verified. The CLI exec path is hard-fail; this read
  // path stays log-only for V1 (matching SKILL.md), but it must NOT skip the
  // check entirely. `readSkillManifest` collapses corrupt and absent into the
  // same null return; status() preserves the distinction so the warning
  // reasons match storage.signature_mismatch.
  const key = canonicalRelPath(resourcePath);
  const status = await readSkillManifestStatus(skillName);
  if (status.kind === "absent") {
    log.warn("read_skill_resource.signature_mismatch", {
      skill: skillName,
      resource: key,
      reason: "no_integrity_file"
    });
  } else if (status.kind === "corrupt") {
    log.warn("read_skill_resource.signature_mismatch", {
      skill: skillName,
      resource: key,
      reason: "manifest_corrupt"
    });
  } else {
    // verifyFile binds the signature to (skill, path, content), so a manifest
    // entry copied across skills or paths returns `present: false` here just
    // like a missing entry does — both warn the operator the bytes aren't
    // covered by a binding the manifest was actually signed for.
    const result = await verifyFile(status.manifest, skillName, key, content);
    if (!result.present) {
      log.warn("read_skill_resource.unsigned", { skill: skillName, resource: key });
    } else if (!result.valid) {
      log.warn("read_skill_resource.signature_mismatch", { skill: skillName, resource: key });
    }
  }

  const ext = path.extname(fullPath).toLowerCase();
  return { content, mime_type: MIME_BY_EXT[ext] ?? "text/plain" };
}
