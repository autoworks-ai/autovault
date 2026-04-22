import { describe, expect, it } from "vitest";
import { classifyDedup, scoreSimilarity } from "../src/validation/dedup.js";

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

describe("classifyDedup", () => {
  it("returns exact when content hash matches", () => {
    const result = classifyDedup(
      "hash-abc",
      "totally different words",
      [{ name: "prior", contentHash: "hash-abc", content: "does not even matter" }]
    );
    expect(result).toEqual({ tier: "exact", similarity: 1, existingName: "prior" });
  });

  it("returns near_exact on high similarity without hash match", () => {
    const words20 = "a b c d e f g h i j k l m n o p q r s t".split(" ");
    const content = words20.join(" ");
    const existing = [
      {
        name: "nearly-the-same",
        contentHash: "other-hash",
        content: [...words20.slice(0, 19), "u"].join(" ")
      }
    ];
    const result = classifyDedup("new-hash", content, existing);
    expect(result.tier).toBe("near_exact");
    expect(result.existingName).toBe("nearly-the-same");
    expect(result.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it("returns functional on medium similarity", () => {
    const content = "a b c d e f g h i j k";
    const existing = [
      {
        name: "some-overlap",
        contentHash: "other-hash",
        content: "a b c d e f g h i j m"
      }
    ];
    const result = classifyDedup("new-hash", content, existing);
    expect(result.tier).toBe("functional");
    expect(result.existingName).toBe("some-overlap");
    expect(result.similarity).toBeGreaterThanOrEqual(0.75);
    expect(result.similarity).toBeLessThan(0.9);
  });

  it("returns novel when nothing is close", () => {
    const result = classifyDedup("new-hash", "completely unique content phrase here", [
      { name: "other", contentHash: "x", content: "totally different words and ideas" }
    ]);
    expect(result.tier).toBe("novel");
  });

  it("returns novel against empty corpus", () => {
    const result = classifyDedup("new-hash", "anything", []);
    expect(result.tier).toBe("novel");
    expect(result.existingName).toBeUndefined();
  });
});
