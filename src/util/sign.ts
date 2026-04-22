import fs from "node:fs/promises";
import path from "node:path";
import nacl from "tweetnacl";
import { loadConfig } from "../config.js";

const KEY_FILE = ".signing-key.json";

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
