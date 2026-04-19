import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SKILL_MD = `---
name: autovault-skill
description: Access shared skills through AutoVault. Always search AutoVault before writing a new skill so duplicates are avoided and curated knowledge is reused.
license: MIT
tags:
  - meta
  - discovery
  - skills
category: meta
metadata:
  version: "1.0.0"
capabilities:
  network: false
  filesystem: readonly
  tools:
    - mcp
---

# AutoVault Meta-Skill

Use AutoVault as the canonical source of curated agent skills. AutoVault
stores, validates, and serves skills; it does not execute them. The agent
that loads a skill is responsible for sandboxing and user confirmation
before running anything the skill describes.

## When to use

- Before writing any new skill, search AutoVault first.
- Before suggesting a workflow, check whether a curated skill already
  encodes that workflow.
- When a previously installed skill might be stale.

## Tool reference

AutoVault exposes seven MCP tools over stdio:

- \`list_skills\` - returns metadata for every installed skill.
- \`search_skills(query, top_k?)\` - text search across name, description,
  tags, and category. Returns ranked matches with scores.
- \`get_skill(name)\` - returns the full SKILL.md plus parsed metadata,
  capabilities, required secrets, and source provenance.
- \`read_skill_resource(skill_name, resource_path)\` - reads a file packaged
  alongside a skill. Path traversal is blocked.
- \`install_skill({source, identifier, version?, skill_md?})\` - installs
  from \`github\` (\`owner/repo[@ref][:path]\`), \`agentskills\`
  (\`slug[@version]\`), or \`url\` (https only). If \`skill_md\` is provided,
  it is treated as inline content; otherwise the source adapter fetches it.
- \`propose_skill({skill_md, resources?, source_session?})\` - validates and
  installs a new skill. Outcome is one of \`accepted\`, \`duplicate\`,
  \`invalid\`, or \`security_blocked\`.
- \`check_updates(skill?)\` - compares installed content hash against the
  recorded source. Inline skills are always reported as up_to_date.

## Required workflow

1. Call \`search_skills\` with a concise query.
2. If a result has high confidence, call \`get_skill\` and follow it.
3. If nothing fits, author a new \`SKILL.md\` and call \`propose_skill\`.
   Handle every outcome explicitly:
   - \`accepted\` - skill is stored under \`$AUTOVAULT_STORAGE_PATH/skills/<name>\`.
   - \`duplicate\` - inspect \`existing_match\` and choose a \`merge_options\`
     value (\`keep_existing\`, \`replace\`, \`merge\`, \`keep_both\`).
   - \`invalid\` - fix the listed schema errors and resubmit.
   - \`security_blocked\` - rewrite the content to remove flagged patterns.
4. Periodically call \`check_updates\` for skills installed from a remote
   source.

## SKILL.md schema (minimum)

\`\`\`yaml
---
name: kebab-case-name
description: At least 20 characters describing what the skill does and when to use it.
metadata:
  version: "1.0.0"
---
\`\`\`

Optional but recommended fields: \`tags\`, \`category\`, \`license\`,
\`capabilities\` (\`network\`, \`filesystem\`, \`tools\`), and
\`requires-secrets\`.

## Security expectations

- AutoVault runs a denylist scan on every proposal/install. Common
  flagged categories include: SSH key exfiltration, piping remote
  content into a shell, destructive recursive deletes of home/root,
  and verification-bypass flags.
- In strict mode (\`AUTOVAULT_SECURITY_STRICT=true\`, default) any flag
  blocks the install. In non-strict mode, flags become warnings.
- Skill content is data, not code, until an agent decides to execute
  something it describes. Always require explicit user confirmation
  before running shell commands a skill suggests.
`;

function unwrap(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return { _isError: Boolean(result?.isError), text };
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/index.js")],
    env: {
      ...process.env,
      AUTOVAULT_STORAGE_PATH: process.env.AUTOVAULT_STORAGE_PATH ?? path.join(os.homedir(), ".autovault"),
      AUTOVAULT_LOG_LEVEL: "info"
    },
    stderr: "inherit"
  });
  const client = new Client({ name: "autovault-installer", version: "1.0.0" });
  await client.connect(transport);

  process.stdout.write("\n--- propose_skill (autovault-skill) ---\n");
  const proposed = unwrap(
    await client.callTool({
      name: "propose_skill",
      arguments: { skill_md: SKILL_MD, source_session: "install-meta-skill.mjs" }
    })
  );
  process.stdout.write(`${JSON.stringify(proposed, null, 2)}\n`);

  if (proposed.outcome === "duplicate") {
    process.stdout.write("\n--- duplicate detected; replacing via install_skill (inline) ---\n");
    const replaced = unwrap(
      await client.callTool({
        name: "install_skill",
        arguments: {
          source: "url",
          identifier: "https://github.com/autoworks-ai/autovault/blob/main/skills/autovault-skill/SKILL.md",
          skill_md: SKILL_MD
        }
      })
    );
    process.stdout.write(`${JSON.stringify(replaced, null, 2)}\n`);
  }

  process.stdout.write("\n--- get_skill (autovault-skill) ---\n");
  const got = unwrap(
    await client.callTool({ name: "get_skill", arguments: { name: "autovault-skill" } })
  );
  process.stdout.write(
    `${JSON.stringify({ ...got, skill_md: `<${got.skill_md.length} chars>` }, null, 2)}\n`
  );

  process.stdout.write("\n--- list_skills ---\n");
  const list = unwrap(await client.callTool({ name: "list_skills", arguments: {} }));
  process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);

  await client.close();
}

main().catch((error) => {
  process.stderr.write(`Install failed: ${String(error)}\n`);
  process.exit(1);
});
