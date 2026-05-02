import { describe, expect, it } from "vitest";
import { assertSafeSkillName } from "../src/util/skill-name.js";
import { getSkill } from "../src/tools/get-skill.js";
import { checkUpdates } from "../src/tools/check-updates.js";

describe("assertSafeSkillName", () => {
  it("accepts valid kebab-case names", () => {
    expect(() => assertSafeSkillName("alpha-skill")).not.toThrow();
    expect(() => assertSafeSkillName("alpha_skill_2")).not.toThrow();
    expect(() => assertSafeSkillName("Alpha123")).not.toThrow();
  });

  it("rejects path separators and traversal", () => {
    expect(() => assertSafeSkillName("../escape")).toThrow(/Invalid/);
    expect(() => assertSafeSkillName("foo/bar")).toThrow(/Invalid/);
    expect(() => assertSafeSkillName("foo\\bar")).toThrow(/Invalid/);
    expect(() => assertSafeSkillName("..")).toThrow(/Invalid/);
  });

  it("rejects empty and non-string input", () => {
    expect(() => assertSafeSkillName("")).toThrow(/Invalid/);
    // @ts-expect-error - exercising runtime guard
    expect(() => assertSafeSkillName(null)).toThrow(/Invalid/);
  });
});

describe("tool-boundary name validation", () => {
  it("get_skill rejects unsafe names before any storage access", async () => {
    await expect(getSkill("../etc")).rejects.toThrow(/Invalid/);
    await expect(getSkill("a/b")).rejects.toThrow(/Invalid/);
  });

  it("check_updates rejects unsafe optional skill argument", async () => {
    await expect(checkUpdates("../etc")).rejects.toThrow(/Invalid/);
    await expect(checkUpdates("a/b")).rejects.toThrow(/Invalid/);
  });

  it("check_updates with no argument still succeeds on an empty vault", async () => {
    const result = await checkUpdates();
    expect(result.drifted).toEqual([]);
    expect(result.up_to_date).toEqual([]);
    expect(result.unchecked).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
