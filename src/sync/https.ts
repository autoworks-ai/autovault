import dns from "node:dns/promises";
import os from "node:os";
import { z } from "zod";
import { loadConfig } from "../config.js";
import {
  assertContentLength,
  fetchWithDeadline,
  readBoundedText,
} from "../util/bounded-fetch.js";
import { MAX_TOTAL_BYTES } from "../util/limits.js";
import {
  DEVICE_CODE_GRANT_TYPE,
  httpsBundlePath,
  signDeviceRequest,
  SYNC_DEVICE_HEADERS,
  SYNC_DEVICE_PAIR_PATH,
  SYNC_DEVICE_TOKEN_PATH,
  SYNC_HTTPS_CATALOG_FILENAME,
  syncCatalogSchema,
  syncSkillBundleSchema,
  type SyncCatalog,
  type SyncSigningKeypair,
  type SyncSkillBundle,
} from "./contract.js";
import { cloudApiUrl } from "./origin.js";

const MAX_SYNC_CATALOG_BYTES = 1 * 1024 * 1024;
const MAX_SYNC_DEVICE_BYTES = 64 * 1024;

const deviceEnrollmentResponseSchema = z.object({
  device_id: z.string().min(1),
  status: z.enum(["pending", "active", "revoked"]),
});

const devicePairingStartSchema = z.object({
  device_code: z.string().min(16).max(128),
  user_code: z
    .string()
    .min(4)
    .max(20)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().nonnegative().optional().default(5),
});

const devicePairingTokenSchema = z.object({
  slug: z.string().min(1),
  catalog_url: z.string().url(),
  device_id: z.string().min(1),
  status: z.enum(["pending", "active"]),
});

export type HttpsDeviceEnrollment = z.infer<
  typeof deviceEnrollmentResponseSchema
>;
export type DevicePairingStart = z.infer<typeof devicePairingStartSchema>;
export type DevicePairingToken = z.infer<typeof devicePairingTokenSchema>;
export type DevicePairingPoll =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "authorized"; result: DevicePairingToken };

export class HttpsSyncError extends Error {
  readonly name = "HttpsSyncError";
  readonly serverMessage: string | null;

  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: URL,
    serverMessage: string | null,
  ) {
    const safe = serverMessage ? sanitizeServerMessage(serverMessage) : "";
    super(
      safe.length > 0
        ? safe
        : `HTTPS sync failed: ${status} ${statusText} (${url})`,
    );
    this.serverMessage = safe.length > 0 ? safe : null;
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

export async function startDevicePairing(
  device: SyncSigningKeypair,
): Promise<DevicePairingStart> {
  const url = cloudApiUrl(SYNC_DEVICE_PAIR_PATH);
  const hostname = deviceHostname();
  const parsed = devicePairingStartSchema.safeParse(
    await fetchSignedJson(url, {
      method: "POST",
      device,
      maxBytes: MAX_SYNC_DEVICE_BYTES,
      body: {
        public_key: device.publicKey,
        ...(hostname ? { hostname } : {}),
      },
    }),
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid device pairing response: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function pollDevicePairing(
  device: SyncSigningKeypair,
  deviceCode: string,
): Promise<DevicePairingPoll> {
  const url = cloudApiUrl(SYNC_DEVICE_TOKEN_PATH);
  const result = await fetchSignedJsonResult(url, {
    method: "POST",
    device,
    maxBytes: MAX_SYNC_DEVICE_BYTES,
    body: {
      device_code: deviceCode,
      grant_type: DEVICE_CODE_GRANT_TYPE,
    },
  });
  if (!result.ok) {
    const code = rfcDeviceError(result.body) ?? result.error.serverMessage;
    if (code === "authorization_pending") return { state: "pending" };
    if (code === "slow_down") return { state: "slow_down" };
    throw result.error;
  }
  const parsed = devicePairingTokenSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error(
      `Invalid device pairing token: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return { state: "authorized", result: parsed.data };
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
    const message = rfcDeviceError(parsed);
    if (message) return message;
  } catch {
    // Fall through to the raw body when Cloud returns non-JSON.
  }
  const raw = sanitizeServerMessage(trimmed);
  return raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
}

function rfcDeviceError(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    const message = sanitizeServerMessage((body as { error: string }).error);
    if (message) return message;
  }
  return null;
}

function sanitizeServerMessage(message: string): string {
  return message.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

function deviceHostname(): string | undefined {
  try {
    const hostname = os.hostname().trim().slice(0, 120);
    return hostname.length > 0 ? hostname : undefined;
  } catch {
    return undefined;
  }
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
  const result = await fetchSignedJsonResult(url, input);
  if (!result.ok) throw result.error;
  return result.body;
}

async function fetchSignedJsonResult(
  url: URL,
  input: {
    method: "GET" | "POST";
    device: SyncSigningKeypair;
    maxBytes: number;
    body?: unknown;
  },
): Promise<
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; body: unknown; error: HttpsSyncError }
> {
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
    "Cache-Control": "no-store",
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
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new Error(`Invalid JSON from HTTPS sync: ${url}`);
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body,
      error: new HttpsSyncError(
        response.status,
        response.statusText,
        url,
        parseServerErrorMessage(text),
      ),
    };
  }
  return { ok: true, status: response.status, body };
}
