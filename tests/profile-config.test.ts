import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { loadNamedProfileConfig } from "../src/profiles/config.js";
import { currentStorageRoot } from "./setup.js";

describe("named profile config", () => {
  it("loads JSON profiles from the default storage config path and expands targets", async () => {
    await fs.writeFile(
      path.join(currentStorageRoot(), "profiles.config.json"),
      JSON.stringify({
        profiles: [
          {
            name: "claude-code-autohub",
            agent: "claude-code",
            target: "~/Projects/OpenAI/autohub/.claude/skills",
            include_tags: ["autohub", "mcp"],
            exclude_tags: ["commerce"]
          }
        ]
      }),
      "utf-8"
    );

    const config = await loadNamedProfileConfig();

    expect(config.profiles).toEqual([
      expect.objectContaining({
        name: "claude-code-autohub",
        agent: "claude-code",
        includeTags: ["autohub", "mcp"],
        excludeTags: ["commerce"]
      })
    ]);
    expect(config.profiles[0]?.target).toContain(
      path.join("Projects", "OpenAI", "autohub", ".claude", "skills")
    );
  });

  it("honors AUTOVAULT_PROFILE_CONFIG_PATH and exposes the path in loadConfig", async () => {
    const customPath = path.join(currentStorageRoot(), "custom-profiles.json");
    process.env.AUTOVAULT_PROFILE_CONFIG_PATH = customPath;
    resetConfigCache();
    await fs.writeFile(
      customPath,
      JSON.stringify({
        profiles: [
          {
            name: "codex-project",
            agent: "codex",
            target: path.join(currentStorageRoot(), "codex-target"),
            include_tags: "*"
          }
        ]
      }),
      "utf-8"
    );

    expect(loadConfig().profileConfigPath).toBe(customPath);
    const config = await loadNamedProfileConfig();

    expect(config.profiles[0]).toMatchObject({
      name: "codex-project",
      agent: "codex",
      target: path.join(currentStorageRoot(), "codex-target"),
      includeTags: "*",
      excludeTags: []
    });
  });

  it("rejects duplicate names, unsafe names, empty tag arrays, and duplicate targets", async () => {
    const target = path.join(currentStorageRoot(), "target");

    await fs.writeFile(
      path.join(currentStorageRoot(), "profiles.config.json"),
      JSON.stringify({
        profiles: [
          { name: "unsafe/name", agent: "codex", target, include_tags: ["autohub"] }
        ]
      }),
      "utf-8"
    );
    await expect(loadNamedProfileConfig()).rejects.toThrow(/profile name/i);

    await fs.writeFile(
      path.join(currentStorageRoot(), "profiles.config.json"),
      JSON.stringify({
        profiles: [
          { name: "one", agent: "codex", target, include_tags: [] }
        ]
      }),
      "utf-8"
    );
    await expect(loadNamedProfileConfig()).rejects.toThrow(/include_tags/i);

    await fs.writeFile(
      path.join(currentStorageRoot(), "profiles.config.json"),
      JSON.stringify({
        profiles: [
          { name: "one", agent: "codex", target, include_tags: ["autohub"] },
          { name: "one", agent: "codex", target: path.join(currentStorageRoot(), "other") }
        ]
      }),
      "utf-8"
    );
    await expect(loadNamedProfileConfig()).rejects.toThrow(/Duplicate named profile/i);

    await fs.writeFile(
      path.join(currentStorageRoot(), "profiles.config.json"),
      JSON.stringify({
        profiles: [
          { name: "one", agent: "codex", target },
          { name: "two", agent: "codex", target }
        ]
      }),
      "utf-8"
    );
    await expect(loadNamedProfileConfig()).rejects.toThrow(/Duplicate named profile target/i);
  });
});
