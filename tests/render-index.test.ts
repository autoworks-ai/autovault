import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRenderIndex } from "../src/storage/render-index.js";
import { currentStorageRoot } from "./setup.js";

async function writeIndex(value: unknown): Promise<void> {
  await fs.writeFile(
    path.join(currentStorageRoot(), "render-index.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

function validEntry(): Record<string, unknown> {
  const root = currentStorageRoot();
  const linkRoot = path.join(root, "codex", "automations");
  return {
    skill: "render-demo",
    renderRoot: path.join(root, "rendered", "codex-automations", "render-demo"),
    linkRoot,
    symlink: path.join(linkRoot, "render-demo"),
    templates: [{ path: "resources/template.toml.tpl", hash: "a".repeat(64) }],
    rendered: [{ path: "automation.toml", hash: "b".repeat(64) }]
  };
}

describe("render index", () => {
  it("rejects unsupported index versions", async () => {
    await writeIndex({ version: 2, entries: [] });

    await expect(loadRenderIndex()).resolves.toMatchObject({
      kind: "corrupt",
      reason: expect.stringMatching(/version/i)
    });
  });

  it("requires an explicit v1 version", async () => {
    await writeIndex({ entries: [] });

    await expect(loadRenderIndex()).resolves.toMatchObject({ kind: "corrupt" });
  });

  it.each([
    {
      name: "malformed hashes",
      mutate: (entry: Record<string, any>) => {
        entry.rendered[0].hash = "not-a-sha256";
      }
    },
    {
      name: "unsafe template paths",
      mutate: (entry: Record<string, any>) => {
        entry.templates[0].path = "../template.toml.tpl";
      }
    },
    {
      name: "unsafe rendered paths",
      mutate: (entry: Record<string, any>) => {
        entry.rendered[0].path = "../automation.toml";
      }
    },
    {
      name: "Windows-absolute rendered paths",
      mutate: (entry: Record<string, any>) => {
        entry.rendered[0].path = "C:\\automation.toml";
      }
    },
    {
      name: "duplicate hash paths",
      mutate: (entry: Record<string, any>) => {
        entry.rendered.push({ ...entry.rendered[0] });
      }
    },
    {
      name: "render roots outside the vault",
      mutate: (entry: Record<string, any>) => {
        entry.renderRoot = path.join(currentStorageRoot(), "outside-render-tree");
      }
    },
    {
      name: "symlinks outside their managed root",
      mutate: (entry: Record<string, any>) => {
        entry.symlink = path.join(currentStorageRoot(), "elsewhere", "render-demo");
      }
    }
  ])("rejects $name", async ({ mutate }) => {
    const entry = validEntry();
    mutate(entry);
    await writeIndex({ version: 1, entries: [entry] });

    await expect(loadRenderIndex()).resolves.toMatchObject({ kind: "corrupt" });
  });

  it("rejects duplicate managed symlinks", async () => {
    const entry = validEntry();
    await writeIndex({ version: 1, entries: [entry, { ...entry, skill: "other-skill" }] });

    await expect(loadRenderIndex()).resolves.toMatchObject({
      kind: "corrupt",
      reason: expect.stringMatching(/duplicate/i)
    });
  });

  it("rejects duplicate render roots even when symlinks differ", async () => {
    const entry = validEntry();
    const otherLinkRoot = path.join(currentStorageRoot(), "other-codex", "automations");
    await writeIndex({
      version: 1,
      entries: [
        entry,
        {
          ...entry,
          linkRoot: otherLinkRoot,
          symlink: path.join(otherLinkRoot, "render-demo")
        }
      ]
    });

    await expect(loadRenderIndex()).resolves.toMatchObject({
      kind: "corrupt",
      reason: expect.stringMatching(/duplicate.*render root/i)
    });
  });
});
