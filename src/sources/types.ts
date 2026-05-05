export type FetchedSkillResource = { path: string; content: string };

export type FetchedSkill = {
  skillMd: string;
  upstreamSha?: string;
  sourceUrl: string;
  resources?: FetchedSkillResource[];
};
