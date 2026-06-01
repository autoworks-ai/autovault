import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { fetchWithDeadline, readBoundedText } from "../util/bounded-fetch.js";
import { canonicalRelPath } from "../util/path.js";
import { compareVersions } from "../util/version-compare.js";

const textEncoder = new TextEncoder();
const UI_BUNDLE_SIGNATURE_DOMAIN = "autovault-ui-bundle-v1";
const MAX_UI_MANIFEST_BYTES = 512 * 1024;
const MAX_UI_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_UI_BUNDLE_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;

export const MANAGEMENT_API_VERSION = "1.0.0";
export const DEFAULT_UI_CHANNEL = "stable";
export const BUNDLED_UI_BUNDLE_VERSION = "bundled";
export const UI_BUNDLE_MANIFEST_FILENAME = "autovault-ui-manifest.json";

// Dedicated UI publisher identity. This is intentionally not the local
// per-vault signing key; production releases can rotate this public key before
// enabling a default CDN endpoint without changing the trust model.
export const PINNED_UI_PUBLISHER_PUBLIC_KEY =
  "s-hQ8oFx_TP3BpV_vtADdQ1OD6VWjq_URqVIBKxoVcw";

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const semverSchema = z
  .string()
  .regex(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/);
const channelSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);

const uiBundleAssetSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256HexSchema,
    size: z.number().int().nonnegative().max(MAX_UI_ASSET_BYTES).optional(),
    content_type: z.string().min(1).optional()
  })
  .strict();

const unsignedUiBundleManifestSchema = z
  .object({
    schema_version: z.literal(1),
    version: semverSchema,
    channel: channelSchema,
    entrypoint: z.string().min(1),
    assets: z.array(uiBundleAssetSchema).min(1).max(1024),
    bundle_hash: sha256HexSchema,
    min_api_version: semverSchema,
    max_api_version: semverSchema.optional(),
    created_at: z.string().min(1)
  })
  .strict();

const uiBundleSignatureSchema = z
  .object({
    algorithm: z.literal("ed25519"),
    public_key: z.string().min(1),
    signature: z.string().min(1)
  })
  .strict();

const uiBundleManifestSchema = unsignedUiBundleManifestSchema.extend({
  signature: uiBundleSignatureSchema
});

const lastGoodPointerSchema = z
  .object({
    schema_version: z.literal(1),
    channel: channelSchema,
    version: semverSchema,
    updated_at: z.string().min(1)
  })
  .strict();

export type UiBundleAsset = z.infer<typeof uiBundleAssetSchema>;
export type UnsignedUiBundleManifest = z.infer<typeof unsignedUiBundleManifestSchema>;
export type UiBundleManifest = z.infer<typeof uiBundleManifestSchema>;

export type UiBundleSigningKeypair = {
  publicKey: string;
  secretKey: string;
};

export type UiCompatibilityStatus =
  | "compatible"
  | "upgrade_required"
  | "too_new"
  | "unknown";

export type UiBundleCompatibility = {
  status: UiCompatibilityStatus;
  api_version: string;
  min_api_version: string;
  max_api_version?: string;
  reason?: string;
};

export type ResolvedUiBundleAssets = {
  source: "remote" | "cached" | "bundled" | "fallback" | "dev";
  root: string;
  version: string;
  channel: string;
  entrypoint: string;
  compatibility: UiBundleCompatibility;
  fallbackReason?: string;
  manifest?: UiBundleManifest;
};

export type ResolveUiBundleAssetsOptions = {
  bundledRoot?: string;
  cacheRoot?: string;
  manifestUrl?: string;
  publisherPublicKey?: string;
  channel?: string;
  offline?: boolean;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  apiVersion?: string;
  devStaticRoot?: string;
};

type VerificationResult =
  | { ok: true; manifest: UiBundleManifest }
  | { ok: false; reason: string };

type AssetVerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function createUiBundleSigningKeypair(): UiBundleSigningKeypair {
  const pair = nacl.sign.keyPair();
  return {
    publicKey: toBase64Url(pair.publicKey),
    secretKey: toBase64Url(pair.secretKey)
  };
}

