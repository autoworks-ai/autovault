import dns from "node:dns/promises";
import { z } from "zod";
import { loadConfig } from "../config.js";
import {
  assertContentLength,
  fetchWithDeadline,
  readBoundedText,
} from "../util/bounded-fetch.js";
import { MAX_TOTAL_BYTES } from "../util/limits.js";
import {
  httpsBundlePath,
  signDeviceRequest,
  SYNC_DEVICE_HEADERS,
  SYNC_HTTPS_CATALOG_FILENAME,
  syncCatalogSchema,
  syncSkillBundleSchema,
  type SyncCatalog,
  type SyncSigningKeypair,
  type SyncSkillBundle,
} from "./contract.js";

const MAX_SYNC_CATALOG_BYTES = 1 * 1024 * 1024;
const MAX_SYNC_DEVICE_BYTES = 64 * 1024;

const deviceEnrollmentResponseSchema = z.object({
  device_id: z.string().min(1),
  status: z.enum(["pending", "active", "revoked"]),
});

export type HttpsDeviceEnrollment = z.infer<
  typeof deviceEnrollmentResponseSchema
>;

export class HttpsSyncError extends Error {
  readonly name = "HttpsSyncError";

  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: URL,
    readonly serverMessage: string | null,
  ) {
    super(
      serverMessage && serverMessage.length > 0
        ? serverMessage
        : `HTTPS sync failed: ${status} ${statusText} (${url})`,
    );
  }
}

export function isUnpublishedCatalogError(error: unknown): boolean {
  return (
    error instanceof HttpsSyncError &&
    error.status === 404 &&
    /no published catalog/i.test(error.serverMessage ?? error.message)
  );
}

