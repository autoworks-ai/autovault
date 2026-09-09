/**
 * Decide how a bundled file's bytes travel through validation, signing, and
 * storage.
 *
 * Skill bundles may legitimately ship binaries — an image, a font, a compiled
 * helper. Reading one as UTF-8 replaces every invalid sequence with U+FFFD, so
 * a PNG's leading 0x89 arrives as EF BF BD and the installed file is no longer
 * an image. Carrying such files as base64 keeps them byte-exact through layers
 * that only ever need to hash or scan them.
 */

export type ResourceEncoding = "base64";

export type EncodedResourceContent = {
  content: string;
  encoding?: ResourceEncoding;
};

/**
 * Represent bytes as text when they are text, and as base64 when they are not.
 *
 * The test is a UTF-8 round trip rather than a magic-byte sniff or an
 * extension allowlist: decode, re-encode, compare. Anything that survives
 * unchanged is genuinely text and keeps travelling as a string, so security
 * scanning, dedup hashing, and capability inference continue to see real text.
 * Anything else would be silently mutated, so it travels as base64.
 *
 * Deterministic and total, which is what lets signing and verification each
 * call it independently and always agree on what was signed.
 */
export function encodeResourceContent(bytes: Buffer): EncodedResourceContent {
  const text = bytes.toString("utf-8");
  if (Buffer.from(text, "utf-8").equals(bytes)) {
    return { content: text };
  }
  return { content: bytes.toString("base64"), encoding: "base64" };
}

/** Recover the original bytes from either representation. */
export function decodeResourceContent(
  content: string,
  encoding?: ResourceEncoding
): Buffer {
  return Buffer.from(content, encoding === "base64" ? "base64" : "utf-8");
}
