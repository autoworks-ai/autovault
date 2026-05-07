import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditRepo, formatAuditRepoMarkdown } from "../src/audit/repo.js";
import { currentStorageRoot } from "./setup.js";

async function writeFile(repo: string, filePath: string, content: string): Promise<void> {
  const abs = path.join(repo, filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

describe("auditRepo", () => {
  it("classifies reusable AutoHub helpers into vault targets", async () => {
    const repo = path.join(currentStorageRoot(), "repo");
    await fs.mkdir(repo, { recursive: true });
    await writeFile(
      repo,
      "package.json",
      JSON.stringify(
        {
          scripts: {
            "deploy:pages":
              "node scripts/autovault-shim.js cloudflare-ops run --task deploy-pages --",
            "autovault:audit":
              "node scripts/autovault-shim.js --cli audit-repo --repo . --format markdown",
            "voice:realtime": "node scripts/realtime-mcp-agent.js",
            "start:hub": "node server.js"
          }
        },
        null,
        2
      )
    );
    await writeFile(
      repo,
      "scripts/deploy-pages-site.js",
      "const token = process.env.CLOUDFLARE_API_TOKEN;\nfetch('https://api.cloudflare.com/client/v4');\n"
    );
    await writeFile(
      repo,
      "scripts/realtime-mcp-agent.js",
      "process.env.OPENAI_API_KEY;\n"
    );
    await writeFile(repo, "tools/run-workflow.js", "export default {};\n");
    await writeFile(repo, "tools/_deprecated/old.js", "export default {};\n");
    await writeFile(repo, "raycast/install.sh", "#!/usr/bin/env bash\nmkdir -p \"$HOME/Documents/Raycast Scripts\"\n");

    const result = await auditRepo({ repo });
    const byPath = Object.fromEntries(result.items.map((item) => [item.path, item]));

    expect(byPath["scripts/deploy-pages-site.js"]).toMatchObject({
      classification: "vault-skill",
      target: "cloudflare-ops"
    });
    expect(byPath["package.json#scripts.deploy:pages"]).toMatchObject({
      classification: "thin-shim",
      target: "cloudflare-ops"
    });
    expect(byPath["package.json#scripts.autovault:audit"]).toMatchObject({
      classification: "vault-capability",
      target: "autovault"
    });
    expect(byPath["scripts/realtime-mcp-agent.js"]).toMatchObject({
      classification: "split-first",
      target: "voice-lab"
    });
    expect(byPath["tools/run-workflow.js"]).toMatchObject({
      classification: "stay-hub",
      target: "autohub-runtime"
    });
    expect(byPath["tools/_deprecated/old.js"]).toMatchObject({
      classification: "deprecate"
    });
    expect(byPath["raycast/install.sh"]).toMatchObject({
      classification: "vault-skill",
      target: "raycast-autojack"
    });
  });

  it("reports secret-shaped values without leaking the raw value", async () => {
    const repo = path.join(currentStorageRoot(), "secret-repo");
    const secret = ["sk", "live", "1234567890abcdefghijklmnop"].join("_");
    await writeFile(
      repo,
      "scripts/twitter-oauth2-reauth.js",
      `const key = "${secret}";\nprocess.env.TWITTER_CLIENT_SECRET;\n`
    );

    const result = await auditRepo({ repo });
    const serialized = JSON.stringify(result);
    const item = result.items.find((candidate) =>
      candidate.path.endsWith("twitter-oauth2-reauth.js")
    );

    expect(item?.risk).toBe("high");
    expect(item?.redacted_findings?.length).toBeGreaterThanOrEqual(2);
    expect(serialized).not.toContain(secret);

    const markdown = formatAuditRepoMarkdown(result);
    expect(markdown).toContain("redacted secret finding");
    expect(markdown).not.toContain(secret);
  });
});
