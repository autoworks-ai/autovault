import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { installSkill } from "../tools/install-skill.js";
import { readSkill } from "../storage/index.js";
import { compareVersions } from "../util/version-compare.js";
import {
  createSyncSigningKeypair,
  syncCatalogSchema,
  syncSkillBundleSchema,
  verifySkillBundleAgainstRelease,
  verifySyncRelease,
  type SyncCatalog,
  type SyncRelease,
  type SyncSigningKeypair
} from "./contract.js";
import {
  enrollHttpsDevice,
  fetchHttpsBundle,
  fetchHttpsCatalog,
  fetchHttpsDeviceStatus,
  isHttpSyncTarget,
  normalizeHttpsCatalogUrl
} from "./https.js";

const enrollmentMetadataSchema = z.object({
  status: z.enum(["pending", "active", "revoked"]),
  device_id: z.string().min(1),
  device_public_key: z.string().min(1),
  enrolled_at: z.string().min(1),
  revoked_at: z.string().optional(),
  last_check_in_at: z.string().optional()
});

const storedEnrollmentMetadataSchema = enrollmentMetadataSchema.extend({
  device_secret_key: z.string().min(1)
});

const fileUpstreamBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("file"),
  catalog_path: z.string().min(1),
  public_key: z.string().min(1)
});

const httpsUpstreamBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("https"),
  catalog_url: z.string().min(1),
  public_key: z.string().min(1)
});

const enrolledUpstreamSchema = z.discriminatedUnion("type", [
  fileUpstreamBaseSchema.extend({ enrollment: enrollmentMetadataSchema }),
  httpsUpstreamBaseSchema.extend({ enrollment: enrollmentMetadataSchema })
]);

const storedEnrolledUpstreamSchema = z.discriminatedUnion("type", [
  fileUpstreamBaseSchema.extend({ enrollment: storedEnrollmentMetadataSchema }),
  httpsUpstreamBaseSchema.extend({ enrollment: storedEnrollmentMetadataSchema })
]);

const upstreamStateSchema = z.object({
  schema_version: z.literal(1),
  upstreams: z.array(storedEnrolledUpstreamSchema)
});

export type EnrolledUpstream = z.infer<typeof enrolledUpstreamSchema>;
type StoredEnrolledUpstream = z.infer<typeof storedEnrolledUpstreamSchema>;

export type FileUpstreamInput = {
  id: string;
  name: string;
  type: "file";
  catalog_path: string;
  public_key: string;
};

export type HttpsUpstreamInput = {
  id: string;
  name: string;
  type: "https";
  catalog_url: string;
  public_key: string;
};

export type CompleteEnrollmentInput = {
  upstream: FileUpstreamInput | HttpsUpstreamInput;
};

export type SyncUpdateResource = {
  id: string;
  upstream_id: string;
  upstream_name: string;
  kind: SyncRelease["kind"];
  name: string;
  installed_version: string | null;
  available_version: string;
  channel: string;
  changelog: string;
  publisher: string;
  policy: SyncRelease["policy"];
  policy_action: SyncRelease["policy"];
  installable: boolean;
  breaking: boolean;
  capabilities: SyncRelease["capabilities"];
  bundle_hash: string;
  signature: SyncRelease["signature"];
};

export type SyncUpdatesResult = {
  resources: SyncUpdateResource[];
  errors: Array<{ upstream_id: string; error: string }>;
};

export type InstallSyncResourceInput = {
  resource_id: string;
  upstream_id: string;
  accept?: boolean;
};

export type InstallSyncResourceResult = {
  installed: boolean;
  resource_id: string;
  upstream_id: string;
  version: string;
  name: string;
  kind: SyncRelease["kind"];
  verification: {
    manifest: "valid";
    bundle: "valid";
  };
  install: Record<string, unknown>;
};

function syncDir(): string {
  return path.join(loadConfig().storagePath, "cloud-sync");
}

function upstreamStatePath(): string {
  return path.join(syncDir(), "upstreams.json");
}

async function readState(): Promise<z.infer<typeof upstreamStateSchema>> {
  try {
    const raw = await fs.readFile(upstreamStatePath(), "utf-8");
    const parsed = upstreamStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: 1, upstreams: [] };
    }
    throw error;
  }
}