export function isHttpSyncTarget(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeHttpsCatalogUrl(target: string): URL {
  const url = new URL(target);
  assertAllowedSyncUrl(url);
  if (
    url.pathname === `/${SYNC_HTTPS_CATALOG_FILENAME}` ||
    url.pathname.endsWith(`/${SYNC_HTTPS_CATALOG_FILENAME}`)
  ) {
    return url;
  }
  const root = url.pathname.endsWith("/")
    ? url
    : new URL(`${url.pathname}/`, url);
  return new URL(SYNC_HTTPS_CATALOG_FILENAME, root);
}

export async function enrollHttpsDevice(
  catalogUrl: URL,
  device: SyncSigningKeypair,
): Promise<HttpsDeviceEnrollment> {
  const url = new URL("devices", catalogDirectoryUrl(catalogUrl));
  const parsed = deviceEnrollmentResponseSchema.safeParse(
    await fetchSignedJson(url, {
      method: "POST",
      device,
      maxBytes: MAX_SYNC_DEVICE_BYTES,
      body: { public_key: device.publicKey },
    }),
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid device enrollment response: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function fetchHttpsDeviceStatus(
  catalogUrl: URL,
  device: SyncSigningKeypair,
): Promise<HttpsDeviceEnrollment> {
  const url = new URL("devices/current", catalogDirectoryUrl(catalogUrl));
  const parsed = deviceEnrollmentResponseSchema.safeParse(
    await fetchSignedJson(url, {
      method: "GET",
      device,
      maxBytes: MAX_SYNC_DEVICE_BYTES,
    }),
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid device status response: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function fetchHttpsCatalog(
  catalogUrl: URL,
  device: SyncSigningKeypair,
): Promise<SyncCatalog> {
  const parsed = syncCatalogSchema.safeParse(
    await fetchSignedJson(catalogUrl, {
      method: "GET",
      device,
      maxBytes: MAX_SYNC_CATALOG_BYTES,
    }),
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid upstream catalog: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function fetchHttpsBundle(
  catalogUrl: URL,
  bundlePath: string,
  bundleHash: string,
  device: SyncSigningKeypair,
): Promise<SyncSkillBundle> {
  const bundleUrl = resolveHttpsBundleUrl(catalogUrl, bundlePath, bundleHash);
  const parsed = syncSkillBundleSchema.safeParse(
    await fetchSignedJson(bundleUrl, {
      method: "GET",
      device,
      maxBytes: MAX_TOTAL_BYTES,
    }),
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid sync bundle: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export function resolveHttpsBundleUrl(
  catalogUrl: URL,
  bundlePath: string,
  bundleHash: string,
): URL {
  const resolved = new URL(bundlePath, catalogUrl);
  assertHttpsBundleContained(catalogUrl, resolved, bundlePath);
  const expected = new URL(httpsBundlePath(bundleHash), catalogUrl);
  if (resolved.href !== expected.href) {
    throw new Error(
      `HTTPS bundle path must be bundles/<bundle_hash>.json (got ${bundlePath})`,
    );
  }
  return resolved;
}

function assertHttpsBundleContained(
  catalogUrl: URL,
  bundleUrl: URL,
  bundlePath: string,
): void {
  if (bundleUrl.username || bundleUrl.password) {
    throw new Error(`Bundle path escapes upstream catalog: ${bundlePath}`);
  }
  if (
    bundleUrl.protocol !== catalogUrl.protocol ||
    bundleUrl.host !== catalogUrl.host
  ) {
    throw new Error(`Bundle path escapes upstream catalog: ${bundlePath}`);
  }
  const catalogDir = decodeURIComponent(catalogDirectoryPath(catalogUrl));
  const child = decodeURIComponent(bundleUrl.pathname);
  if (child.split("/").includes("..") || catalogDir.split("/").includes("..")) {
    throw new Error(`Bundle path escapes upstream catalog: ${bundlePath}`);
  }
  if (child === catalogDir || !child.startsWith(catalogDir)) {
    throw new Error(`Bundle path escapes upstream catalog: ${bundlePath}`);
  }
}

function catalogDirectoryUrl(catalogUrl: URL): URL {
  return new URL(".", catalogUrl);
}

function catalogDirectoryPath(catalogUrl: URL): string {
  const { pathname } = catalogUrl;
  const slash = pathname.lastIndexOf("/");
  return slash === -1 ? "/" : pathname.slice(0, slash + 1);
}

function assertAllowedSyncUrl(url: URL): void {
  if (url.protocol === "https:") {
    if (loadConfig().mode === "remote" && isLoopbackHost(url.hostname)) {
      throw new Error(
        `HTTPS sync refused private catalog host: ${url.hostname}`,
      );
    }
    return;
  }
  if (
    url.protocol === "http:" &&
    isLoopbackHost(url.hostname) &&
    loadConfig().mode === "local"
  ) {
    return;
  }
  throw new Error(
    `Only https catalog URLs are supported (got ${url.protocol})`,
  );
}

async function assertRemotePublicDestination(url: URL): Promise<void> {
  if (loadConfig().mode !== "remote") return;
  if (isLoopbackHost(url.hostname)) {
    throw new Error(`HTTPS sync refused private catalog host: ${url.hostname}`);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`HTTPS sync failed: cannot resolve ${url.hostname}`);
  }
  for (const address of addresses) {
    if (isPrivateIp(address.address)) {
      throw new Error(
        `HTTPS sync refused private catalog host: ${url.hostname}`,
      );
    }
  }
}

function isPrivateIp(ip: string): boolean {
  const value = ip.toLowerCase();
  if (value === "0.0.0.0" || value === "::" || value === "::1") return true;
  if (value.startsWith("127.")) return true;
  if (value.startsWith("10.")) return true;
  if (value.startsWith("192.168.")) return true;
  if (value.startsWith("169.254.")) return true;
  const rfc1918 = value.match(/^172\.(\d+)\./);
  if (rfc1918) {
    const octet = Number(rfc1918[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  )
    return true;
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function parseServerErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      const message = (parsed as { error: string }).error.trim();
      if (message) return message;
    }
  } catch {
    // Fall through to the raw body when Cloud returns non-JSON.
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

async function fetchSignedJson(
  url: URL,
  input: {
    method: "GET" | "POST";
    device: SyncSigningKeypair;
    maxBytes: number;
    body?: unknown;
  },
): Promise<unknown> {
  assertAllowedSyncUrl(url);
  await assertRemotePublicDestination(url);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signDeviceRequest(
    input.device.secretKey,
    input.method,
    url.pathname,
    timestamp,
  );
  const headers: Record<string, string> = {
    "User-Agent": "autovault",
    Accept: "application/json",
    [SYNC_DEVICE_HEADERS.device]: input.device.publicKey,
    [SYNC_DEVICE_HEADERS.timestamp]: timestamp,
    [SYNC_DEVICE_HEADERS.signature]: signature,
  };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchWithDeadline(
    fetch,
    url,
    {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      redirect: "manual",
    },
    url.toString(),
  );
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`HTTPS sync refused redirect: ${url}`);
  }
  assertContentLength(
    url.toString(),
    response.headers.get("content-length"),
    input.maxBytes,
  );
  const text = await readBoundedText(response, input.maxBytes, url.toString());
  if (!response.ok) {
    throw new HttpsSyncError(
      response.status,
      response.statusText,
      url,
      parseServerErrorMessage(text),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON from HTTPS sync: ${url}`);
  }
}
