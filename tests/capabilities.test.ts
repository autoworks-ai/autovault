import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importAutohubCapabilities } from "../src/capabilities/import-autohub.js";
import { openCapabilityDb } from "../src/capabilities/db.js";
import { exportCapabilityConfig, resolveCapabilities, saveCapabilityConfig } from "../src/capabilities/resolver.js";
import { currentStorageRoot } from "./setup.js";

async function writeJson(fileName: string, value: unknown): Promise<string> {
  const filePath = path.join(currentStorageRoot(), fileName);
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
  return filePath;
}

describe("capability import and resolver", () => {
  it("imports AutoHub filters, redacts env values, and resolves hard matches", async () => {
    const toolFiltersPath = await writeJson("tool-filters.json", {
      profiles: {
        auto: { description: "Guest profile", groups: ["essential"] },
        "owner-auto": { description: "Owner profile", groups: ["essential", "github_read"] },
        full: { description: "Everything", groups: ["*"] }
      },
      toolGroups: {
        essential: ["memory.recall_memory"],
        github_read: ["github.get_pull_request"],
        freescout_read: ["freescout.get_conversation"],
        voice: ["ElevenLabs.generate_music"]
      },
      toolGroupMeta: {
        essential: { description: "Core memory", tags: ["memory"] },
        github_read: { description: "Read GitHub PRs", tags: ["git", "pr"] },
        freescout_read: { description: "Support tickets", tags: ["support"] },
        voice: { description: "Voice and audio generation", tags: ["audio"] }
      },
      contextRules: [
        {
          id: "github-intent",
          pattern: "\\b(pull request|pr)\\b",
          enableGroups: ["github_read"],
          startServers: ["github"],
          priority: 5
        }
      ],
      alwaysEnabled: ["fetch.fetch"],
      disabled: ["github.delete_file"],
      accessGrants: {
        slack: {
          workspaces: {
            T1: {
              channels: {
                C1: {
                  allowGroups: ["freescout_read"],
                  users: {
                    U1: { allowGroups: ["github_read"] }
                  }
                }
              }
            }
          },
          users: {
            UOWNER: { profile: "full" }
          }
        }
      }
    });
    const mcpServersPath = await writeJson("mcp-servers.json", {
      servers: {
        github: {
          command: "node",
          args: ["scripts/github.js"],
          env: { GITHUB_TOKEN: "literal-secret-token" },
          description: "GitHub"
        },
        freescout: {
          command: "npx",
          args: ["@example/freescout"],
          env: { FREESCOUT_API_KEY: "${FREESCOUT_API_KEY}" }
        }
      }
    });

    const imported = await importAutohubCapabilities({
      toolFiltersPath,
      mcpServersPath,
      reset: true
    });

    expect(imported.profiles).toBe(3);
    expect(imported.toolGroups).toBeGreaterThanOrEqual(4);
    expect(imported.contextRules).toBe(1);
    expect(imported.warnings.join("\n")).toContain("Dropped literal env value for github.GITHUB_TOKEN");

    const unknown = await resolveCapabilities({
      caller_id: "unknown",
      platform: "slack",
      query: "show me a PR"
    });
    expect(unknown.tools).toEqual([]);

    const guest = await resolveCapabilities({
      caller_id: "guest",
      platform: "slack",
      channel: "C1",
      query: "support ticket"
    });
    expect(guest.matched_groups).toContain("essential");
    expect(guest.matched_groups).toContain("freescout_read");
    expect(guest.tools.map((tool) => tool.pattern)).toContain("freescout.get_conversation");

    const owner = await resolveCapabilities({
      caller_id: "owner",
      platform: "slack",
      query: "pull request"
    });
    expect(owner.matched_groups).toContain("github_read");
    expect(owner.tools.map((tool) => tool.pattern)).toContain("github.get_pull_request");
    expect(owner.mcp_servers.find((server) => server.name === "github")?.env_required).toEqual(["GITHUB_TOKEN"]);
    expect(JSON.stringify(owner.mcp_servers)).not.toContain("literal-secret-token");

    const alias = await resolveCapabilities({
      caller_id: "guest",
      platform: "cli",
      query: "audio thing"
    });
    expect(alias.matched_groups).toContain("voice");

    const exported = exportCapabilityConfig(openCapabilityDb());
    expect(exported).toMatchObject({
      profiles: expect.objectContaining({ auto: expect.any(Object) }),
      toolGroups: expect.objectContaining({ essential: ["memory.recall_memory"] })
    });

    saveCapabilityConfig({
      ...exported,
      activeProfile: "full",
      disabled: ["fetch.fetch"],
      toolGroups: {
        ...(exported.toolGroups as Record<string, string[]>),
        essential: ["memory.recall_memory", "time.now"]
      }
    });

    const saved = exportCapabilityConfig(openCapabilityDb());
    expect(saved.activeProfile).toBe("full");
    expect((saved.toolGroups as Record<string, string[]>).essential).toContain("time.now");
    expect(saved.disabled).toEqual(["fetch.fetch"]);

    const afterSave = await resolveCapabilities({
      caller_id: "guest",
      platform: "cli",
      query: "anything"
    });
    expect(afterSave.tools.map((tool) => tool.pattern)).toContain("time.now");
    expect(afterSave.tools.map((tool) => tool.pattern)).not.toContain("fetch.fetch");
  });
});
