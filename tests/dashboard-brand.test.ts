import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function readProjectFile(filePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, filePath), "utf-8");
}

describe("dashboard brand system", () => {
  it("uses the AutoVault vault mark instead of the placeholder AV block", () => {
    const app = readProjectFile("ui/client/src/App.tsx");

    expect(app).toContain("function VaultMark");
    expect(app).toContain("AutoVault mark");
    expect(app).not.toContain('<div className="brand-mark">AV</div>');
  });

  it("exposes Control Plane brand tokens and motion-safe state hooks", () => {
    const styles = readProjectFile("ui/client/src/styles.css");

    expect(styles).toContain("--av-bg: #0b1014");
    expect(styles).toContain("--av-mint: #5ad6c0");
    expect(styles).toContain(".av-state-scan");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".status-pill.user-approve");
  });

  it("lands on a control plane home view before opening records", () => {
    const app = readProjectFile("ui/client/src/App.tsx");

    expect(app).toContain('type View = "home" | "skills" | "profiles" | "updates" | "permissions" | "users"');
    expect(app).toContain('useState<View>("home")');
    expect(app).toContain("function HomeView");
  });

  it("uses a collection browser for skills before opening skill detail", () => {
    const app = readProjectFile("ui/client/src/App.tsx");
    const styles = readProjectFile("ui/client/src/styles.css");

    expect(app).toContain("type SkillViewMode");
    expect(app).toContain("type SkillSortKey");
    expect(app).toContain("function SkillsCollection");
    expect(app).not.toContain("return body.skills[0]?.name ?? null;");
    expect(styles).toContain(".collection-toolbar");
    expect(styles).toContain(".skill-card-grid");
    expect(styles).toContain(".skill-table");
  });

  it("shares a cloud-compatible shell with top navigation, account context, and users gating", () => {
    const app = readProjectFile("ui/client/src/App.tsx");
    const styles = readProjectFile("ui/client/src/styles.css");

    expect(app).toContain("function TopNavigation");
    expect(app).toContain("function AccountSummary");
    expect(app).toContain("function AddSkillDialog");
    expect(app).toContain("function UsersPanel");
    expect(app).toContain("Local operator");
    expect(styles).toContain(".top-nav");
    expect(styles).toContain(".account-card");
    expect(styles).toContain(".add-skill-dialog");
    expect(styles).toContain(".users-panel");
  });

  it("has a context-driven upgrade guard for signed UI bundle API skew", () => {
    const app = readProjectFile("ui/client/src/App.tsx");
    const styles = readProjectFile("ui/client/src/styles.css");

    expect(app).toContain("/context");
    expect(app).toContain("function UpgradeRequiredScreen");
    expect(app).toContain("upgrade_required");
    expect(styles).toContain(".upgrade-screen");
  });

  it("renders skill details as an inspectable bundle, not only editable metadata", () => {
    const app = readProjectFile("ui/client/src/App.tsx");
    const styles = readProjectFile("ui/client/src/styles.css");

    expect(app).toContain("type SkillBundleFile");
    expect(app).toContain("function SkillBundleInspector");
    expect(app).toContain("Bundle contents");
    expect(app).toContain("Provenance");
    expect(app).toContain("Permission surface");
    expect(styles).toContain(".skill-detail-tabs");
    expect(styles).toContain(".bundle-browser");
    expect(styles).toContain(".resource-preview");
    expect(styles).toContain(".provenance-grid");
  });
});