export function uiAssetHash(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function uiBundleHash(assets: Array<Pick<UiBundleAsset, "path" | "sha256">>): string {
  const lines = assets
    .map((asset) => {
      const safePath = safeUiAssetPath(asset.path);
      if (!safePath) throw new Error(`Invalid UI bundle asset path: ${asset.path}`);
      return `${safePath}\t${asset.sha256}`;
    })
    .sort((a, b) => a.localeCompare(b));
  return uiAssetHash(lines.join("\n"));
}

export function signUiBundleManifest(
  input: UnsignedUiBundleManifest,
  signer: UiBundleSigningKeypair
): UiBundleManifest {
  const unsigned = parseUnsignedManifest(input);
  const signature = nacl.sign.detached(
    uiBundleManifestMessage(unsigned),
    fromBase64Url(signer.secretKey)
  );
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      public_key: signer.publicKey,
      signature: toBase64Url(signature)
    }
  };
}

export function verifyUiBundleManifest(
  input: unknown,
  expectedPublicKey = PINNED_UI_PUBLISHER_PUBLIC_KEY
): VerificationResult {
  const parsed = uiBundleManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: `malformed manifest: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  const manifest = parsed.data;
  const pathCheck = validateManifestPaths(manifest);
  if (!pathCheck.ok) return pathCheck;
  if (manifest.bundle_hash !== uiBundleHash(manifest.assets)) {
    return { ok: false, reason: "bundle hash mismatch" };
  }
  if (manifest.signature.public_key !== expectedPublicKey) {
    return { ok: false, reason: "publisher key mismatch" };
  }
  const { signature: _signature, ...unsigned } = manifest;
  try {
    const valid = nacl.sign.detached.verify(
      uiBundleManifestMessage(unsigned),
      fromBase64Url(manifest.signature.signature),
      fromBase64Url(manifest.signature.public_key)
    );
    return valid ? { ok: true, manifest } : { ok: false, reason: "manifest signature invalid" };
  } catch {
    return { ok: false, reason: "manifest signature invalid" };
  }
}

export async function verifyUiBundleAssets(
  root: string,
  manifest: UiBundleManifest
): Promise<AssetVerificationResult> {
  const expectedPaths = new Set(manifest.assets.map((asset) => asset.path));
  const expected = new Map(manifest.assets.map((asset) => [asset.path, asset]));

  for (const asset of manifest.assets) {
    const safePath = safeUiAssetPath(asset.path);
    if (!safePath) return { ok: false, reason: `invalid asset path: ${asset.path}` };
    const filePath = path.join(root, safePath);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(filePath);
    } catch {
      return { ok: false, reason: `missing asset: ${safePath}` };
    }
    const actualHash = uiAssetHash(bytes);
    if (actualHash !== asset.sha256) {
      return { ok: false, reason: `asset hash mismatch: ${safePath}` };
    }
    if (asset.size !== undefined && bytes.byteLength !== asset.size) {
      return { ok: false, reason: `asset size mismatch: ${safePath}` };
    }
  }

  const files = await listFiles(root);
  for (const file of files) {
    if (file === UI_BUNDLE_MANIFEST_FILENAME) continue;
    if (!expectedPaths.has(file)) return { ok: false, reason: `unsigned asset present: ${file}` };
    expected.delete(file);
  }
  if (expected.size > 0) {
    return { ok: false, reason: `missing asset: ${[...expected.keys()].sort()[0]}` };
  }
  return { ok: true };
}

export async function resolveUiBundleAssets(
  options: ResolveUiBundleAssetsOptions = {}
): Promise<ResolvedUiBundleAssets> {
  const bundledRoot = options.bundledRoot ?? defaultBundledUiRoot();
  const cacheRoot = options.cacheRoot ?? defaultUiBundleCacheRoot();
  const channel = options.channel ?? DEFAULT_UI_CHANNEL;
  const publisherPublicKey = options.publisherPublicKey ?? PINNED_UI_PUBLISHER_PUBLIC_KEY;
  const apiVersion = options.apiVersion ?? MANAGEMENT_API_VERSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let fallbackReason: string | undefined;

  if (options.devStaticRoot) {
    if (await hasEntrypoint(options.devStaticRoot, "index.html")) {
      return bundledLikeResult({
        source: "dev",
        root: options.devStaticRoot,
        channel,
        version: "dev",
        apiVersion,
        fallbackReason: "using local development static root"
      });
    }
    fallbackReason = "development static root has no index.html";
  }

  if (!options.offline && options.manifestUrl) {
    const remote = await fetchAndCacheRemoteBundle({
      cacheRoot,
      manifestUrl: options.manifestUrl,
      publisherPublicKey,
      channel,
      fetcher: options.fetcher ?? fetch,
      timeoutMs,
      apiVersion
    });
    if (remote.ok) return remote.assets;
    fallbackReason = remote.reason;
  } else if (options.offline) {
    fallbackReason = "remote UI check disabled";
  }

  const cached = await readCachedLastGood({
    cacheRoot,
    publisherPublicKey,
    channel,
    apiVersion,
    fallbackReason
  });
  if (cached) return cached;

  if (await hasEntrypoint(bundledRoot, "index.html")) {
    return bundledLikeResult({
      source: "bundled",
      root: bundledRoot,
      channel,
      version: BUNDLED_UI_BUNDLE_VERSION,
      apiVersion,
      fallbackReason
    });
  }

  return bundledLikeResult({
    source: "fallback",
    root: bundledRoot,
    channel,
    version: BUNDLED_UI_BUNDLE_VERSION,
    apiVersion,
    fallbackReason: fallbackReason ?? "bundled UI assets are not built"
  });
}

export function defaultBundledUiRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "client");
}

export function defaultUiBundleCacheRoot(): string {
  return path.join(loadConfig().storagePath, "ui-bundles");
}

export function compatibilityForUiBundle(
  manifest: Pick<UiBundleManifest, "min_api_version" | "max_api_version">,
  apiVersion = MANAGEMENT_API_VERSION
): UiBundleCompatibility {
  const minComparison = compareVersions(apiVersion, manifest.min_api_version);
  if (minComparison === null) {
    return {
      status: "unknown",
      api_version: apiVersion,
      min_api_version: manifest.min_api_version,
      max_api_version: manifest.max_api_version,
      reason: "API version comparison failed"
    };
  }
  if (minComparison < 0) {
    return {
      status: "upgrade_required",
      api_version: apiVersion,
      min_api_version: manifest.min_api_version,
      max_api_version: manifest.max_api_version,
      reason: `UI bundle requires API ${manifest.min_api_version} or newer`
    };
  }
  if (manifest.max_api_version) {
    const maxComparison = compareVersions(apiVersion, manifest.max_api_version);
    if (maxComparison === null) {
      return {
        status: "unknown",
        api_version: apiVersion,
        min_api_version: manifest.min_api_version,
        max_api_version: manifest.max_api_version,
        reason: "API version comparison failed"
      };
    }
    if (maxComparison > 0) {
      return {
        status: "too_new",
        api_version: apiVersion,
        min_api_version: manifest.min_api_version,
        max_api_version: manifest.max_api_version,
        reason: `UI bundle supports API up to ${manifest.max_api_version}`
      };
    }
  }
  return {
    status: "compatible",
    api_version: apiVersion,
    min_api_version: manifest.min_api_version,
    max_api_version: manifest.max_api_version
  };
}

function parseUnsignedManifest(input: UnsignedUiBundleManifest): UnsignedUiBundleManifest {
  const parsed = unsignedUiBundleManifestSchema.parse(input);
  const pathCheck = validateManifestPaths(parsed);
  if (!pathCheck.ok) throw new Error(pathCheck.reason);
  if (parsed.bundle_hash !== uiBundleHash(parsed.assets)) {
    throw new Error("bundle hash mismatch");
  }
  return parsed;
}

function validateManifestPaths(
  manifest: Pick<UnsignedUiBundleManifest, "entrypoint" | "assets">
): { ok: true } | { ok: false; reason: string } {
  const entrypoint = safeUiAssetPath(manifest.entrypoint);
  if (!entrypoint || entrypoint !== manifest.entrypoint) {
    return { ok: false, reason: `invalid entrypoint path: ${manifest.entrypoint}` };
  }
  const seen = new Set<string>();
  for (const asset of manifest.assets) {
    const safePath = safeUiAssetPath(asset.path);
    if (!safePath || safePath !== asset.path) {
      return { ok: false, reason: `invalid asset path: ${asset.path}` };
    }
    if (seen.has(safePath)) {
      return { ok: false, reason: `duplicate asset path: ${safePath}` };
    }
    seen.add(safePath);
  }
  if (!seen.has(entrypoint)) {
    return { ok: false, reason: `entrypoint is not listed as an asset: ${entrypoint}` };
  }
  return { ok: true };
}

function safeUiAssetPath(input: string): string | null {
  const canonical = canonicalRelPath(input);
  if (!canonical) return null;
  if (canonical !== input) return null;
  return canonical;
}

function uiBundleManifestMessage(unsignedManifest: UnsignedUiBundleManifest): Uint8Array {
  return textEncoder.encode(
    `${UI_BUNDLE_SIGNATURE_DOMAIN}\0${stableStringify(unsignedManifest)}`
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fetchAndCacheRemoteBundle(input: {
  cacheRoot: string;
  manifestUrl: string;
  publisherPublicKey: string;
  channel: string;
  fetcher: typeof fetch;
  timeoutMs: number;
  apiVersion: string;
}): Promise<{ ok: true; assets: ResolvedUiBundleAssets } | { ok: false; reason: string }> {
  try {
    const manifestResponse = await fetchWithDeadline(
      input.fetcher,
      input.manifestUrl,
      { headers: { accept: "application/json" } },
      "UI bundle manifest",
      { deadlineMs: input.timeoutMs }
    );
    if (!manifestResponse.ok) {
      return { ok: false, reason: `UI bundle manifest returned ${manifestResponse.status}` };
    }
    const manifestText = await readBoundedText(
      manifestResponse,
      MAX_UI_MANIFEST_BYTES,
      "UI bundle manifest",
      { deadlineMs: input.timeoutMs }
    );
    const parsed = JSON.parse(manifestText) as unknown;
    const verification = verifyUiBundleManifest(parsed, input.publisherPublicKey);
    if (!verification.ok) return { ok: false, reason: verification.reason };
    const manifest = verification.manifest;
    if (manifest.channel !== input.channel) {
      return { ok: false, reason: `UI bundle channel mismatch: ${manifest.channel}` };
    }
    const compatibility = compatibilityForUiBundle(manifest, input.apiVersion);
    if (compatibility.status !== "compatible") {
      return { ok: false, reason: compatibility.reason ?? "UI bundle is not API-compatible" };
    }

    const root = await cacheRemoteAssets({
      cacheRoot: input.cacheRoot,
      manifestUrl: input.manifestUrl,
      manifest,
      fetcher: input.fetcher,
      timeoutMs: input.timeoutMs
    });
    return {
      ok: true,
      assets: {
        source: "remote",
        root,
        version: manifest.version,
        channel: manifest.channel,
        entrypoint: manifest.entrypoint,
        compatibility,
        manifest
      }
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function cacheRemoteAssets(input: {
  cacheRoot: string;
  manifestUrl: string;
  manifest: UiBundleManifest;
  fetcher: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  const channelRoot = path.join(input.cacheRoot, input.manifest.channel);
  const tempRoot = path.join(channelRoot, `${input.manifest.version}-${crypto.randomUUID()}.tmp`);
  const targetRoot = path.join(channelRoot, input.manifest.version);
  let total = 0;
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });

  try {
    for (const asset of input.manifest.assets) {
      const safePath = safeUiAssetPath(asset.path);
      if (!safePath) throw new Error(`invalid asset path: ${asset.path}`);
      if (asset.size !== undefined) total += asset.size;
      if (total > MAX_UI_BUNDLE_BYTES) throw new Error("UI bundle exceeds maximum size");
      const response = await fetchWithDeadline(
        input.fetcher,
        new URL(safePath, input.manifestUrl),
        { headers: { accept: "*/*" } },
        `UI bundle asset ${safePath}`,
        { deadlineMs: input.timeoutMs }
      );
      if (!response.ok) {
        throw new Error(`UI bundle asset ${safePath} returned ${response.status}`);
      }
      const bytes = await readBoundedBytes(
        response,
        MAX_UI_ASSET_BYTES,
        `UI bundle asset ${safePath}`,
        input.timeoutMs
      );
      total += asset.size === undefined ? bytes.byteLength : 0;
      if (total > MAX_UI_BUNDLE_BYTES) throw new Error("UI bundle exceeds maximum size");
      if (asset.size !== undefined && asset.size !== bytes.byteLength) {
        throw new Error(`asset size mismatch: ${safePath}`);
      }
      if (uiAssetHash(bytes) !== asset.sha256) {
        throw new Error(`asset hash mismatch: ${safePath}`);
      }
      const target = path.join(tempRoot, safePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }

    await fs.writeFile(
      path.join(tempRoot, UI_BUNDLE_MANIFEST_FILENAME),
      `${JSON.stringify(input.manifest, null, 2)}\n`,
      { mode: 0o600 }
    );
    const verification = await verifyUiBundleAssets(tempRoot, input.manifest);
    if (!verification.ok) throw new Error(verification.reason);

    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.rename(tempRoot, targetRoot);
    await fs.writeFile(
      path.join(channelRoot, "last-good.json"),
      `${JSON.stringify({
        schema_version: 1,
        channel: input.manifest.channel,
        version: input.manifest.version,
        updated_at: new Date().toISOString()
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    return targetRoot;
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readCachedLastGood(input: {
  cacheRoot: string;
  publisherPublicKey: string;
  channel: string;
  apiVersion: string;
  fallbackReason?: string;
}): Promise<ResolvedUiBundleAssets | null> {
  const pointerPath = path.join(input.cacheRoot, input.channel, "last-good.json");
  let pointer: z.infer<typeof lastGoodPointerSchema>;
  try {
    pointer = lastGoodPointerSchema.parse(
      JSON.parse(await fs.readFile(pointerPath, "utf8"))
    );
  } catch {
    return null;
  }
  if (pointer.channel !== input.channel) return null;
  const root = path.join(input.cacheRoot, pointer.channel, pointer.version);
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(
      await fs.readFile(path.join(root, UI_BUNDLE_MANIFEST_FILENAME), "utf8")
    );
  } catch {
    return null;
  }
  const verification = verifyUiBundleManifest(manifestJson, input.publisherPublicKey);
  if (!verification.ok) return null;
  const manifest = verification.manifest;
  const compatibility = compatibilityForUiBundle(manifest, input.apiVersion);
  if (compatibility.status !== "compatible") return null;
  const assets = await verifyUiBundleAssets(root, manifest);
  if (!assets.ok) return null;
  return {
    source: "cached",
    root,
    version: manifest.version,
    channel: manifest.channel,
    entrypoint: manifest.entrypoint,
    compatibility,
    fallbackReason: input.fallbackReason,
    manifest
  };
}

function bundledLikeResult(input: {
  source: "bundled" | "fallback" | "dev";
  root: string;
  channel: string;
  version: string;
  apiVersion: string;
  fallbackReason?: string;
}): ResolvedUiBundleAssets {
  return {
    source: input.source,
    root: input.root,
    version: input.version,
    channel: input.channel,
    entrypoint: "index.html",
    fallbackReason: input.fallbackReason,
    compatibility: {
      status: "compatible",
      api_version: input.apiVersion,
      min_api_version: input.apiVersion,
      max_api_version: input.apiVersion
    }
  };
}

async function hasEntrypoint(root: string, entrypoint: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(root, entrypoint));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(current: string, prefix = ""): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relative);
      } else if (entry.isFile()) {
        output.push(relative);
      }
    }
  }
  await walk(root);
  return output.sort((a, b) => a.localeCompare(b));
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  label: string,
  deadlineMs: number
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Fetch refused: ${label} body exceeds ${maxBytes} bytes`);
  }
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(
      await raceWithDeadline(
        response.arrayBuffer(),
        deadlineMs,
        `Fetch refused: ${label} body did not complete within ${deadlineMs}ms`
      )
    );
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Fetch refused: ${label} body exceeds ${maxBytes} bytes`);
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel(`UI bundle read timeout: ${label}`).catch(() => {});
  }, deadlineMs);
  try {
    while (true) {
      const chunk = await reader.read();
      if (timedOut) {
        throw new Error(`Fetch refused: ${label} body did not complete within ${deadlineMs}ms`);
      }
      if (chunk.done) break;
      if (!chunk.value) continue;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Fetch refused: ${label} body exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be cancelled.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function raceWithDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), deadlineMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toBase64Url(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}
