export type SkillSummary = {
  name: string;
  description: string;
  version: string;
  tags: string[];
  category?: string;
  agents: string[];
};

export type SkillRecord = SkillSummary & {
  skillMd: string;
  resources: Array<{ path: string; type: string }>;
  capabilities: {
    network: boolean;
    filesystem: "readonly" | "readwrite";
    tools: string[];
  };
  requiresSecrets: Array<{ name: string; description?: string; required?: boolean }>;
};

export type ValidationResult = {
  valid: boolean;
  repaired: boolean;
  errors: string[];
  warnings: string[];
  securityFlags: string[];
};
