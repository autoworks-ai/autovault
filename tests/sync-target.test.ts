import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CLOUD_ORIGIN, resolveLinkTarget } from "../src/sync/target.js";

describe("resolveLinkTarget", () => {
  afterEach(() => {
    delete process.env.AUTOVAULT_CLOUD_ORIGIN;
  });

  it("expands a Cloud slug to catalog.json under autovault.dev/v/<slug>", () => {
    expect(resolveLinkTarget("acme")).toEqual({
      kind: "https",
      catalogUrl: `${DEFAULT_CLOUD_ORIGIN}/v/acme/catalog.json`,
      slug: "acme",
    });
  });

  it("honors AUTOVAULT_CLOUD_ORIGIN for slug expansion", () => {
    process.env.AUTOVAULT_CLOUD_ORIGIN = "http://127.0.0.1:9999";
    expect(resolveLinkTarget("acme")).toEqual({
      kind: "https",
      catalogUrl: "http://127.0.0.1:9999/v/acme/catalog.json",
      slug: "acme",
    });
  });

  it("normalizes an explicit catalog URL", () => {
    expect(resolveLinkTarget("https://autovault.dev/v/acme")).toEqual({
      kind: "https",
      catalogUrl: "https://autovault.dev/v/acme/catalog.json",
    });
  });

  it("extracts a Cloud slug from a catalog URL", async () => {
    const { slugFromCatalogUrl } = await import("../src/sync/target.js");
    expect(
      slugFromCatalogUrl(
        "https://autovault.dev/v/johngarturo-6ff992/catalog.json",
      ),
    ).toBe("johngarturo-6ff992");
  });

  it("builds a GitHub-style complete admit URL from the device fingerprint", async () => {
    const { cloudAdmitUrl, deviceFingerprint } = await import(
      "../src/sync/target.js"
    );
    const fingerprint = deviceFingerprint(
      "DdiEpLBSOYMhWReWNz7t7Oh0BAgq6X0h2yb-wL4NJLw",
    );
    expect(fingerprint).toBe("DdiE…NJLw");
    expect(cloudAdmitUrl(fingerprint)).toBe(
      `${DEFAULT_CLOUD_ORIGIN}/cloud?admit=${encodeURIComponent("DdiE…NJLw")}`,
    );
    expect(cloudAdmitUrl(fingerprint)).toContain("%E2%80%A6");
    expect(cloudAdmitUrl()).toBe(`${DEFAULT_CLOUD_ORIGIN}/cloud`);
    expect(
      cloudAdmitUrl(
        fingerprint,
        "https://vault.example/v/acme/catalog.json",
      ),
    ).toBe(
      `https://vault.example/cloud?admit=${encodeURIComponent("DdiE…NJLw")}`,
    );
  });

  it("treats relative paths as file catalogs", () => {
    expect(resolveLinkTarget("./upstream")).toEqual({
      kind: "file",
      path: "./upstream",
    });
  });

  it("rejects uppercase slugs with a lowercase hint", () => {
    expect(() => resolveLinkTarget("Acme")).toThrow(/lowercase \(try 'acme'\)/);
  });
});
