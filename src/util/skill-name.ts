const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;

export function assertSafeSkillName(name: string, label = "skill name"): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`Invalid ${label}`);
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${label}`);
  }
}
