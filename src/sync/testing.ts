import fs from "node:fs/promises";
import path from "node:path";
import {
  createSyncSigningKeypair,
  fileHashesForSkillBundle,
  signSyncRelease,
  syncBundleHash,
  type SyncRelease,
  type SyncSigningKeypair,
  type SyncSkillBundle,
  type SyncUpdatePolicy
} from "./contract.js";
import type { SyncResourceKind } from "./contract.js";
import type { SkillCapabilities } from "../types.js";

export { createSyncSigningKeypair };

export type SignedSkillReleaseForTests = SyncRelease & {
  bundle: SyncSkillBundle;
};

export function createSignedSkillRelease(input: {
  signer: SyncSigningKeypair;
  resource: { id: string; kind: Extract<SyncResourceKind, "skill">; name: string };
  version: string;
  channel: string;
  policy: SyncUpdatePolicy;
  changelog?: string;
  publisher?: string;
  breaking?: boolean;
  capabilities?: SkillCapabilities;
  skillMd: string;
  resources?: Array<{ path: string; content: string }>;
}): SignedSkillReleaseForTests {
  const bundle: SyncSkillBundle = {
    skill_md: input.skillMd,
    resources: input.resources ?? []
  };
  const bundlePath = `bundles/${input.resource.id}-${input.version}.json`;
  return {
    ...signSyncRelease({
      id: input.resource.id,
      kind: input.resource.kind,
      name: input.resource.name,
      version: input.version,
      channel: input.channel,
      changelog: input.changelog,
      publisher: input.publisher,
      policy: input.policy,
      breaking: input.breaking,
      capabilities: input.capabilities,
      file_hashes: fileHashesForSkillBundle(bundle),
      bundle_hash: syncBundleHash(bundle),
      bundle_path: bundlePath
    }, input.signer),
    bundle
  };
}

export async function writeFakeUpstreamCatalog(
  upstreamDir: string,
  input: {
    id: string;
    name: string;
    publicKey: string;
    releases: SignedSkillReleaseForTests[];
  }
): Promise<string> {
  await fs.mkdir(path.join(upstreamDir, "bundles"), { recursive: true });
  const releases: SyncRelease[] = [];
  for (const release of input.releases) {
    const { bundle, ...metadata } = release;
    const bundlePath = path.join(upstreamDir, metadata.bundle_path);
    await fs.mkdir(path.dirname(bundlePath), { recursive: true });
    await fs.writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8");
    releases.push(metadata);
  }
  const catalogPath = path.join(upstreamDir, "catalog.json");
  await fs.writeFile(
    catalogPath,
    `${JSON.stringify({
      schema_version: 1,
      id: input.id,
      name: input.name,
      public_key: input.publicKey,
      releases
    }, null, 2)}\n`,
    "utf-8"
  );
  return catalogPath;
}
