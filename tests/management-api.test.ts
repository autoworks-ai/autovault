import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { openCapabilityDb } from "../src/capabilities/db.js";
import { listConfiguredProfiles } from "../src/profiles/sync.js";
import { readSkill, writeSkill } from "../src/storage/index.js";
import {
  createManagementApiRouter,
  type ManagementAuthAdapter
} from "../src/ui/management-api.js";
import { startLocalUiServer, type LocalUiServerHandle } from "../src/ui/local-server.js";
import { currentStorageRoot } from "./setup.js";

function skillMd(
  name: string,
  options: {
    description?: string;
    agents?: string[];
    tags?: string[];
    version?: string;
    resources?: string[];
    binCommand?: string;
  } = {}
): string {
  const agents = options.agents ?? ["codex"];
  const tags = options.tags ?? ["ui"];
  return `---
name: ${name}
description: ${options.description ?? "Description long enough for the local management dashboard tests."}
tags:
${tags.map((tag) => `  - ${tag}`).join("\n")}
agents:
${agents.map((agent) => `  - ${agent}`).join("\n")}
metadata:
  version: "${options.version ?? "1.0.0"}"
capabilities:
  network: false
  filesystem: readonly
  tools: []
${options.resources && options.resources.length > 0
    ? `resources:
${options.resources.map((resource) => `  - path: ${resource}\n    type: file`).join("\n")}`
    : ""}
${options.binCommand
    ? `bin:
  setup:
    command: ${options.binCommand}`
    : ""}
---

# ${name}

Body for ${name}.
`;
}

