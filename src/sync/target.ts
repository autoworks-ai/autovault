import path from "node:path";
import { isHttpSyncTarget, normalizeHttpsCatalogUrl } from "./https.js";
import { cloudOrigin } from "./origin.js";

export {
  DEFAULT_CLOUD_ORIGIN,
  cloudApiUrl,
  cloudOrigin,
  isCloudOriginUrl,
} from "./origin.js";
export const CLOUD_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type ResolvedLinkTarget =
  | { kind: "https"; catalogUrl: string; slug?: string }
  | { kind: "file"; path: string };

export function cloudAdmitUrl(fingerprint?: string, catalogUrl?: string): string {
  const origin = catalogUrl ? new URL(catalogUrl).origin : cloudOrigin();
  const base = `${origin}/cloud`;
  if (!fingerprint) return base;
  return `${base}?admit=${encodeURIComponent(fingerprint)}`;
}

export function cloudPairUrl(userCode?: string): string {
  const base = `${cloudOrigin()}/cloud/pair`;
  if (!userCode) return base;
  return `${base}?code=${encodeURIComponent(userCode)}`;
}

export function deviceFingerprint(publicKey: string): string {
  if (publicKey.length < 10) return publicKey;
  return `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
}

export function slugFromCatalogUrl(
  catalogUrl: URL | string,
): string | undefined {
  const url = typeof catalogUrl === "string" ? new URL(catalogUrl) : catalogUrl;
  const match = url.pathname.match(/\/v\/([a-z0-9][a-z0-9-]{0,199})(?:\/|$)/i);
  return match?.[1]?.toLowerCase();
}

export function resolveLinkTarget(target: string): ResolvedLinkTarget {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("Missing vault slug, catalog URL, or catalog path");
  }
  if (isHttpSyncTarget(trimmed)) {
    return {
      kind: "https",
      catalogUrl: normalizeHttpsCatalogUrl(trimmed).href,
    };
  }
  if (looksLikeFileTarget(trimmed)) {
    return { kind: "file", path: trimmed };
  }
  if (CLOUD_SLUG_PATTERN.test(trimmed)) {
    return {
      kind: "https",
      catalogUrl: normalizeHttpsCatalogUrl(`${cloudOrigin()}/v/${trimmed}`)
        .href,
      slug: trimmed,
    };
  }
  if (/[A-Z]/.test(trimmed) && CLOUD_SLUG_PATTERN.test(trimmed.toLowerCase())) {
    throw new Error(
      `Vault slugs are lowercase (try '${trimmed.toLowerCase()}')`,
    );
  }
  throw new Error(`Not a vault slug, catalog URL, or catalog path: ${trimmed}`);
}

function looksLikeFileTarget(target: string): boolean {
  if (
    target.startsWith(".") ||
    target.startsWith("~") ||
    target.startsWith("/") ||
    target.includes("/") ||
    target.includes("\\") ||
    target.endsWith(".json")
  ) {
    return true;
  }
  return path.isAbsolute(target);
}
