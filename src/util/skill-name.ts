const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;

export function safeSkillName(name: string, label = "skill name"): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`Invalid ${label}`);
  }
  const match = SKILL_NAME_PATTERN.exec(name);
  if (!match || match[0] !== name) {
    throw new Error(`Invalid ${label}`);
  }
  return match[0];
}

export function assertSafeSkillName(name: string, label = "skill name"): void {
  safeSkillName(name, label);
}
