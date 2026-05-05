export type SkillSummary = {
  name: string;
  description: string;
  version: string;
  tags: string[];
  category?: string;
  agents: string[];
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
  capabilities: {
    network: boolean;
    filesystem: "readonly" | "readwrite";
    tools: string[];
  };
  requiresSecrets: Array<{ name: string; description?: string; required?: boolean }>;
  bin: Record<string, SkillBinAction>;
};

export type ValidationResult = {
  valid: boolean;
  repaired: boolean;
  errors: string[];
  warnings: string[];
  securityFlags: string[];
};
