import { describe, expect, it } from "vitest";
import { scoreSimilarity } from "../src/validation/dedup.js";

describe("scoreSimilarity", () => {
  it("returns 1 for identical content", () => {
    expect(scoreSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for fully disjoint vocabularies", () => {
    expect(scoreSimilarity("alpha bravo", "charlie delta")).toBe(0);
  });

  it("returns a fraction for partial overlap", () => {
    const score = scoreSimilarity("alpha bravo charlie", "bravo charlie delta");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});
