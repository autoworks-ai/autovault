export type SkillInstallMode =
  | "prefer-autovault"
  | "both"
  | "native"
  | "native-only"
  | "off";

export type SkillInstallStep = "autovault" | "native";

export function normalizeSkillInstallMode(value?: string): SkillInstallMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized.length === 0 || normalized === "prefer" || normalized === "prefer-autovault") {
    return "prefer-autovault";
  }
  if (
    normalized === "both" ||
    normalized === "native" ||
    normalized === "native-only" ||
    normalized === "off"
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid AUTOVAULT_SKILL_INSTALL mode "${value}". Use prefer-autovault, both, native, native-only, or off.`
  );
}

export function skillInstallSteps(
  mode: SkillInstallMode,
  input: { autovaultAvailable: boolean }
): SkillInstallStep[] {
  switch (mode) {
    case "prefer-autovault":
      return input.autovaultAvailable ? ["autovault"] : ["native"];
    case "both":
      return input.autovaultAvailable ? ["autovault", "native"] : ["native"];
    case "native":
      return input.autovaultAvailable ? ["native", "autovault"] : ["native"];
    case "native-only":
      return ["native"];
    case "off":
      return [];
  }
}
