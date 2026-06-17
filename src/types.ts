export type SkillCapabilities = {
  network: boolean;
  filesystem: "readonly" | "readwrite";
  tools: string[];
};

export type SkillSecretRequirement = {
  name: string;
  description?: string;
  required?: boolean;
};

export type SkillSummary = {
  name: string;
  title?: string;
  description: string;
  version: string;
  tags: string[];
  category?: string;
  agents: string[];
  when_to_use?: string;
  when_not_to_use?: string;
  risk_level?: string;
  capabilities: SkillCapabilities;
  // Public JSON alias for metadata-only consumers.
  requires_tools: string[];
  // Public JSON alias; internal TypeScript callers should prefer requiresSecrets.
  requires_secrets: SkillSecretRequirement[];
  requiresSecrets: SkillSecretRequirement[];
  // Optional attribution from frontmatter metadata (per agentskills.io convention).
  // Used by hosts (e.g. Grok) for grouping/filtering in skill lists.
  author?: string;
  // From frontmatter metadata.source (e.g. upstream GitHub URL). Distinct from
  // the AutoVault-internal provenance object returned as `source` by get_skill.
  frontmatter_source?: string;
};

export type SkillBinAction = {
  command: string;
  args: string[];
  description?: string;
  requiresTty: boolean;
};

export type SkillRecord = SkillSummary & {
  skillMd: string;
  resources: Array<{ path: string; type: string }>;
  bin: Record<string, SkillBinAction>;
};

export type ValidationResult = {
  valid: boolean;
  repaired: boolean;
  errors: string[];
  warnings: string[];
  securityFlags: string[];
};
