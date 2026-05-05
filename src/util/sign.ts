import fs from "node:fs/promises";
import path from "node:path";
import nacl from "tweetnacl";
import { loadConfig } from "../config.js";

const KEY_FILE = ".signing-key.json";

// Domain-separation prefix for the manifest-bound signing scheme. Bumping the
// suffix (v2 → v3) deliberately invalidates every existing on-disk signature,
// so a future scheme change cannot be confused with this one even if the same
// signing key is reused. Treat this string as part of the protocol.
const MANIFEST_DOMAIN = "autovault-manifest-v2";

type Keypair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

type PersistedKeypair = {
  publicKey: string;
  secretKey: string;
  createdAt: string;
};

let cached: Keypair | null = null;

function keypairPath(): string {
  return path.join(loadConfig().storagePath, KEY_FILE);
}

function fromBase64(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64"));
}

function toBase64(input: Uint8Array): string {
  return Buffer.from(input).toString("base64");
}

async function readKeypair(): Promise<Keypair | null> {
  try {
    const raw = await fs.readFile(keypairPath(), "utf-8");
    const parsed = JSON.parse(raw) as PersistedKeypair;
    return {
      publicKey: fromBase64(parsed.publicKey),
      secretKey: fromBase64(parsed.secretKey)
    };
  } catch {
    return null;
  }
}

