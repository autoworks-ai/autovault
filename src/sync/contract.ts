import nacl from "tweetnacl";
import { z } from "zod";
import { bundleHash, sha256 } from "../util/hash.js";
import type { SkillCapabilities } from "../types.js";

const textEncoder = new TextEncoder();
const RELEASE_SIGNATURE_DOMAIN = "autovault-sync-release-v1";

export const syncResourceKindSchema = z.enum(["skill", "agent", "mcp_server", "collection"]);
export const syncUpdatePolicySchema = z.enum(["auto_apply", "user_approve", "admin_hold"]);

export type SyncResourceKind = z.infer<typeof syncResourceKindSchema>;
export type SyncUpdatePolicy = z.infer<typeof syncUpdatePolicySchema>;

export type SyncSigningKeypair = {
  publicKey: string;
  secretKey: string;
};

export type SyncSkillBundle = {
  skill_md: string;
  resources: Array<{ path: string; content: string }>;
};

export const syncReleaseFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export const syncReleaseSignatureSchema = z.object({
  algorithm: z.literal("ed25519"),
  public_key: z.string().min(1),
  signature: z.string().min(1)
});

const capabilityRequirementsSchema = z.object({
  network: z.boolean(),
  filesystem: z.enum(["readonly", "readwrite"]),
  tools: z.array(z.string())
});

export const syncReleaseSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  kind: syncResourceKindSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  channel: z.string().min(1),
  changelog: z.string().default(""),
  publisher: z.string().min(1),
  policy: syncUpdatePolicySchema,
  capabilities: capabilityRequirementsSchema,
  breaking: z.boolean().default(false),
  file_hashes: z.array(syncReleaseFileSchema),
  bundle_hash: z.string().regex(/^[a-f0-9]{64}$/),
  bundle_path: z.string().min(1),
  signature: syncReleaseSignatureSchema
});

export const syncCatalogSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  public_key: z.string().min(1),
  releases: z.array(syncReleaseSchema)
});

export const syncSkillBundleSchema = z.object({
  skill_md: z.string().min(1),
  resources: z.array(z.object({
    path: z.string().min(1),
    content: z.string()
  })).default([])
});

export type SyncRelease = z.infer<typeof syncReleaseSchema>;
export type SyncCatalog = z.infer<typeof syncCatalogSchema>;

export type UnsignedSyncReleaseInput = {
  id: string;
  kind: SyncResourceKind;
  name: string;
  version: string;
  channel: string;
  changelog?: string;
  publisher?: string;
  policy: SyncUpdatePolicy;
  capabilities?: SkillCapabilities;
  breaking?: boolean;
  file_hashes: Array<{ path: string; sha256: string }>;
  bundle_hash: string;
  bundle_path: string;
};

export function createSyncSigningKeypair(): SyncSigningKeypair {
  const pair = nacl.sign.keyPair();
  return {
    publicKey: toBase64Url(pair.publicKey),
    secretKey: toBase64Url(pair.secretKey)
  };
}

export function fileHashesForSkillBundle(bundle: SyncSkillBundle): Array<{
  path: string;
  sha256: string;
}> {
  return [
    { path: "SKILL.md", sha256: sha256(bundle.skill_md) },
    ...bundle.resources
      .map((resource) => ({ path: resource.path, sha256: sha256(resource.content) }))
      .sort((a, b) => a.path.localeCompare(b.path))
  ];
}

export function syncBundleHash(bundle: SyncSkillBundle): string {
  return bundleHash(bundle.skill_md, bundle.resources);
}

export function signSyncRelease(
  input: UnsignedSyncReleaseInput,
  signer: SyncSigningKeypair
): SyncRelease {
  const unsigned = {
    schema_version: 1 as const,
    id: input.id,
    kind: input.kind,
    name: input.name,
    version: input.version,
    channel: input.channel,
    changelog: input.changelog ?? "",
    publisher: input.publisher ?? "AutoVault",
    policy: input.policy,
    capabilities: input.capabilities ?? {
      network: false,
      filesystem: "readonly" as const,
      tools: []
    },
    breaking: input.breaking ?? false,
    file_hashes: input.file_hashes,
    bundle_hash: input.bundle_hash,
    bundle_path: input.bundle_path
  };
  const message = releaseMessage(unsigned);
  const signature = nacl.sign.detached(message, fromBase64Url(signer.secretKey));
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      public_key: signer.publicKey,
      signature: toBase64Url(signature)
    }
  };
}

export function verifySyncRelease(release: SyncRelease, expectedPublicKey?: string): boolean {
  if (expectedPublicKey && release.signature.public_key !== expectedPublicKey) return false;
  const { signature: _signature, ...unsigned } = release;
  try {
    return nacl.sign.detached.verify(
      releaseMessage(unsigned),
      fromBase64Url(release.signature.signature),
      fromBase64Url(release.signature.public_key)
    );
  } catch {
    return false;
  }
}

export function verifySkillBundleAgainstRelease(
  release: SyncRelease,
  bundle: SyncSkillBundle
): { ok: true } | { ok: false; reason: string } {
  const actualBundleHash = syncBundleHash(bundle);
  if (actualBundleHash !== release.bundle_hash) {
    return { ok: false, reason: "bundle hash mismatch" };
  }
  const expected = new Map(release.file_hashes.map((entry) => [entry.path, entry.sha256]));
  for (const file of fileHashesForSkillBundle(bundle)) {
    if (expected.get(file.path) !== file.sha256) {
      return { ok: false, reason: `file hash mismatch: ${file.path}` };
    }
    expected.delete(file.path);
  }
  if (expected.size > 0) {
    return { ok: false, reason: `missing bundle file: ${[...expected.keys()].sort()[0]}` };
  }
  return { ok: true };
}

function releaseMessage(unsignedRelease: Omit<SyncRelease, "signature">): Uint8Array {
  return textEncoder.encode(
    `${RELEASE_SIGNATURE_DOMAIN}\0${stableStringify(unsignedRelease)}`
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

function toBase64Url(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64Url(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}
