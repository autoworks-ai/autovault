import path from "node:path";
import { applyPublishSync, inspectPublishTarget, planPublishSync } from "../publish/index.js";
import { badge, sectionTitle } from "./ui/messages.js";
import { bulletList, keyValueRows } from "./ui/table.js";
import { makeTheme } from "./ui/theme.js";
import { writeJson } from "./ui/output.js";

type PublishCliOptions = {
  action: "status" | "sync";
  repo: string;
  apply: boolean;
  json: boolean;
};

function usage(): never {
  process.stderr.write(`Usage:
  autovault publish status --repo /path/to/catalog [--json]
  autovault publish sync --repo /path/to/catalog [--apply] [--json]
`);
  process.exit(1);
}

function parseOptions(args: string[]): PublishCliOptions {
  const action = args[0];
  if (action !== "status" && action !== "sync") usage();
  let repo: string | undefined;
  let apply = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) usage();
      repo = value;
      index += 1;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    usage();
  }
  if (!repo || (action === "status" && apply)) usage();
  return { action, repo: path.resolve(repo), apply, json };
}

function formatStatus(status: Awaited<ReturnType<typeof inspectPublishTarget>>): string {
  const theme = makeTheme(process.stdout);
  const lines = [
    "",
    `${badge("publish", theme)} ${theme.style.bold("Publication status")}`,
    sectionTitle("Target", theme),
    keyValueRows(
      [
        { label: "name", value: status.registry.target, status: "ok" },
        { label: "repo", value: status.targetRoot, status: "muted" },
        { label: "eligible", value: String(status.eligible.length), status: "ok" },
        {
          label: "blocked",
          value: String(status.blocked.length),
          status: status.blocked.length > 0 ? "error" : "muted"
        },
        { label: "hidden", value: String(status.hidden.length), status: "muted" }
      ],
      theme
    )
  ];
  if (status.blocked.length > 0) {
    lines.push("", sectionTitle("Blocked", theme));
    lines.push(
      bulletList(
        status.blocked.map((entry) => `${entry.name}: ${entry.reasons.join(", ")}`),
        theme
      )
    );
  }
  return `${lines.join("\n")}\n`;
}

function statusJson(status: Awaited<ReturnType<typeof inspectPublishTarget>>) {
  return {
    target: status.registry.target,
    repo: status.targetRoot,
    eligible: status.eligible,
    blocked: status.blocked,
    hidden: status.hidden
  };
}

export async function runPublishCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  if (options.action === "status") {
    const status = await inspectPublishTarget(options.repo);
    if (options.json) writeJson(statusJson(status));
    else process.stdout.write(formatStatus(status));
    return;
  }

  const plan = await planPublishSync(options.repo);
  if (!options.apply) {
    const output = {
      applied: false,
      target: plan.registry.target,
      repo: plan.targetRoot,
      copy: plan.copy.map((bundle) => bundle.name),
      remove: plan.remove,
      blocked: plan.blocked,
      hidden: plan.hidden
    };
    if (options.json) writeJson(output);
    else {
      const theme = makeTheme(process.stdout);
      process.stdout.write(
        `${formatStatus(plan)}\n${sectionTitle("Dry-run", theme)}\n${bulletList([
          `copy ${output.copy.length}: ${output.copy.join(", ") || "none"}`,
          `remove ${output.remove.length}: ${output.remove.join(", ") || "none"}`,
          "run again with --apply to update the target repository"
        ], theme)}\n`
      );
    }
    if (plan.blocked.length > 0) process.exit(1);
    return;
  }

  const result = await applyPublishSync(plan);
  if (options.json) writeJson(result);
  else {
    const theme = makeTheme(process.stdout);
    process.stdout.write(
      `\n${badge("publish", theme)} ${theme.style.bold("Publication sync applied")}\n${bulletList([
        `copied ${result.copied.length}: ${result.copied.join(", ") || "none"}`,
        `removed ${result.removed.length}: ${result.removed.join(", ") || "none"}`,
        `receipt ${result.receiptPath}`
      ], theme)}\n`
    );
  }
}
