import { renderStatusOutro, renderSuccessOutro } from "./ui/brand.js";
import { startSpinner } from "./ui/tasks.js";
import { keyValueRows } from "./ui/table.js";
import { makeTheme } from "./ui/theme.js";
import { writeJson } from "./ui/output.js";
import { writeOptionalUpdateNotice } from "./update.js";
import { withSuppressedLogs } from "../util/log.js";
import { cloudAdmitUrl } from "../sync/target.js";
import type { EnrolledUpstream } from "../sync/local.js";

const WAIT_INTERVAL_MS = 1500;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runLinkCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const target = args.find((arg) => !arg.startsWith("-"));
  if (!target) {
    process.stderr.write(
      "Usage: autovault link <slug|catalog-url|directory> [--json]\n",
    );
    process.exit(1);
  }

  const { completeEnrollmentFromTarget, refreshEnrollment } =
    await import("../sync/local.js");
  let enrollment = await withSuppressedLogs(() =>
    completeEnrollmentFromTarget(target),
  );

  if (!json && shouldWaitForAdmit(enrollment)) {
    enrollment = await waitForAdmit(enrollment, refreshEnrollment);
  }

  if (json) {
    writeJson({ enrollment });
    return;
  }

  process.stdout.write(formatLinkResult(enrollment));
  writeOptionalUpdateNotice();
}

function shouldWaitForAdmit(enrollment: EnrolledUpstream): boolean {
  if (enrollment.type !== "https") return false;
  if (enrollment.enrollment.status !== "pending") return false;
  if (process.env.CI) return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function waitForAdmit(
  enrollment: EnrolledUpstream,
  refresh: (upstreamId: string) => Promise<EnrolledUpstream>,
): Promise<EnrolledUpstream> {
  const spin = startSpinner(
    `waiting for owner admit at ${cloudAdmitUrl()}  ·  ${shortKey(enrollment.enrollment.device_public_key)}`,
  );
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(WAIT_INTERVAL_MS);
      const current = await withSuppressedLogs(() => refresh(enrollment.id));
      if (current.enrollment.status === "revoked") {
        spin.error("device was revoked");
        process.exit(1);
      }
      if (current.enrollment.status === "active") {
        spin.stop("admitted");
        return current;
      }
    }
    spin.stop("still pending");
    return enrollment;
  } catch (error) {
    spin.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function formatLinkResult(enrollment: EnrolledUpstream): string {
  const unpublished = isUnpublishedCatalog(enrollment);
  const pending = enrollment.enrollment.status === "pending";
  const theme = makeTheme(process.stdout);
  const fingerprint = shortKey(enrollment.enrollment.device_public_key);
  const admitUrl = cloudAdmitUrl();
  const rows = keyValueRows(
    [
      ...(unpublished
        ? [
            {
              label: "catalog",
              value: "nothing published yet",
              status: "warn" as const,
            },
          ]
        : []),
      {
        label: "status",
        value: enrollment.enrollment.status,
        status:
          enrollment.enrollment.status === "active"
            ? "ok"
            : pending
              ? "warn"
              : "error",
      },
      {
        label: "device",
        value: enrollment.enrollment.device_id,
        status: "muted",
      },
      { label: "key", value: `ed25519 ${fingerprint}`, status: "muted" },
    ],
    theme,
  );

  if (enrollment.enrollment.status === "active" && !unpublished) {
    return renderSuccessOutro(`Linked ${enrollment.name}`, [
      `status  ${enrollment.enrollment.status}`,
      `device  ${enrollment.enrollment.device_id}`,
      `key     ed25519 ${fingerprint}`,
    ]);
  }

  const waiting = unpublished ? "waiting for a catalog" : "waiting for admit";
  const next = unpublished
    ? [
        `Admit this machine at ${admitUrl}`,
        "Publish the first catalog from the owner console",
      ]
    : pending
      ? [`Admit this machine at ${admitUrl}`]
      : [];
  const nextLines = next.map((step) => `  ${theme.style.dim("next")} ${step}`);

  if (unpublished && !pending) {
    return renderStatusOutro(
      `Linked ${enrollment.name}`,
      [
        `${theme.style.dim("catalog")} nothing published yet`,
        `status  ${enrollment.enrollment.status}`,
        `device  ${enrollment.enrollment.device_id}`,
        `key     ed25519 ${fingerprint}`,
        ...next.map((step) => `${theme.style.dim("next")} ${step}`),
      ],
      process.stdout,
      { tone: "warn" },
    );
  }

  return `${theme.style.yellow(theme.symbol.warn)} ${theme.style.bold(`Linked ${enrollment.name}`)} ${theme.style.dim(waiting)}\n${rows}\n${nextLines.join("\n")}${nextLines.length > 0 ? "\n" : ""}`;
}

function isUnpublishedCatalog(enrollment: EnrolledUpstream): boolean {
  return (
    enrollment.type === "https" && enrollment.catalog_status === "unpublished"
  );
}

function shortKey(publicKey: string): string {
  if (publicKey.length < 10) return publicKey;
  return `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
