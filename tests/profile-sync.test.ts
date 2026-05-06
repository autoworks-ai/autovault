import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { syncProfiles } from "../src/profiles/sync.js";
import { ensureStorage, writeSkill } from "../src/storage/index.js";
import { withProfileSyncLock, withStorageLock } from "../src/storage/lock.js";
import { currentStorageRoot } from "./setup.js";

const skill = (name: string, agents?: string[]): string => `---
name: ${name}
description: ${name} test skill with enough description text.
${agents ? `agents: [${agents.join(", ")}]\n` : ""}metadata:
  version: "1.0.0"
---

# ${name}
`;

describe("profile sync", () => {
  it("generates per-agent symlinks and preserves unrelated external skills", async () => {
    await ensureStorage();
    await writeSkill("shared-skill", skill("shared-skill", ["claude-code", "codex"]));
    await writeSkill("claude-only", skill("claude-only", ["claude-code"]));
    await writeSkill("hidden-skill", skill("hidden-skill"));

    const externalRoot = path.join(currentStorageRoot(), "external-claude-skills");
    await fs.mkdir(path.join(externalRoot, "system-skill"), { recursive: true });

    const result = await syncProfiles({
      profileRoots: {
        "claude-code": externalRoot
      }
    });

    expect(result.profiles["claude-code"]).toEqual(["claude-only", "shared-skill"]);
    expect(result.profiles.codex).toEqual(["shared-skill"]);
    expect(result.warnings.join("\n")).toContain("hidden-skill");

    const profileLink = await fs.readlink(path.join(currentStorageRoot(), "profiles", "claude-code", "shared-skill"));
    expect(path.basename(profileLink)).toBe("shared-skill");

    const externalLink = await fs.readlink(path.join(externalRoot, "shared-skill"));
    expect(externalLink).toContain(path.join("profiles", "claude-code", "shared-skill"));

    await fs.symlink(
      path.join(currentStorageRoot(), "profiles", "claude-code", "stale-skill"),
      path.join(externalRoot, "stale-skill")
    );
    await syncProfiles({
      profileRoots: {
        "claude-code": externalRoot
      }
    });
    await expect(fs.lstat(path.join(externalRoot, "stale-skill"))).rejects.toThrow();

    await expect(fs.stat(path.join(externalRoot, "system-skill"))).resolves.toBeTruthy();
  });

  it("uses configured profile roots and lets CLI roots override them", async () => {
    await ensureStorage();
    await writeSkill("configured-skill", skill("configured-skill", ["claude-code"]));

    const configuredRoot = path.join(currentStorageRoot(), "configured-claude-skills");
    const overrideRoot = path.join(currentStorageRoot(), "override-claude-skills");
    process.env.AUTOVAULT_PROFILE_LINKS = `claude-code=${configuredRoot}`;
    resetConfigCache();

    const configured = await syncProfiles();
    expect(configured.linkedRoots["claude-code"]).toBe(configuredRoot);
    await expect(fs.readlink(path.join(configuredRoot, "configured-skill"))).resolves.toContain(
      path.join("profiles", "claude-code", "configured-skill")
    );

    const override = await syncProfiles({
      profileRoots: {
        "claude-code": overrideRoot
      }
    });
    expect(override.linkedRoots["claude-code"]).toBe(overrideRoot);
    await expect(fs.readlink(path.join(overrideRoot, "configured-skill"))).resolves.toContain(
      path.join("profiles", "claude-code", "configured-skill")
    );
  });

  it("refuses to overwrite non-symlink external skill conflicts", async () => {
    await ensureStorage();
    await writeSkill("conflict", skill("conflict", ["claude-code"]));

    const externalRoot = path.join(currentStorageRoot(), "external-conflict");
    await fs.mkdir(path.join(externalRoot, "conflict"), { recursive: true });

    await expect(syncProfiles({ profileRoots: { "claude-code": externalRoot } })).rejects.toThrow(
      /Refusing to replace non-symlink path/
    );
  });

  // Round-41 finding: profile sync used to blindly replace any external symlink
  // whose target differed from AutoVault's expected target — including a
  // user-managed symlink pointing somewhere outside AutoVault entirely.
  // Installing a skill named "claude-only" could silently nuke a manually
  // installed native skill of the same name. The fix narrows replacement to
  // symlinks already pointing under AutoVault's managed prefix; everything
  // else is left alone with a warning.
  it("preserves a user-managed external symlink that points outside AutoVault (round-41)", async () => {
    await ensureStorage();
    await writeSkill("conflict-skill", skill("conflict-skill", ["claude-code"]));

    const externalRoot = path.join(currentStorageRoot(), "external-user-managed");
    await fs.mkdir(externalRoot, { recursive: true });

    // The user has a manually installed native skill at this name, pointing
    // outside AutoVault entirely.
    const userManagedTarget = path.join(currentStorageRoot(), "user-skill-source");
    await fs.mkdir(userManagedTarget, { recursive: true });
    const userLink = path.join(externalRoot, "conflict-skill");
    await fs.symlink(userManagedTarget, userLink, "dir");

    const result = await syncProfiles({
      profileRoots: { "claude-code": externalRoot }
    });

    // The user's symlink must still point at their own target, untouched.
    const after = await fs.readlink(userLink);
    expect(path.resolve(externalRoot, after)).toBe(userManagedTarget);
    // And the warning must name the conflict so the user can investigate.
    expect(
      result.warnings.some(
        (w) => w.includes("user-managed symlink") && w.includes("conflict-skill")
      )
    ).toBe(true);
  });

  // Round-47 finding: writeSkill renames liveDir → <name>.bak.<ts>.<rand>
  // before renaming the staged tmp into liveDir. During that gap, an unlocked
  // syncProfiles would call listInstalledSkillNames (which filters dotted
  // siblings), see an empty keep-set for the in-flight skill's agent, and
  // removeManagedLinks would unlink that skill's profile symlink. The fix is
  // to take the storage lock for the entire syncProfiles body so it can never
  // observe a mid-rename state. This test proves it: with the lock held by a
  // separate writer, a concurrent syncProfiles must queue (not return) until
  // the holder releases, and the existing profile link must survive.
  it("blocks on the storage lock while a writer holds it (round-47)", async () => {
    await ensureStorage();
    await writeSkill("locked-skill", skill("locked-skill", ["claude-code"]));
    // Initial sync materializes the profile symlink.
    await syncProfiles();
    const linkPath = path.join(currentStorageRoot(), "profiles", "claude-code", "locked-skill");
    await expect(fs.lstat(linkPath)).resolves.toBeTruthy();

    // Hold the storage lock from a separate invocation. While we hold it,
    // syncProfiles must NOT make progress — listInstalledSkillNames + the
    // removeManagedLinks call inside it must wait for the lock. We must NOT
    // await syncP inside the holder body, or both ends deadlock waiting on
    // each other; capture syncP, exit the holder to release, then await.
    let syncDone = false;
    let holderReleasedAt: number | null = null;
    let syncFinishedAt: number | null = null;
    let syncPromise: Promise<Awaited<ReturnType<typeof syncProfiles>>> | null = null;

    await withStorageLock(async () => {
      syncPromise = syncProfiles().then((r) => {
        syncDone = true;
        syncFinishedAt = Date.now();
        return r;
      });
      // Give it time to enter — if the lock isn't taken, sync would race in
      // and finish before this delay elapses.
      await new Promise((resolve) => setTimeout(resolve, 150));
      // At this point sync MUST still be queued.
      expect(syncDone).toBe(false);
      // The profile link must still exist — sync hasn't run, so it can't
      // have mis-pruned anything either.
      await expect(fs.lstat(linkPath)).resolves.toBeTruthy();
      holderReleasedAt = Date.now();
      // Returning here releases the lock; sync can now proceed.
    });

    const syncResult = await (syncPromise as unknown as Promise<Awaited<ReturnType<typeof syncProfiles>>>);
    expect(syncDone).toBe(true);
    // Sync must have finished AFTER we released the holder, not before.
    expect(syncFinishedAt).not.toBeNull();
    expect(holderReleasedAt).not.toBeNull();
    expect((syncFinishedAt as number) >= (holderReleasedAt as number)).toBe(true);
    // The skill's profile link survived the contention round-trip.
    expect(syncResult.profiles["claude-code"]).toContain("locked-skill");
    await expect(fs.lstat(linkPath)).resolves.toBeTruthy();
  });

  // Round-48 finding: round-47 over-scoped the lock, holding it through the
  // entire syncProfiles body — including external-profile-root work that can
  // be slow on flaky mounts. With the 10s lock ceiling, an unrelated install
  // could fail while sync was still cleaning up symlinks. The fix narrows the
  // lock to the snapshot phase (listInstalledSkillNames + readSkill loop) and
  // releases it before touching external roots. This test proves the apply
  // phase runs WITHOUT the storage lock: we slow down apply-phase unlink()s
  // on the external root, kick off sync, then concurrently acquire the
  // storage lock and assert the acquire returns long before sync finishes.
  it("releases the storage lock before external-profile-root work (round-48)", async () => {
    await ensureStorage();
    await writeSkill("scoped-skill", skill("scoped-skill", ["claude-code"]));

    const externalRoot = path.join(currentStorageRoot(), "external-scoped");
    const managedPrefix = path.resolve(currentStorageRoot(), "profiles", "claude-code");
    await fs.mkdir(managedPrefix, { recursive: true });
    await fs.mkdir(externalRoot, { recursive: true });
    // Pre-populate with stale symlinks pointing under the managed prefix so
    // removeManagedLinks considers them managed and unlinks each.
    for (let i = 0; i < 5; i++) {
      await fs.symlink(
        path.join(managedPrefix, `stale-${i}`),
        path.join(externalRoot, `stale-${i}`)
      );
    }

    // Slow each apply-phase unlink that targets externalRoot by 200ms.
    // Five entries ≈ 1s of apply work — long enough to race a lock acquire.
    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target: any) => {
      if (typeof target === "string" && target.startsWith(externalRoot + path.sep)) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return realUnlink(target);
    });

    try {
      let syncFinishedAt: number | null = null;
      const syncStart = Date.now();
      const syncP = syncProfiles({ profileRoots: { "claude-code": externalRoot } }).then((r) => {
        syncFinishedAt = Date.now();
        return r;
      });

      // Give sync time to enter, run snapshot phase under the lock, release,
      // and start the apply phase. 80ms is well past snapshot completion on
      // tmpfs (sub-millisecond) and well before the first 200ms unlink lands.
      await new Promise((r) => setTimeout(r, 80));

      const acquireStart = Date.now();
      await withStorageLock(async () => {
        // noop — proves the lock is free during apply phase
      });
      const acquireDuration = Date.now() - acquireStart;

      const syncResult = await syncP;
      const syncDuration = (syncFinishedAt as number) - syncStart;

      // Apply phase took ~1s of artificial latency. With round-47 end-to-end
      // scoping the acquire would have queued for that full duration; with
      // round-48 narrow scoping it returns immediately. Bound at 250ms to
      // give CI breathing room while still failing if the lock is held end-
      // to-end (which would push acquire past ~800ms).
      expect(acquireDuration).toBeLessThan(250);
      expect(syncDuration).toBeGreaterThan(800);
      expect(syncResult.profiles["claude-code"]).toContain("scoped-skill");
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  // Round-49 finding: the `autovault sync-profiles` CLI path (and any sync
  // launched after a crashed writer) didn't run crash recovery before
  // snapshot. If writeSkill crashed between liveDir→bak and tmp→live, the
  // skill dir is at `<name>.bak.<ts>.<rand>` with no live counterpart.
  // listInstalledSkillNames filters dotted siblings, so an unrecovered sync
  // would build an empty keep-set, and removeManagedLinks would unlink the
  // skill's managed profile symlinks — even though the bak is still
  // recoverable. The fix calls recoverOrphanBackups at the head of
  // syncProfiles so every entry point sees the rolled-forward state.
  it("rolls forward an orphan .bak before pruning managed profile links (round-49)", async () => {
    await ensureStorage();
    await writeSkill("crashy-skill", skill("crashy-skill", ["claude-code"]));
    // First sync materializes the managed profile symlink.
    await syncProfiles();
    const linkPath = path.join(currentStorageRoot(), "profiles", "claude-code", "crashy-skill");
    await expect(fs.lstat(linkPath)).resolves.toBeTruthy();

    // Simulate a crashed writer mid-rename: rename liveDir → .bak.<ts>.<rand>
    // with no tmp-to-live rename ever firing.
    const liveDir = path.join(currentStorageRoot(), "skills", "crashy-skill");
    const bakDir = path.join(currentStorageRoot(), "skills", `crashy-skill.bak.${Date.now()}.abc123`);
    await fs.rename(liveDir, bakDir);
    await expect(fs.lstat(liveDir)).rejects.toThrow();
    await expect(fs.lstat(bakDir)).resolves.toBeTruthy();

    // Run the CLI-equivalent sync. Without recovery at the head of syncProfiles,
    // listInstalledSkillNames would return [] for "crashy-skill", and the
    // existing managed symlink would be unlinked. With the round-49 fix,
    // recoverOrphanBackups rolls the bak back to live before the snapshot,
    // so the skill is observed and the symlink survives.
    const result = await syncProfiles();

    // The bak got rolled forward.
    await expect(fs.lstat(liveDir)).resolves.toBeTruthy();
    await expect(fs.lstat(bakDir)).rejects.toThrow();
    // The managed profile symlink survived.
    await expect(fs.lstat(linkPath)).resolves.toBeTruthy();
    expect(result.profiles["claude-code"]).toContain("crashy-skill");
  });

  it("refuses to mkdir/symlink for traversal agent names from frontmatter", async () => {
    // Round 20 critical: skill frontmatter `agents` flowed into
    // path.join(profileRoot, agent) without sanitization. A skill declaring
    // agents: ["../../.ssh"] turned install into an arbitrary symlink primitive
    // outside $AUTOVAULT_STORAGE_PATH/profiles. The schema regex closes that
    // gate at install/propose time; this test exercises the defense-in-depth
    // check inside syncProfiles by writing the skill directly (bypassing the
    // schema, which is what a tampered on-disk SKILL.md would do anyway).
    await ensureStorage();
    // writeSkill takes the SKILL.md verbatim — no schema gate. Use it to
    // simulate a hostile already-on-disk skill.
    await writeSkill(
      "evil-agent",
      `---
name: evil-agent
description: A description that is intentionally long enough to satisfy schema length checks.
agents:
  - "../../.ssh"
metadata:
  version: "1.0.0"
---

# Body
`
    );

    const result = await syncProfiles();
    const traversalTarget = path.resolve(currentStorageRoot(), "..", ".ssh");
    expect(result.warnings.some((w) => w.includes("../../.ssh"))).toBe(true);
    // Crucial: no directory ever materialized at the traversal location.
    await expect(fs.lstat(traversalTarget)).rejects.toThrow();
    // And the synced profiles map must not contain the unsafe key.
    expect(Object.keys(result.profiles)).not.toContain("../../.ssh");
  });

  // Round-50 finding A: round-48 narrowed the storage lock to the snapshot
  // phase only, leaving the prune+apply phase un-serialized across concurrent
  // syncs. Two overlapping post-install syncs could each compute a keep-set,
  // race their applies, and have an older sync's stale keep-set unlink a
  // managed symlink that a newer sync had just placed. Fix is a dedicated
  // profile-sync lock that wraps the entire syncProfiles body (recovery +
  // snapshot + apply); writeSkill remains free to take the storage lock
  // independently. This test holds the profile-sync lock externally and
  // asserts syncProfiles blocks until release — the cheap, reliable way to
  // pin the lock acquisition behavior.
  it("blocks on the profile-sync lock while another holder runs (round-50)", async () => {
    await ensureStorage();
    await writeSkill("p50-skill", skill("p50-skill", ["claude-code"]));

    let syncDone = false;
    let holderReleasedAt: number | null = null;
    let syncFinishedAt: number | null = null;
    let syncPromise: Promise<Awaited<ReturnType<typeof syncProfiles>>> | null = null;

    await withProfileSyncLock(async () => {
      syncPromise = syncProfiles().then((r) => {
        syncDone = true;
        syncFinishedAt = Date.now();
        return r;
      });
      // Same pattern as the round-47 storage-lock test: capture syncP, give
      // it time to enter, exit holder to release, then await outside.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(syncDone).toBe(false);
      holderReleasedAt = Date.now();
    });

    const syncResult = await (syncPromise as unknown as Promise<Awaited<ReturnType<typeof syncProfiles>>>);
    expect(syncDone).toBe(true);
    expect(syncFinishedAt).not.toBeNull();
    expect(holderReleasedAt).not.toBeNull();
    expect((syncFinishedAt as number) >= (holderReleasedAt as number)).toBe(true);
    expect(syncResult.profiles["claude-code"]).toContain("p50-skill");
  });

  // Concrete race regression: stage the exact interleave described in the
  // codex round-50 finding. Sync A snapshots {skill-1}, then pauses INSIDE
  // its apply phase (we inject latency on the existingDirectoryNames readdir
  // that runs at apply entry). While A is paused, we install skill-2 and run
  // sync B. With the round-50 lock, B blocks on the profile-sync lock until
  // A finishes; B then snapshots {skill-1, skill-2} and creates both links.
  // Without the lock, B would race past A, both syncs would interleave, and
  // A's stale keep-set would unlink skill-2's freshly placed symlink — the
  // bug we're guarding against.
  it("does not let an older sync's stale keep-set prune a newer sync's symlink (round-50)", async () => {
    await ensureStorage();
    await writeSkill("p50a", skill("p50a", ["claude-code"]));

    const profileRoot = path.join(currentStorageRoot(), "profiles");
    let releaseA: () => void = () => {};
    const aPaused = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aEntered = false;
    let aEnteredResolve: () => void = () => {};
    const aEnteredP = new Promise<void>((resolve) => {
      aEnteredResolve = resolve;
    });

    const realReaddir = fs.readdir.bind(fs);
    const readdirSpy = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (target: any, options?: any) => {
        // Block ONLY the first existingDirectoryNames call on profileRoot.
        // existingDirectoryNames passes { withFileTypes: true }; that's how
        // we differentiate from incidental readdir calls during ensureStorage
        // / setup paths. Subsequent profileRoot readdirs (sync B) proceed
        // normally so B's apply is not held up by the spy itself — the lock
        // is what should hold B.
        if (
          typeof target === "string" &&
          target === profileRoot &&
          options &&
          options.withFileTypes === true &&
          !aEntered
        ) {
          aEntered = true;
          aEnteredResolve();
          await aPaused;
        }
        return realReaddir(target, options);
      });

    try {
      // Sync A: completes its snapshot under the storage lock, releases, then
      // pauses at the apply-phase readdir. We hold it there.
      const syncAP = syncProfiles();

      // Wait for A to enter the spied readdir. This guarantees A has already
      // taken the profile-sync lock and is mid-apply.
      await aEnteredP;

      // While A is paused, install skill-2 and start sync B. With the fix, B
      // must block on the profile-sync lock until A releases. Without the
      // fix, B would proceed and race A.
      await writeSkill("p50b", skill("p50b", ["claude-code"]));
      let syncBStartedAt = Date.now();
      let syncBEnteredApply = false;
      const syncBP = syncProfiles().then((r) => {
        syncBEnteredApply = true;
        return r;
      });

      // Give B a generous window to (mistakenly) make progress if the lock
      // is missing. The pre-fix race would let B's full sync complete in
      // milliseconds because B's apply does not call the spied readdir on
      // profileRoot a second time during the spy-active window (aEntered
      // gate is sticky).
      await new Promise((r) => setTimeout(r, 200));
      expect(syncBEnteredApply).toBe(false);

      // Release A. A's apply finishes, then B acquires the lock and runs.
      releaseA();
      const aResult = await syncAP;
      const bResult = await syncBP;

      // Both skills must be present in B's final keep — B saw the post-A
      // state when it snapshotted.
      expect(aResult.profiles["claude-code"]).toEqual(["p50a"]);
      expect(bResult.profiles["claude-code"]).toEqual(["p50a", "p50b"]);

      // Final on-disk state: BOTH managed symlinks present. The round-50
      // bug would have left p50b unlinked (A's stale keep-set pruning it
      // after B placed it).
      await expect(
        fs.lstat(path.join(profileRoot, "claude-code", "p50a"))
      ).resolves.toBeTruthy();
      await expect(
        fs.lstat(path.join(profileRoot, "claude-code", "p50b"))
      ).resolves.toBeTruthy();

      // syncBStartedAt is intentionally read once for clarity; not asserted
      // beyond the syncBEnteredApply false-then-true ordering above.
      void syncBStartedAt;
    } finally {
      readdirSpy.mockRestore();
    }
  });
});
