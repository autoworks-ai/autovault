import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

describe("workflow runtime policy", () => {
  it("uses Release Please on Node 24-compatible action runtime with v-prefixed tags", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const config = readJson<Record<string, unknown>>("release-please-config.json");

    expect(workflow).toContain("googleapis/release-please-action@v5");
    expect(workflow).not.toContain("googleapis/release-please-action@v4");
    expect(config["include-component-in-tag"]).toBe(false);
  });

  it("pins GitHub Actions to Node 24-compatible major versions", () => {
    const workflowText = [
      ".github/workflows/ci.yml",
      ".github/workflows/release-please.yml",
      ".github/workflows/dependabot-auto-merge.yml",
      ".github/workflows/security.yml",
      ".github/workflows/docker-publish.yml"
    ]
      .map(readText)
      .join("\n");

    const expectedPins = [
      "actions/checkout@v6",
      "actions/setup-node@v6",
      "googleapis/release-please-action@v5",
      "dependabot/fetch-metadata@v3",
      "actions/github-script@v9",
      "docker/setup-qemu-action@v4",
      "docker/setup-buildx-action@v4",
      "docker/login-action@v4",
      "docker/metadata-action@v6",
      "docker/build-push-action@v7"
    ];

    const forbiddenPins = [
      "googleapis/release-please-action@v4",
      "dependabot/fetch-metadata@v2",
      "docker/setup-qemu-action@v3",
      "docker/setup-buildx-action@v3",
      "docker/login-action@v3",
      "docker/metadata-action@v5",
      "docker/build-push-action@v6"
    ];

    for (const pin of expectedPins) {
      expect(workflowText).toContain(pin);
    }
    for (const pin of forbiddenPins) {
      expect(workflowText).not.toContain(pin);
    }
    expect(workflowText).not.toMatch(/node-version:\s*["']?20\b/);
    expect(workflowText).not.toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24");
    expect(workflowText).not.toContain("ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION");
  });

  it("aligns package metadata to the Node 24 runtime", () => {
    const packageJson = readJson<{
      engines: Record<string, string>;
      devDependencies: Record<string, string>;
    }>("package.json");

    expect(packageJson.engines.node).toBe(">=24.0.0");
    expect(packageJson.devDependencies["@types/node"]).toBe("^24.12.4");
  });

  it("documents live package distribution with canonical install paths", () => {
    const npmPackageUrl = "https://www.npmjs.com/package/@autoworks-ai/autovault";
    const homebrewTapUrl = "https://github.com/autoworks-ai/homebrew-tap";
    const docsText = ["README.md", "INSTALL.md", "docs/RELEASE.md"]
      .map(readText)
      .join("\n");

    expect(docsText).toContain(npmPackageUrl);
    expect(docsText).toContain(homebrewTapUrl);
    expect(docsText).toContain("npm install -g @autoworks-ai/autovault");
    expect(docsText).toContain("brew install autoworks-ai/tap/autovault");
    expect(docsText).not.toContain("first public npm publish");
    expect(docsText).not.toContain("npm page still returns 404");
  });
});