async function writeKeypair(pair: Keypair): Promise<void> {
  const target = keypairPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const payload: PersistedKeypair = {
    publicKey: toBase64(pair.publicKey),
    secretKey: toBase64(pair.secretKey),
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(target, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function getSigningKeypair(): Promise<Keypair> {
  if (cached) return cached;
  const existing = await readKeypair();
  if (existing) {
    cached = existing;
    return existing;
  }
  const fresh = nacl.sign.keyPair();
  const pair: Keypair = {
    publicKey: new Uint8Array(fresh.publicKey),
    secretKey: new Uint8Array(fresh.secretKey)
  };
  await writeKeypair(pair);
  cached = pair;
  return pair;
}

export async function signContent(content: string): Promise<string> {
  const { secretKey } = await getSigningKeypair();
  const message = new TextEncoder().encode(content);
  const signature = nacl.sign.detached(message, secretKey);
  return toBase64(signature);
}

export async function verifyContent(content: string, signatureB64: string): Promise<boolean> {
  const { publicKey } = await getSigningKeypair();
  try {
    const message = new TextEncoder().encode(content);
    const signature = fromBase64(signatureB64);
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

export function resetSigningCache(): void {
  cached = null;
}

export type SignedManifest = {
  version: 2;
  skill: string;
  files: Record<string, string>;
};

// Build a domain-separated, length-prefixed payload that binds a signature to
// (skill name, file path, content). Without this binding, signFiles produced
// raw-content signatures — an attacker with FS write access on the storage
// root could lift skill A's bin/setup signature out of A's manifest, plant
// the same bytes into skill B's bin/setup, copy the signature into B's
// manifest, and the CLI exec path would happily verify and run those bytes
// under skill B's identity. Binding the message to (skill, path) turns every
// such lift into a signature mismatch.
//
// Wire format: "autovault-manifest-v2\0" + LP(skill) + LP(path) + LP(content)
// where LP(x) = uint32be(byteLength(x)) + utf8(x). Length prefixes prevent
// component-boundary smuggling (a path that contains the domain prefix, a
// skill name with embedded NULs, content that ends mid-length-field). The
// uint32 length cap of 4 GiB is far above any sane manifest entry; bundle
// limits cap inputs at 1 MiB before this code ever runs.
function buildSignedMessage(skillName: string, filePath: string, content: string): Uint8Array {
  const enc = new TextEncoder();
  const lengthPrefix = (bytes: Uint8Array): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    return Buffer.concat([len, Buffer.from(bytes)]);
  };
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(enc.encode(MANIFEST_DOMAIN)),
      Buffer.from([0]),
      lengthPrefix(enc.encode(skillName)),
      lengthPrefix(enc.encode(filePath)),
      lengthPrefix(enc.encode(content))
    ])
  );
}

export async function signFiles(
  skillName: string,
  files: Record<string, string>
): Promise<SignedManifest> {
  const { secretKey } = await getSigningKeypair();
  // Object.create(null) avoids prototype-key writes (`__proto__`,
  // `constructor`, `prototype`) silently shadowing real entries: on a normal
  // {} those names mutate the prototype chain instead of recording an own
  // property, which would mean `signed["__proto__"] = sig` produces a
  // manifest with no entry for that file. Validation already rejects those
  // segments — this is the second wall.
  const signed: Record<string, string> = Object.create(null);
  for (const [filePath, content] of Object.entries(files)) {
    const message = buildSignedMessage(skillName, filePath, content);
    signed[filePath] = toBase64(nacl.sign.detached(message, secretKey));
  }
  return { version: 2, skill: skillName, files: signed };
}

// Verify a manifest entry against the bound (skill, path, content) message.
// Returns `present: false` when the file is not covered by the manifest OR
// when the manifest's recorded skill name disagrees with the directory the
// caller resolved it from. The latter check catches the "copy A's whole
// .autovault-manifest into B's directory" attack as a hard fail before any
// per-file work runs — without it, A's signatures over (A, ...) would still
// fail to verify under "B" but only after burning a verify per file. The
// `present: true, valid: false` case preserves the distinction CLI callers
// need so they can emit "signature mismatch" instead of "not covered" — the
// former points the user at tampering, the latter at a missing entry.
export async function verifyFile(
  manifest: SignedManifest,
  skillName: string,
  filePath: string,
  content: string
): Promise<{ present: boolean; valid: boolean }> {
  if (manifest.skill !== skillName) return { present: false, valid: false };
  // Object.hasOwn instead of `manifest.files[filePath]` truthiness so a
  // prototype-chain hit (e.g. `filePath === "toString"` on a plain-object
  // manifest constructed by an older code path) cannot return a function
  // reference that bypasses verification.
  if (!Object.hasOwn(manifest.files, filePath)) return { present: false, valid: false };
  const signature = manifest.files[filePath];
  if (typeof signature !== "string" || signature.length === 0) {
    return { present: false, valid: false };
  }
  const { publicKey } = await getSigningKeypair();
  try {
    const message = buildSignedMessage(skillName, filePath, content);
    const valid = nacl.sign.detached.verify(message, fromBase64(signature), publicKey);
    return { present: true, valid };
  } catch {
    return { present: true, valid: false };
  }
}

export function parseManifest(raw: string): SignedManifest | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SignedManifest>;
    // Reject any version other than 2. Pre-domain-separation v1 manifests
    // exist on disk for users who installed before this fix; we deliberately
    // refuse to verify them so the CLI exec path falls through to the
    // "no signed manifest" hard-fail message instead of accepting bytes
    // signed by a scheme that didn't bind skill name + path. Reinstall is
    // the supported migration; v1 carries no security claim under the new
    // threat model.
    if (parsed.version !== 2) return null;
    if (typeof parsed.skill !== "string" || parsed.skill.length === 0) return null;
    if (typeof parsed.files !== "object" || parsed.files === null) return null;
    // Reconstruct the files map on a null-prototype object so an attacker who
    // hand-edited the JSON to include `"__proto__": "<sig>"` cannot inject a
    // prototype property that affects unrelated lookups, and so verifyFile's
    // Object.hasOwn check operates on a clean key set.
    const files: Record<string, string> = Object.create(null);
    for (const name of Object.keys(parsed.files)) {
      if (!Object.hasOwn(parsed.files, name)) continue;
      const value = (parsed.files as Record<string, unknown>)[name];
      if (typeof value === "string") files[name] = value;
    }
    return { version: 2, skill: parsed.skill, files };
  } catch {
    return null;
  }
}
