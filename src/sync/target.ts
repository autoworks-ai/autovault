import path from "node:path";
import { isHttpSyncTarget, normalizeHttpsCatalogUrl } from "./https.js";

export const DEFAULT_CLOUD_ORIGIN = "https://autovault.dev";
export const CLOUD_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type ResolvedLinkTarget =
  | { kind: "https"; catalogUrl: string; slug?: string }
  | { kind: "file"; path: string };

export function cloudOrigin(): string {
  const raw = process.env.AUTOVAULT_CLOUD_ORIGIN?.trim() || DEFAULT_CLOUD_ORIGIN;
  return raw.replace(/\/+$/, "");
}

export function cloudAdmitUrl(): string {
  return `${cloudOrigin()}/cloud`;
}

export function resolveLinkTarget(target: string): ResolvedLinkTarget {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("Missing vault slug, catalog URL, or catalog path");
  }
  if (isHttpSyncTarget(trimmed)) {
    return { kind: "https", catalogUrl: normalizeHttpsCatalogUrl(trimmed).href };
  }
  if (looksLikeFileTarget(trimmed)) {
    return { kind: "file", path: trimmed };
  }
  if (CLOUD_SLUG_PATTERN.test(trimmed)) {
    return {
      kind: "https",
      catalogUrl: normalizeHttpsCatalogUrl(`${cloudOrigin()}/v/${trimmed}`).href,
      slug: trimmed
    };
  }
  if (/[A-Z]/.test(trimmed) && CLOUD_SLUG_PATTERN.test(trimmed.toLowerCase())) {
    throw new Error(`Vault slugs are lowercase (try '${trimmed.toLowerCase()}')`);
  }
  throw new Error(`Not a vault slug, catalog URL, or catalog path: ${trimmed}`);
}

function looksLikeFileTarget(target: string): boolean {
  if (
    target.startsWith(".")
    || target.startsWith("~")
    || target.startsWith("/")
    || target.includes("/")
    || target.includes("\\")
    || target.endsWith(".json")
  ) {
    return true;
  }
  return path.isAbsolute(target);
}
