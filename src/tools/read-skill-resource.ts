import path from "node:path";
import { readVerifiedSkillResource, readVerifiedSkillResources } from "../storage/index.js";
import { canonicalRelPath } from "../util/path.js";
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

  // Round-62: delegate to the storage-layer helper that holds one storage
  // lock for both the full open-set integrity walk and the requested
  // resource's verify. This is wider than the round-61 single-file check —
  // it catches injected siblings/FIFOs/control-dirs that left the requested
  // resource itself untouched but corrupted the install.
  const result = await readVerifiedSkillResource(skillName, resourcePath);
  switch (result.kind) {
    case "ok": {
      const ext = path.extname(canonicalRelPath(resourcePath)).toLowerCase();
      return { content: result.content, mime_type: MIME_BY_EXT[ext] ?? "text/plain" };
    }
    case "no_manifest":
      throw new Error(
        `Refusing to read: no signed manifest for skill '${skillName}'. Reinstall the skill.`
      );
    case "manifest_corrupt":
      throw new Error(
        `Refusing to read: signed manifest for skill '${skillName}' is corrupt. Reinstall the skill.`
      );
    case "tampered": {
      const detail = result.mismatches
        .map((m) => `${m.file} (${m.reason})`)
        .join(", ");
      throw new Error(
        `Refusing to read: skill '${skillName}' integrity check failed: ${detail}. Reinstall the skill.`
      );
    }
    case "not_covered":
      throw new Error(
        `Refusing to read: '${result.resource}' is not covered by the signed manifest for skill '${skillName}'. Reinstall the skill.`
      );
    case "signature_invalid":
      throw new Error(
        `Refusing to read: signature mismatch for '${result.resource}' in skill '${skillName}'. The file may have been tampered with — reinstall the skill.`
      );
    case "missing_on_disk":
      throw new Error(
        `Resource not found: ${result.resource}`
      );
  }
}

export async function readSkillResources(
  skillName: string,
  resourcePaths: string[]
): Promise<Array<{ path: string; content: string; mime_type: string }>> {
  assertSafeSkillName(skillName);
  const result = await readVerifiedSkillResources(skillName, resourcePaths);
  switch (result.kind) {
    case "ok":
      return result.resources.map((resource) => ({
        ...resource,
        mime_type: mimeTypeFor(resource.path)
      }));
    case "no_manifest":
      throw new Error(
        `Refusing to read: no signed manifest for skill '${skillName}'. Reinstall the skill.`
      );
    case "manifest_corrupt":
      throw new Error(
        `Refusing to read: signed manifest for skill '${skillName}' is corrupt. Reinstall the skill.`
      );
    case "tampered": {
      const detail = result.mismatches
        .map((m) => `${m.file} (${m.reason})`)
        .join(", ");
      throw new Error(
        `Refusing to read: skill '${skillName}' integrity check failed: ${detail}. Reinstall the skill.`
      );
    }
    case "not_covered":
      throw new Error(
        `Refusing to read: '${result.resource}' is not covered by the signed manifest for skill '${skillName}'. Reinstall the skill.`
      );
    case "signature_invalid":
      throw new Error(
        `Refusing to read: signature mismatch for '${result.resource}' in skill '${skillName}'. The file may have been tampered with — reinstall the skill.`
      );
    case "missing_on_disk":
      throw new Error(
        `Resource not found: ${result.resource}`
      );
  }
}

function mimeTypeFor(resourcePath: string): string {
  const ext = path.extname(canonicalRelPath(resourcePath)).toLowerCase();
  return MIME_BY_EXT[ext] ?? "text/plain";
}
