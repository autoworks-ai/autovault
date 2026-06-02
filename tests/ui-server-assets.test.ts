import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUiBundleSigningKeypair,
  signUiBundleManifest,
  uiAssetHash,
  uiBundleHash,
  type UiBundleManifest,
  type UnsignedUiBundleManifest
} from "../src/ui/bundle.js";
import { startLocalUiServer, type LocalUiServerHandle } from "../src/ui/local-server.js";
import { currentStorageRoot } from "./setup.js";

type FixtureFile = { path: string; content: string };

describe("local UI server asset delivery", () => {
  const handles: LocalUiServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
  });

  it("serves bundled UI assets when remote checks are disabled", async () => {
    const bundledRoot = path.join(currentStorageRoot(), "bundled-ui");
    await writeFiles(bundledRoot, [{ path: "index.html", content: "<main>Bundled UI</main>" }]);

    const handle = await start({
      offline: true,
      bundledRoot
    });

    const html = await (await fetch(`${handle.url}/`)).text();
    expect(html).toContain("Bundled UI");
    await expect(api(handle, "/api/v1/context")).resolves.toMatchObject({
      context: expect.objectContaining({
        ui_delivery: expect.objectContaining({ source: "bundled" }),
        compatibility: expect.objectContaining({ status: "compatible" })
      })
    });
  });

  it("serves cached last-good UI assets when a later CDN check fails", async () => {
    const signer = createUiBundleSigningKeypair();
    const bundledRoot = path.join(currentStorageRoot(), "bundled-ui");
    const cacheRoot = path.join(currentStorageRoot(), "ui-cache");
    await writeFiles(bundledRoot, [{ path: "index.html", content: "<main>Bundled UI</main>" }]);
    const remoteFiles = [
      { path: "index.html", content: "<main>Remote UI</main>" },
      { path: "assets/app.js", content: "console.log('remote')" }
    ];
    const manifest = signUiBundleManifest(unsignedManifest(remoteFiles), signer);

    const first = await start({
      bundledRoot,
      cacheRoot,
      uiBundleManifestUrl: "https://cdn.example.test/autovault/ui/manifest.json",
      publisherPublicKey: signer.publicKey,
      fetcher: fixtureFetcher(manifest, remoteFiles)
    });
    expect(await (await fetch(`${first.url}/`)).text()).toContain("Remote UI");

    const second = await start({
      bundledRoot,
      cacheRoot,
      uiBundleManifestUrl: "https://cdn.example.test/autovault/ui/manifest.json",
      publisherPublicKey: signer.publicKey,
      fetcher: async () => {
        throw new Error("cdn unavailable");
      }
    });
    expect(await (await fetch(`${second.url}/`)).text()).toContain("Remote UI");
    await expect(api(second, "/api/v1/context")).resolves.toMatchObject({
      context: expect.objectContaining({
        ui_delivery: expect.objectContaining({ source: "cached" })
      })
    });
  });

  it("refuses tampered CDN assets and serves bundled UI assets", async () => {
    const signer = createUiBundleSigningKeypair();
    const bundledRoot = path.join(currentStorageRoot(), "bundled-ui");
    await writeFiles(bundledRoot, [{ path: "index.html", content: "<main>Bundled UI</main>" }]);
    const remoteFiles = [
      { path: "index.html", content: "<main>Remote UI</main>" },
      { path: "assets/app.js", content: "console.log('remote')" }
    ];
    const manifest = signUiBundleManifest(unsignedManifest(remoteFiles), signer);

    const handle = await start({
      bundledRoot,
      uiBundleManifestUrl: "https://cdn.example.test/autovault/ui/manifest.json",
      publisherPublicKey: signer.publicKey,
      fetcher: fixtureFetcher(manifest, [
        remoteFiles[0],
        { path: "assets/app.js", content: "console.log('tamper')" }
      ])
    });

    expect(await (await fetch(`${handle.url}/`)).text()).toContain("Bundled UI");
    await expect(api(handle, "/api/v1/context")).resolves.toMatchObject({
      context: expect.objectContaining({
        ui_delivery: expect.objectContaining({
          source: "bundled",
          fallback_reason: expect.stringMatching(/asset hash mismatch: assets\/app\.js/i)
        })
      })
    });
  });

  async function start(
    options: Parameters<typeof startLocalUiServer>[0]
  ): Promise<LocalUiServerHandle> {
    const handle = await startLocalUiServer({
      port: 0,
      open: false,
      timeoutMs: 100,
      ...options
    });
    handles.push(handle);
    return handle;
  }
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

async function api<T = unknown>(
  handle: LocalUiServerHandle,
  pathName: string
): Promise<T> {
  const response = await fetch(`${handle.url}${pathName}`, {
    headers: { authorization: `Bearer ${handle.token}` }
  });
  expect(response.status).toBe(200);
  return await response.json() as T;
}

function fixtureFetcher(
  manifest: UiBundleManifest,
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