async function writeState(state: z.infer<typeof upstreamStateSchema>): Promise<void> {
  await fs.mkdir(syncDir(), { recursive: true });
  const tmp = `${upstreamStatePath()}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    encoding: "utf-8"
  });
  await fs.rename(tmp, upstreamStatePath());
  await fs.chmod(upstreamStatePath(), 0o600).catch(() => {});
}

export async function initEnrollment(input: CompleteEnrollmentInput): Promise<EnrolledUpstream> {
  return completeEnrollment(input, "pending");
}

export async function completeEnrollment(
  input: CompleteEnrollmentInput,
  status: "pending" | "active" = "active"
): Promise<EnrolledUpstream> {
  if (input.upstream.type === "https") {
    return enrollHttpsUpstream(input.upstream);
  }
  const catalog = await readCatalogFile(input.upstream.catalog_path);
  if (catalog.id !== input.upstream.id) {
    throw new Error(`Upstream id mismatch: catalog has '${catalog.id}'`);
  }
  if (catalog.public_key !== input.upstream.public_key) {
    throw new Error("Upstream public key mismatch");
  }
  const state = await readState();
  const device = createSyncSigningKeypair();
  const upstream: StoredEnrolledUpstream = {
    ...input.upstream,
    name: input.upstream.name || catalog.name,
    catalog_path: path.resolve(input.upstream.catalog_path),
    enrollment: {
      status,
      device_id: `device-${randomUUID()}`,
      device_public_key: device.publicKey,
      device_secret_key: device.secretKey,
      enrolled_at: new Date().toISOString()
    }
  };
  const rest = state.upstreams.filter((entry) => entry.id !== upstream.id);
  await writeState({ schema_version: 1, upstreams: [...rest, upstream] });
  return publicUpstream(upstream);
}

export async function completeEnrollmentFromTarget(
  target: string
): Promise<EnrolledUpstream> {
  if (isHttpSyncTarget(target)) {
    return enrollHttpsFromCatalogUrl(normalizeHttpsCatalogUrl(target));
  }
  const catalogPath = await resolveCatalogPath(target);
  const catalog = await readCatalogFile(catalogPath);
  return completeEnrollment({
    upstream: {
      id: catalog.id,
      name: catalog.name,
      type: "file",
      catalog_path: catalogPath,
      public_key: catalog.public_key
    }
  });
}

export async function refreshEnrollment(upstreamId: string): Promise<EnrolledUpstream> {
  const state = await readState();
  const upstream = state.upstreams.find((entry) => entry.id === upstreamId);
  if (!upstream) throw new Error(`Upstream not enrolled: ${upstreamId}`);
  if (upstream.type === "https") {
    await refreshHttpsEnrollment(upstream);
    await writeState(state);
  }
  return publicUpstream(upstream);
}

export async function listEnrolledUpstreams(): Promise<{ upstreams: EnrolledUpstream[] }> {
  const state = await readState();
  return {
    upstreams: state.upstreams
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((upstream) => publicUpstream(upstream))
  };
}

export async function revokeEnrollment(input: {
  upstream_id: string;
}): Promise<EnrolledUpstream> {
  const state = await readState();
  const index = state.upstreams.findIndex((entry) => entry.id === input.upstream_id);
  if (index === -1) throw new Error(`Upstream not enrolled: ${input.upstream_id}`);
  const upstream = state.upstreams[index];
  const updated: StoredEnrolledUpstream = {
    ...upstream,
    enrollment: {
      ...upstream.enrollment,
      status: "revoked",
      revoked_at: new Date().toISOString()
    }
  };
  state.upstreams[index] = updated;
  await writeState(state);
  return publicUpstream(updated);
}

export async function listSyncUpdates(): Promise<SyncUpdatesResult> {
  const state = await readState();
  const resources: SyncUpdateResource[] = [];
  const errors: SyncUpdatesResult["errors"] = [];

  for (const upstream of state.upstreams) {
    if (upstream.type === "https") {
      try {
        await refreshHttpsEnrollment(upstream);
      } catch (error) {
        errors.push({ upstream_id: upstream.id, error: errorMessage(error) });
        continue;
      }
    }
    if (upstream.enrollment.status === "revoked") {
      errors.push({ upstream_id: upstream.id, error: "Enrollment revoked" });
      continue;
    }
    if (upstream.enrollment.status !== "active") {
      errors.push({ upstream_id: upstream.id, error: `Enrollment ${upstream.enrollment.status}` });
      continue;
    }
    try {
      const catalog = await readCatalog(upstream);
      for (const release of catalog.releases) {
        if (!verifySyncRelease(release, upstream.public_key)) {
          errors.push({ upstream_id: upstream.id, error: `Invalid release signature: ${release.id}` });
          continue;
        }
        const installedVersion = await installedVersionFor(release);
        const comparison = installedVersion ? compareVersions(installedVersion, release.version) : null;
        if (installedVersion && comparison !== null && comparison >= 0) continue;
        if (installedVersion && comparison === null && installedVersion === release.version) continue;
        resources.push(updateResource(upstream, release, installedVersion));
      }
      upstream.enrollment.last_check_in_at = new Date().toISOString();
    } catch (error) {
      errors.push({ upstream_id: upstream.id, error: errorMessage(error) });
    }
  }

  if (state.upstreams.length > 0) await writeState(state);
  resources.sort((a, b) => `${a.upstream_name}:${a.name}`.localeCompare(`${b.upstream_name}:${b.name}`));
  return { resources, errors };
}

export async function installSyncResource(
  input: InstallSyncResourceInput
): Promise<InstallSyncResourceResult> {
  const state = await readState();
  const upstream = state.upstreams.find((entry) => entry.id === input.upstream_id);
  if (!upstream) throw new Error(`Upstream not enrolled: ${input.upstream_id}`);
  if (upstream.type === "https") {
    await refreshHttpsEnrollment(upstream);
    await writeState(state);
  }
  if (upstream.enrollment.status === "revoked") {
    throw new Error(`Enrollment revoked for upstream: ${input.upstream_id}`);
  }
  if (upstream.enrollment.status !== "active") {
    throw new Error(`Enrollment ${upstream.enrollment.status} for upstream: ${input.upstream_id}`);
  }
  const catalog = await readCatalog(upstream);
  const release = catalog.releases.find((entry) => entry.id === input.resource_id);
  if (!release) throw new Error(`Resource not found in upstream: ${input.resource_id}`);
  if (!verifySyncRelease(release, upstream.public_key)) {
    throw new Error(`Invalid release signature: ${release.id}`);
  }
  if (release.policy === "admin_hold") {
    throw new Error(`Resource '${release.id}' is held for administrator review`);
  }
  if (release.policy === "user_approve" && input.accept !== true) {
    throw new Error(`User approval required for resource '${release.id}'`);
  }
  if (release.kind !== "skill") {
    throw new Error(`Resource kind is not installable yet: ${release.kind}`);
  }

  const bundle = await readBundle(upstream, release);
  const verification = verifySkillBundleAgainstRelease(release, bundle);
  if (!verification.ok) throw new Error(verification.reason);
  const install = await installSkill({
    source: "url",
    identifier: `sync:${upstream.id}:${release.id}:${release.version}`,
    version: release.version,
    skill_md: bundle.skill_md,
    resources: bundle.resources,
    expected_name: release.name
  });
  if (install.success !== true) {
    const detail = Array.isArray(install.warnings) && install.warnings.length > 0
      ? install.warnings
      : (install.validation ?? install);
    throw new Error(`Install failed: ${JSON.stringify(detail)}`);
  }
  upstream.enrollment.last_check_in_at = new Date().toISOString();
  await writeState(state);
  return {
    installed: true,
    resource_id: release.id,
    upstream_id: upstream.id,
    version: release.version,
    name: release.name,
    kind: release.kind,
    verification: {
      manifest: "valid",
      bundle: "valid"
    },
    install
  };
}

async function installedVersionFor(release: SyncRelease): Promise<string | null> {
  if (release.kind !== "skill") return null;
  const skill = await readSkill(release.name);
  return skill?.version ?? null;
}

function updateResource(
  upstream: StoredEnrolledUpstream,
  release: SyncRelease,
  installedVersion: string | null
): SyncUpdateResource {
  return {
    id: release.id,
    upstream_id: upstream.id,
    upstream_name: upstream.name,
    kind: release.kind,
    name: release.name,
    installed_version: installedVersion,
    available_version: release.version,
    channel: release.channel,
    changelog: release.changelog,
    publisher: release.publisher,
    policy: release.policy,
    policy_action: release.policy,
    installable: release.policy !== "admin_hold",
    breaking: release.breaking,
    capabilities: release.capabilities,
    bundle_hash: release.bundle_hash,
    signature: release.signature
  };
}

async function enrollHttpsUpstream(input: HttpsUpstreamInput): Promise<EnrolledUpstream> {
  return enrollHttpsFromCatalogUrl(normalizeHttpsCatalogUrl(input.catalog_url), input);
}

async function enrollHttpsFromCatalogUrl(
  catalogUrl: URL,
  expected?: { id?: string; name?: string; public_key?: string }
): Promise<EnrolledUpstream> {
  const device = createSyncSigningKeypair();
  const posted = await enrollHttpsDevice(catalogUrl, device);
  const catalog = await fetchHttpsCatalog(catalogUrl, device);
  if (expected?.id && catalog.id !== expected.id) {
    throw new Error(`Upstream id mismatch: catalog has '${catalog.id}'`);
  }
  if (expected?.public_key && catalog.public_key !== expected.public_key) {
    throw new Error("Upstream public key mismatch");
  }
  const state = await readState();
  const upstream: StoredEnrolledUpstream = {
    id: catalog.id,
    name: expected?.name || catalog.name,
    type: "https",
    catalog_url: catalogUrl.href,
    public_key: catalog.public_key,
    enrollment: {
      status: posted.status,
      device_id: posted.device_id,
      device_public_key: device.publicKey,
      device_secret_key: device.secretKey,
      enrolled_at: new Date().toISOString()
    }
  };
  const rest = state.upstreams.filter((entry) => entry.id !== upstream.id);
  await writeState({ schema_version: 1, upstreams: [...rest, upstream] });
  return publicUpstream(upstream);
}

async function refreshHttpsEnrollment(upstream: StoredEnrolledUpstream): Promise<void> {
  if (upstream.type !== "https") return;
  if (upstream.enrollment.status === "revoked") return;
  const status = await fetchHttpsDeviceStatus(
    new URL(upstream.catalog_url),
    deviceKeypair(upstream)
  );
  upstream.enrollment.status = status.status;
  if (status.device_id) upstream.enrollment.device_id = status.device_id;
  if (status.status === "revoked" && !upstream.enrollment.revoked_at) {
    upstream.enrollment.revoked_at = new Date().toISOString();
  }
  upstream.enrollment.last_check_in_at = new Date().toISOString();
}

function deviceKeypair(upstream: StoredEnrolledUpstream): SyncSigningKeypair {
  return {
    publicKey: upstream.enrollment.device_public_key,
    secretKey: upstream.enrollment.device_secret_key
  };
}

async function readCatalog(upstream: StoredEnrolledUpstream): Promise<SyncCatalog> {
  const catalog = upstream.type === "https"
    ? await fetchHttpsCatalog(new URL(upstream.catalog_url), deviceKeypair(upstream))
    : await readCatalogFile(upstream.catalog_path);
  if (catalog.id !== upstream.id) throw new Error(`Upstream id mismatch: ${catalog.id}`);
  // Beta limitation: rotating the publishing key requires every device to re-enroll.
  if (catalog.public_key !== upstream.public_key) throw new Error("Upstream public key mismatch");
  return catalog;
}

async function readCatalogFile(catalogPath: string): Promise<SyncCatalog> {
  const raw = await fs.readFile(path.resolve(catalogPath), "utf-8");
  const parsedJson = JSON.parse(raw) as unknown;
  const parsed = syncCatalogSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid upstream catalog: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`);
  }
  return parsed.data;
}

