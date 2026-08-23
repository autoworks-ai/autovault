import { renderStatusOutro, renderSuccessOutro } from "./ui/brand.js";
import { startSpinner } from "./ui/tasks.js";
import { keyValueRows } from "./ui/table.js";
import { makeTheme } from "./ui/theme.js";
import { writeJson } from "./ui/output.js";
import { writeOptionalUpdateNotice } from "./update.js";
import { withSuppressedLogs } from "../util/log.js";
import { openBrowser, shouldOpenBrowser } from "../util/open-browser.js";
import { cloudAdmitUrl, deviceFingerprint } from "../sync/target.js";
import type { EnrolledUpstream } from "../sync/local.js";

const WAIT_INTERVAL_MS = 1500;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runLinkCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const noBrowser = args.includes("--no-browser");
  const target = args.find((arg) => !arg.startsWith("-"));
  if (!target) {
    process.stderr.write(
      "Usage: autovault link <slug|catalog-url|directory> [--json] [--no-browser]\n",
    );
    process.exit(1);
  }

  const { completeEnrollmentFromTarget, refreshEnrollment } =
    await import("../sync/local.js");
  let enrollment = await withSuppressedLogs(() =>
    completeEnrollmentFromTarget(target),
  );

  if (!json && shouldWaitForAdmit(enrollment)) {
    process.stdout.write(formatAdmitPrompt(enrollment));
    maybeOpenAdmitBrowser(enrollment, { json, noBrowser });
    enrollment = await waitForAdmit(enrollment, refreshEnrollment);
  }

  if (json) {
    writeJson(jsonLinkResult(enrollment));
    return;
  }

  process.stdout.write(formatLinkResult(enrollment));
  writeOptionalUpdateNotice();
}

function httpsAdmitUrl(
  enrollment: EnrolledUpstream,
  fingerprint?: string,
): string {
  const catalogUrl =
    enrollment.type === "https" ? enrollment.catalog_url : undefined;
  return cloudAdmitUrl(fingerprint, catalogUrl);
}

function jsonLinkResult(enrollment: EnrolledUpstream): {
  enrollment: EnrolledUpstream;
  admit?: { url: string; fingerprint: string };
} {
  if (enrollment.type !== "https") return { enrollment };
  const fingerprint = deviceFingerprint(
    enrollment.enrollment.device_public_key,
  );
  return {
    enrollment,
    admit: {
      url: httpsAdmitUrl(enrollment, fingerprint),
      fingerprint,
    },
  };
}

function formatAdmitPrompt(enrollment: EnrolledUpstream): string {
  const theme = makeTheme(process.stdout);
  const fingerprint = deviceFingerprint(
    enrollment.enrollment.device_public_key,
  );
  const admitUrl = httpsAdmitUrl(enrollment, fingerprint);
  return [
    `${theme.style.yellow(theme.symbol.warn)} ${theme.style.bold("Admit this machine")} ${theme.style.dim(`ed25519 ${fingerprint}`)}`,
    `  ${theme.style.dim("open")} ${admitUrl}`,
    "",
  ].join("\n");
}

function maybeOpenAdmitBrowser(
  enrollment: EnrolledUpstream,
  flags: { json: boolean; noBrowser: boolean },
): void {
  if (enrollment.type !== "https") return;
  if (enrollment.enrollment.status !== "pending") return;
  if (!shouldOpenBrowser(flags)) return;
  const fingerprint = deviceFingerprint(
    enrollment.enrollment.device_public_key,
  );
  openBrowser(httpsAdmitUrl(enrollment, fingerprint));
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
  const fingerprint = deviceFingerprint(
    enrollment.enrollment.device_public_key,
  );
  const admitUrl = httpsAdmitUrl(enrollment, fingerprint);
  const spin = startSpinner(
    `waiting for Admit in the browser  ·  ${fingerprint}`,
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
    spin.stop(`still pending  ·  ${admitUrl}`);
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
  const fingerprint = deviceFingerprint(
    enrollment.enrollment.device_public_key,
  );
  const admitUrl = httpsAdmitUrl(enrollment, fingerprint);
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
        ...(pending ? [`Admit this machine at ${admitUrl}`] : []),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
