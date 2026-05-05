import { describe, expect, it, vi } from "vitest";
import {
  MAX_RESOURCES,
  MAX_RESOURCE_BYTES,
  MAX_TOTAL_BYTES,
  checkBundleLimits
} from "../src/util/limits.js";

describe("checkBundleLimits", () => {
  it("returns no errors for a small in-cap bundle", () => {
    const errors = checkBundleLimits("# tiny", [
      { path: "a.txt", content: "a" },
      { path: "b.txt", content: "b" }
    ]);
    expect(errors).toEqual([]);
  });

  it("flags an oversize SKILL.md but still scans the rest of the bundle", () => {
    // Co-existence of SKILL.md error + per-resource error is required so
    // legitimate edits get one round of complete diagnostics, not a
    // first-error-wins drip feed.
    const oversizeMd = "x".repeat(257 * 1024);
    const errors = checkBundleLimits(oversizeMd, [
      { path: "ok.txt", content: "ok" }
    ]);
    expect(errors.some((e) => /SKILL\.md is \d+ bytes/.test(e))).toBe(true);
  });

  it("flags an oversize per-resource entry without aborting", () => {
    const big = "x".repeat(MAX_RESOURCE_BYTES + 1);
    const errors = checkBundleLimits("# md", [
      { path: "ok.txt", content: "ok" },
      { path: "huge.bin", content: big }
    ]);
    expect(
      errors.some((e) => /Resource 'huge\.bin' is \d+ bytes/.test(e))
    ).toBe(true);
  });

  it("short-circuits on cardinality before scanning resource bytes (round-50)", () => {
    // Round-50 fix: a hostile or buggy caller shipping MAX_RESOURCES + N
    // entries used to force Buffer.byteLength on every element before the
    // count cap fired — a free O(N) DoS lever for any caller that could get
    // past the inline-resources entry guard. After the fix, the count error
    // is reported and the per-resource loop never runs.
    //
    // Spy on Buffer.byteLength to assert the loop short-circuits: SKILL.md is
    // measured once (one call), and zero per-resource calls follow because
    // the function returns before the loop.
    const spy = vi.spyOn(Buffer, "byteLength");
    try {
      const resources = Array.from({ length: MAX_RESOURCES + 5 }, (_, i) => ({
        path: `r${i}.txt`,
        content: "a"
      }));
      const errors = checkBundleLimits("# md", resources);
      expect(errors).toEqual([
        `Too many resources: ${MAX_RESOURCES + 5} > ${MAX_RESOURCES}`
      ]);
      // Exactly one byteLength call: the SKILL.md measurement above the
      // cardinality gate. No per-resource sizing happened.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("short-circuits the byte loop once cumulative bytes exceed the total cap (round-50)", () => {
    // Cumulative cap trip should also abort the loop so a caller cannot pad
    // their oversize bundle with thousands of trailing tiny entries to force
    // O(N) sizing work after the cap is already exceeded.
    const halfCap = Math.floor(MAX_TOTAL_BYTES / 2) + 1;
    const big = "x".repeat(halfCap);
    const tail = Array.from({ length: 20 }, (_, i) => ({
      path: `tail${i}.txt`,
      content: "z"
    }));
    const resources = [
      { path: "big-a.bin", content: big },
      { path: "big-b.bin", content: big },
      ...tail
    ];

    const spy = vi.spyOn(Buffer, "byteLength");
    try {
      const errors = checkBundleLimits("# md", resources);
      expect(errors.some((e) => /Bundle total bytes \d+ >/.test(e))).toBe(true);
      // 1 (SKILL.md) + 2 (the two big resources that trip the cap) =
      // 3 calls. The 20 trailing entries must not be measured.
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});