async function readBundle(upstream: StoredEnrolledUpstream, release: SyncRelease) {
  if (upstream.type === "https") {
    return fetchHttpsBundle(
      new URL(upstream.catalog_url),
      release.bundle_path,
      release.bundle_hash,
      deviceKeypair(upstream)
    );
  }
  const catalogDir = path.dirname(path.resolve(upstream.catalog_path));
  const bundlePath = path.resolve(catalogDir, release.bundle_path);
  if (bundlePath !== catalogDir && !bundlePath.startsWith(catalogDir + path.sep)) {
    throw new Error(`Bundle path escapes upstream catalog: ${release.bundle_path}`);
  }
  const realCatalogDir = await fs.realpath(catalogDir);
  const realBundlePath = await fs.realpath(bundlePath);
  if (!isPathWithin(realCatalogDir, realBundlePath)) {
    throw new Error(`Bundle path escapes upstream catalog: ${release.bundle_path}`);
  }
  const stat = await fs.stat(realBundlePath);
  if (!stat.isFile()) {
    throw new Error(`Bundle path is not a regular file: ${release.bundle_path}`);
  }
  const raw = await fs.readFile(realBundlePath, "utf-8");
  const parsed = syncSkillBundleSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new Error(`Invalid sync bundle: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`);
  }
  return parsed.data;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function resolveCatalogPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) return path.join(resolved, "catalog.json");
  return resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicUpstream(upstream: StoredEnrolledUpstream): EnrolledUpstream {
  const { device_secret_key: _deviceSecretKey, ...enrollment } = upstream.enrollment;
  return {
    ...upstream,
    enrollment
  };
}
