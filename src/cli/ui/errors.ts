import { HttpsSyncError } from "../../sync/https.js";
import {
  SYNC_DEVICE_PAIR_PATH,
  SYNC_DEVICE_TOKEN_PATH,
} from "../../sync/contract.js";
import { cloudAdmitUrl, slugFromCatalogUrl } from "../../sync/target.js";
import { badge } from "./messages.js";
import { keyValueRows, type TableRow } from "./table.js";
import { makeTheme } from "./theme.js";

export type CliErrorView = {
  title: string;
  summary: string;
  rows: TableRow[];
  next: string[];
};

export function describeCliError(error: unknown): CliErrorView {
  if (error instanceof HttpsSyncError) return describeHttpsSyncError(error);
  const message = error instanceof Error ? error.message : String(error);
  return {
    title: "AutoVault could not finish",
    summary: message,
    rows: [],
    next: [],
  };
}

export function formatCliError(
  error: unknown,
  stream: NodeJS.WriteStream = process.stderr,
): string {
  const theme = makeTheme(stream);
  const view = describeCliError(error);
  const heading =
    error instanceof HttpsSyncError
      ? `${badge("cloud", theme, "warn")} ${theme.style.bold("AutoVault")} ${theme.style.dim("could not sync")}`
      : `${badge("vault", theme, "warn")} ${theme.style.bold("AutoVault")}`;
  const lines = [
    heading,
    `${theme.style.red(theme.symbol.cross)} ${theme.style.bold(view.title)}`,
    view.summary ? `  ${view.summary}` : "",
    keyValueRows(view.rows, theme),
    ...view.next.map((step) => `  ${theme.style.dim("next")} ${step}`),
  ].filter((line) => line.length > 0);
  return `${lines.join("\n")}\n`;
}

function describeHttpsSyncError(error: HttpsSyncError): CliErrorView {
  const slug = slugFromCatalogUrl(error.url);
  const message = error.serverMessage ?? error.message;

  if (/no published catalog/i.test(message)) {
    return {
      title: "This vault has no catalog yet",
      summary:
        "The vault exists. The owner has not published a signed catalog.",
      rows: cloudRows(slug, error),
      next: [
        `Admit this machine at ${cloudAdmitUrl(undefined, error.url.href)}`,
        "Publish the first catalog from the owner console, then run autovault link again",
      ],
    };
  }
  if (
    error.status === 404 &&
    (error.url.pathname === SYNC_DEVICE_PAIR_PATH ||
      error.url.pathname === SYNC_DEVICE_TOKEN_PATH)
  ) {
    return {
      title: "Cloud pairing is not available yet",
      summary:
        "This Cloud origin does not have the slug-less pairing endpoints.",
      rows: cloudRows(slug, error),
      next: [
        "Copy the vault slug from the owner console",
        "Run autovault link <slug>",
      ],
    };
  }
  if (/no such vault/i.test(message)) {
    return {
      title: "No vault uses that slug",
      summary: slug
        ? `Cloud does not have a vault named ${slug}.`
        : "Cloud does not have a vault at that address.",
      rows: cloudRows(slug, error),
      next: [`Create or copy the slug from ${cloudAdmitUrl(undefined, error.url.href)}`],
    };
  }
  if (/too many devices/i.test(message)) {
    return {
      title: "Too many devices are waiting",
      summary:
        "The owner needs to admit or deny pending machines before another can link.",
      rows: cloudRows(slug, error),
      next: [`Clear the queue at ${cloudAdmitUrl(undefined, error.url.href)}`],
    };
  }
  if (/expired_token/i.test(message)) {
    return {
      title: "This pairing code expired",
      summary: "Confirm the next code from autovault link.",
      rows: cloudRows(slug, error),
      next: ["Run autovault link"],
    };
  }
  if (/access_denied/i.test(message)) {
    return {
      title: "The owner denied this machine",
      summary: "The browser pairing was rejected.",
      rows: cloudRows(slug, error),
      next: ["Run autovault link"],
    };
  }
  if (error.status === 401 || /signature/i.test(message)) {
    return {
      title: "Cloud did not accept this device",
      summary: message,
      rows: cloudRows(slug, error),
      next: [`Retry autovault link${slug ? ` ${slug}` : ""}`],
    };
  }

  return {
    title: "Cloud sync failed",
    summary: message,
    rows: cloudRows(slug, error),
    next: [],
  };
}

function cloudRows(
  slug: string | undefined,
  error: HttpsSyncError,
): TableRow[] {
  const rows: TableRow[] = [];
  if (slug) rows.push({ label: "slug", value: slug, status: "muted" });
  rows.push({ label: "status", value: String(error.status), status: "error" });
  return rows;
}