async function api(
  handle: LocalUiServerHandle,
  pathName: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${handle.token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${handle.url}${pathName}`, { ...init, headers });
}

describe("management API", () => {
  let handles: LocalUiServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.close()));
    handles = [];
  });

  async function start(): Promise<LocalUiServerHandle> {
    const handle = await startLocalUiServer({ port: 0, open: false, offline: true });
    handles.push(handle);
    return handle;
  }

  it("binds loopback by default and requires the local session token", async () => {
    const handle = await start();
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const missing = await fetch(`${handle.url}/api/v1/skills`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${handle.url}/api/v1/skills`, {
      headers: { authorization: "Bearer wrong-token" }
    });
    expect(wrong.status).toBe(401);

    const ok = await api(handle, "/api/v1/skills");
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ skills: [] });
  });

  it("rejects mutating requests from disallowed origins", async () => {
    await writeSkill("origin-skill", skillMd("origin-skill"));
    const handle = await start();

    const response = await api(handle, "/api/v1/skills/origin-skill/frontmatter", {
      method: "PATCH",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ tags: ["blocked"] })
    });

    expect(response.status).toBe(403);
    const skill = await readSkill("origin-skill");
    expect(skill?.tags).toEqual(["ui"]);
  });

  it("lists, reads, edits frontmatter through updateSkill, and deletes with confirmation", async () => {
    await writeSkill("ui-skill", skillMd("ui-skill", {
      resources: ["references/notes.md", "./bin/setup"],
      binCommand: "bin/./setup"
    }), [
      { path: "references/notes.md", content: "notes" },
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho setup\n" }
    ]);
    const handle = await start();

    const list = await api(handle, "/api/v1/skills");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      skills: [
        expect.objectContaining({
          name: "ui-skill",
          agents: ["codex"],
          tags: ["ui"]
        })
      ]
    });

    const detail = await api(handle, "/api/v1/skills/ui-skill");
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      skill: {
        name: string;
        skill_md: string;
        frontmatter: Record<string, unknown>;
        resources: Array<{ path: string; type: string }>;
        bundle: {
          root: string;
          files: Array<{ path: string; kind: string; preview?: string }>;
        };
        provenance: {
          integrity: string;
          source: { status: string; label: string };
        };
      };
    };
    expect(detailBody.skill.name).toBe("ui-skill");
    expect(detailBody.skill.skill_md).toContain("# ui-skill");
    expect(detailBody.skill.frontmatter.name).toBe("ui-skill");
    expect(detailBody.skill.bundle).toMatchObject({
      root: "SKILL.md",
      files: [
        expect.objectContaining({
          path: "SKILL.md",
          kind: "markdown",
          preview: expect.stringContaining("# ui-skill")
        }),
        expect.objectContaining({
          path: "bin/setup",
          group: "actions",
          preview: "#!/usr/bin/env bash\necho setup\n"
        }),
        expect.objectContaining({
          path: "references/notes.md",
          kind: "markdown",
          preview: "notes"
        })
      ]
    });
    expect(detailBody.skill.provenance).toMatchObject({
      integrity: "signed",
      source: expect.objectContaining({ status: expect.any(String) })
    });

    const patch = await api(handle, "/api/v1/skills/ui-skill/frontmatter", {
      method: "PATCH",
      headers: { origin: handle.url },
      body: JSON.stringify({
        description: "Updated dashboard description that remains long enough.",
        agents: ["codex", "claude-code"],
        tags: ["ui", "managed"],
        metadata: { version: "1.1.0" }
      })
    });
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({
      skill: expect.objectContaining({
        name: "ui-skill",
        description: "Updated dashboard description that remains long enough.",
        agents: ["codex", "claude-code"],
        tags: ["ui", "managed"],
        version: "1.1.0"
      }),
      update: expect.objectContaining({ success: true })
    });

    const edited = await readSkill("ui-skill");
    expect(edited?.agents).toEqual(["codex", "claude-code"]);
    expect(edited?.resources.map((resource) => resource.path)).toEqual([
      "references/notes.md",
      "./bin/setup"
    ]);

    const blockedDelete = await api(handle, "/api/v1/skills/ui-skill", {
      method: "DELETE",
      headers: { origin: handle.url },
      body: JSON.stringify({})
    });
    expect(blockedDelete.status).toBe(400);
    await expect(readSkill("ui-skill")).resolves.not.toBeNull();

    const deleted = await api(handle, "/api/v1/skills/ui-skill", {
      method: "DELETE",
      headers: { origin: handle.url },
      body: JSON.stringify({ confirm: true })
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      result: expect.objectContaining({ deleted: true, name: "ui-skill" })
    });
    await expect(readSkill("ui-skill")).resolves.toBeNull();
  });

  it("accepts dashboard inline skill creates above one MiB but within bundle limits", async () => {
    const handle = await start();
    const chunk = "x".repeat(600 * 1024);
    const response = await api(handle, "/api/v1/skills", {
      method: "POST",
      headers: { origin: handle.url },
      body: JSON.stringify({
        source: "inline",
        identifier: "dashboard-large-inline",
        skill_md: skillMd("large-dashboard-skill", {
          resources: ["references/a.txt", "references/b.txt"]
        }),
        resources: [
          { path: "references/a.txt", content: chunk },
          { path: "references/b.txt", content: chunk }
        ]
      })
    });

    expect(response.status).toBe(201);
    await expect(readSkill("large-dashboard-skill")).resolves.not.toBeNull();
  });

  it("installs a pasted inline skill through the management API add flow", async () => {
    const handle = await start();
    const response = await api(handle, "/api/v1/skills", {
      method: "POST",
      headers: { origin: handle.url },
      body: JSON.stringify({
        source: "inline",
        identifier: "dashboard-paste",
        skill_md: skillMd("pasted-skill", {
          description: "Pasted dashboard skill description long enough to pass validation.",
          tags: ["ui", "pasted"]
        })
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      skill: expect.objectContaining({
        name: "pasted-skill",
        tags: ["ui", "pasted"],
        provenance: expect.objectContaining({
          source: expect.objectContaining({
            status: "present",
            label: "Inline"
          })
        })
      }),
      result: expect.objectContaining({ success: true })
    });
    await expect(readSkill("pasted-skill")).resolves.toMatchObject({
      name: "pasted-skill"
    });
  });

  it("saves named profiles and previews membership", async () => {
    await writeSkill("profile-visible", skillMd("profile-visible", {
      agents: ["codex"],
      tags: ["ui", "managed"]
    }));
    await writeSkill("profile-hidden", skillMd("profile-hidden", {
      agents: ["codex"],
      tags: ["draft"]
    }));
    const handle = await start();
    const target = path.join(currentStorageRoot(), "codex-profile");

    const put = await api(handle, "/api/v1/profiles", {
      method: "PUT",
      headers: { origin: handle.url },
      body: JSON.stringify({
        profiles: [
          {
            name: "workbench",
            agent: "codex",
            target,
            include_tags: ["ui"],
            exclude_tags: ["draft"],
            export_skill_overrides: false
          }
        ]
      })
    });
    expect(put.status).toBe(200);

    const profiles = await listConfiguredProfiles();
    expect(profiles.profiles).toEqual([
      expect.objectContaining({
        name: "workbench",
        agent: "codex",
        target,
        include_tags: ["ui"],
        exclude_tags: ["draft"],
        skills: ["profile-visible"]
      })
    ]);

    const sync = await api(handle, "/api/v1/profiles/sync", {
      method: "POST",
      headers: { origin: handle.url }
    });
    expect(sync.status).toBe(200);
    await expect(sync.json()).resolves.toMatchObject({
      result: expect.objectContaining({
        profileStatus: expect.objectContaining({
          workbench: [expect.objectContaining({ name: "profile-visible" })]
        })
      })
    });

    const linkedSkill = path.join(target, "profile-visible");
    const stat = await fs.lstat(linkedSkill);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("returns 400 for invalid named profile config writes", async () => {
    const handle = await start();
    const response = await api(handle, "/api/v1/profiles", {
      method: "PUT",
      headers: { origin: handle.url },
      body: JSON.stringify({
        profiles: [
          {
            name: "duplicate",
            agent: "codex",
            target: path.join(currentStorageRoot(), "profile-a")
          },
          {
            name: "duplicate",
            agent: "codex",
            target: path.join(currentStorageRoot(), "profile-b")
          }
        ]
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Duplicate named profile")
    });
  });

  it("returns update and permission management data", async () => {
    await writeSkill("updates-skill", skillMd("updates-skill"));
    const db = openCapabilityDb();
    db.prepare("INSERT INTO tool_groups(name, description, tags_json) VALUES (?, ?, ?)")
      .run("browser", "Browser tools", JSON.stringify(["ui"]));
    const handle = await start();

    const updates = await api(handle, "/api/v1/updates");
    expect(updates.status).toBe(200);
    await expect(updates.json()).resolves.toMatchObject({
      updates: expect.objectContaining({
        drifted: [],
        up_to_date: [],
        unchecked: [],
        errors: [expect.objectContaining({ name: "updates-skill" })]
      })
    });

    const blockedUpdate = await api(handle, "/api/v1/skills/updates-skill/update", {
      method: "POST",
      headers: { origin: handle.url },
      body: JSON.stringify({})
    });
    expect(blockedUpdate.status).toBe(400);

    const permissions = await api(handle, "/api/v1/permissions");
    expect(permissions.status).toBe(200);
    await expect(permissions.json()).resolves.toMatchObject({
      permissions: expect.objectContaining({
        mode: "local",
        roles: ["owner", "editor", "viewer"],
        capability_groups: [
          expect.objectContaining({
            name: "browser",
            description: "Browser tools",
            tags: ["ui"]
          })
        ]
      })
    });
  });

  it("reports local context and UI bundle compatibility", async () => {
    const handle = await start();

    const response = await api(handle, "/api/v1/context");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      context: {
        mode: "local",
        api_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        ui_bundle_version: expect.any(String),
        ui_channel: "stable",
        abilities: expect.objectContaining({
          can_add_skill: true,
          can_install_local: true,
          can_manage_users: false
        }),
        account: expect.objectContaining({
          mode: "local",
          label: "Local operator"
        }),
        vault: expect.objectContaining({
          storage_path: currentStorageRoot()
        }),
        compatibility: expect.objectContaining({
          status: "compatible"
        })
      }
    });
  });

  it("redacts local filesystem paths from remote management context", async () => {
    const remote = await startRemoteManagementApi();
    try {
      const response = await fetch(`${remote.url}/api/v1/context`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        context: { vault: Record<string, unknown> };
      };
      expect(body.context.vault).toEqual({ mode: "remote" });
      expect(body.context.vault).not.toHaveProperty("storage_path");
      expect(body.context.vault).not.toHaveProperty("db_path");
    } finally {
      await remote.close();
    }
  });

  it("rejects request-controlled file enrollments in remote mode", async () => {
    const remote = await startRemoteManagementApi();
    const body = JSON.stringify({
      upstream: {
        id: "remote-file",
        name: "Remote File",
        type: "file",
        catalog_path: "/tmp/catalog.json",
        public_key: "test-public-key"
      }
    });

    try {
      for (const pathName of ["/api/v1/enrollments/init", "/api/v1/enrollments/complete"]) {
        const response = await fetch(`${remote.url}${pathName}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringContaining("local mode")
        });
      }
    } finally {
      await remote.close();
    }
  });
});

async function startRemoteManagementApi(): Promise<{ url: string; close: () => Promise<void> }> {
  const auth: ManagementAuthAdapter = {
    read: () => ({ ok: true, context: { mode: "remote", role: "owner" } }),
    write: () => ({ ok: true, context: { mode: "remote", role: "owner" } })
  };
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createManagementApiRouter({ auth, mode: "remote" }));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
