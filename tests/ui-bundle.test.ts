import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createUiBundleSigningKeypair,
  resolveUiBundleAssets,
  signUiBundleManifest,
  uiAssetHash,
  uiBundleHash,
  verifyUiBundleAssets,
  verifyUiBundleManifest,
  type UnsignedUiBundleManifest
} from "../src/ui/bundle.js";
import { currentStorageRoot } from "./setup.js";

type FixtureFile = { path: string; content: string };

describe("signed UI bundle delivery", () => {
  it("signs UI bundle manifests with a dedicated publisher key and rejects tampering", () => {
    const signer = createUiBundleSigningKeypair();
    const wrongSigner = createUiBundleSigningKeypair();
    const manifest = signUiBundleManifest(unsignedManifest([
      { path: "index.html", content: "<main>AutoVault</main>" },
      { path: "assets/app.js", content: "console.log('verified')" }
    ]), signer);

    expect(verifyUiBundleManifest(manifest, signer.publicKey)).toMatchObject({
      ok: true
    });
    expect(verifyUiBundleManifest(manifest, wrongSigner.publicKey)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/publisher key/i)
    });
    expect(verifyUiBundleManifest({ ...manifest, version: "1.0.1" }, signer.publicKey))
      .toMatchObject({
        ok: false,
        reason: expect.stringMatching(/signature/i)
      });
  });

  it("verifies every cached asset against the signed manifest", async () => {
    const signer = createUiBundleSigningKeypair();
    const files = [
      { path: "index.html", content: "<main>AutoVault</main>" },
      { path: "assets/app.js", content: "console.log('verified')" }
    ];
    const root = path.join(currentStorageRoot(), "verified-ui");
    await writeFiles(root, files);
    const manifest = signUiBundleManifest(unsignedManifest(files), signer);

    await expect(verifyUiBundleAssets(root, manifest)).resolves.toEqual({ ok: true });

    await fs.writeFile(path.join(root, "assets/app.js"), "console.log('tampered')");
    await expect(verifyUiBundleAssets(root, manifest)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/asset hash mismatch: assets\/app\.js/i)
    });
  });

  it("downloads only verified remote bundles and uses cached last-good when the CDN fails", async () => {
    const signer = createUiBundleSigningKeypair();
    const bundledRoot = path.join(currentStorageRoot(), "bundled-ui");
    const cacheRoot = path.join(currentStorageRoot(), "ui-cache");
    await writeFiles(bundledRoot, [{ path: "index.html", content: "<main>Bundled</main>" }]);
    const remoteFiles = [
      { path: "index.html", content: "<main>Remote</main>" },
      { path: "assets/app.js", content: "console.log('remote')" }
    ];
    const manifest = signUiBundleManifest(unsignedManifest(remoteFiles), signer);

    const remote = await resolveUiBundleAssets({
      bundledRoot,
      cacheRoot,
      manifestUrl: "https://cdn.example.test/autovault/ui/manifest.json",
      publisherPublicKey: signer.publicKey,
      fetcher: fixtureFetcher(manifest, remoteFiles),
      timeoutMs: 100
    });

    expect(remote.source).toBe("remote");
    await expect(fs.readFile(path.join(remote.root, "index.html"), "utf8"))
      .resolves.toContain("Remote");

    const cached = await resolveUiBundleAssets({
      bundledRoot,
      cacheRoot,
      manifestUrl: "https://cdn.example.test/autovault/ui/manifest.json",
      publisherPublicKey: signer.publicKey,
      fetcher: async () => {
        throw new Error("network down");
      },
      timeoutMs: 100
    });

    expect(cached.source).toBe("cached");
    expect(cached.version).toBe(remote.version);
    await expect(fs.readFile(path.join(cached.root, "index.html"), "utf8"))
      .resolves.toContain("Remote");
  });

  it("refuses tampered CDN bytes and falls back to bundled assets", async () => {
    const signer = createUiBundleSigningKeypair();
    const bundledRoot = path.join(currentStorageRoot(), "bundled-ui");
    const cacheRoot = path.join(currentStorageRoot(), "ui-cache");
    await writeFiles(bundledRoot, [{ path: "index.html", content: "<main>Bundled</main>" }]);
    const remoteFiles = [
      { path: "index.html", content: "<main>Remote</main>" },
      { path: "assets/app.js", content: "console.log('remote')" }
    ];
    const manifest = signUiBundleManifest(unsignedManifest(remoteFiles), signer);

    const resolved = await resolveUiBundleAssets({
      bundledRoot,
      cacheRoot,
      manifestUrl: "https://cdn.example.test/autovault/ui/manifest.json",
      publisherPublicKey: signer.publicKey,
      fetcher: fixtureFetcher(manifest, [
        remoteFiles[0],
        { path: "assets/app.js", content: "console.log('tamper')" }
      ]),
      timeoutMs: 100
    });

    expect(resolved).toMatchObject({
      source: "bundled",
      fallbackReason: expect.stringMatching(/asset hash mismatch: assets\/app\.js/i)
    });
    await expect(fs.readFile(path.join(resolved.root, "index.html"), "utf8"))
      .resolves.toContain("Bundled");
    await expect(fs.access(path.join(cacheRoot, "stable", "last-good.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

function unsignedManifest(files: FixtureFile[]): UnsignedUiBundleManifest {
  const assets = files.map((file) => ({
    path: file.path,
    sha256: uiAssetHash(file.content),
    size: Buffer.byteLength(file.content)
  }));
  return {
    schema_version: 1,
    version: "1.0.0",
    channel: "stable",
    entrypoint: "index.html",
    assets,
    bundle_hash: uiBundleHash(assets),
    min_api_version: "1.0.0",
    max_api_version: "1.99.0",
    created_at: "2026-06-02T00:00:00.000Z"
  };
}

async function writeFiles(root: string, files: FixtureFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
}

function fixtureFetcher(
  manifest: unknown,
  files: FixtureFile[]
): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/manifest.json")) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const file = files.find((entry) => url.endsWith(`/${entry.path}`));
    if (!file) return new Response("missing", { status: 404 });
    return new Response(file.content, { status: 200 });
  };
}
