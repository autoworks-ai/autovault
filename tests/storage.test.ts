import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureStorage,
  listInstalledSkillNames,
  readSkill,
  readSkillSource,
  recoverOrphanBackups,
  writeSkill,
  writeSkillResources,
  writeSkillSource
} from "../src/storage/index.js";
import { withStorageLock } from "../src/storage/lock.js";
import { currentStorageRoot } from "./setup.js";

const skillMd = `---
name: parsed-skill
description: A real description that is sufficiently long to satisfy schema length checks.
tags:
  - alpha
  - beta
category: utility
metadata:
  version: "2.3.4"
capabilities:
  network: true
  filesystem: readwrite
  tools:
    - Bash
requires-secrets:
  - name: API_KEY
    description: Example secret
    required: true
---

# Body
`;

describe("storage", () => {
  it("parses real frontmatter when reading a skill", async () => {
    await ensureStorage();
    await writeSkill("parsed-skill", skillMd);
    const skill = await readSkill("parsed-skill");
    expect(skill).not.toBeNull();
    expect(skill!.description).toMatch(/real description/);
    expect(skill!.version).toBe("2.3.4");
    expect(skill!.tags).toEqual(["alpha", "beta"]);
    expect(skill!.category).toBe("utility");
    expect(skill!.capabilities).toEqual({
      network: true,
      filesystem: "readwrite",
      tools: ["Bash"]
    });
    expect(skill!.requiresSecrets).toEqual([
      { name: "API_KEY", description: "Example secret", required: true }
    ]);
  });

  it("lists installed skill names", async () => {
    await writeSkill("alpha", skillMd.replace("parsed-skill", "alpha"));
    await writeSkill("beta", skillMd.replace("parsed-skill", "beta"));
    const names = await listInstalledSkillNames();
    expect(names.sort()).toEqual(["alpha", "beta"]);
  });

  it("writes resources safely and rejects traversal", async () => {
    await writeSkill("res-skill", skillMd.replace("parsed-skill", "res-skill"));
    await writeSkillResources("res-skill", [
      { path: "scripts/hello.sh", content: "echo hi" }
    ]);
    await expect(
      writeSkillResources("res-skill", [{ path: "../escape.txt", content: "x" }])
    ).rejects.toThrow();
    await expect(
      writeSkillResources("res-skill", [{ path: "/etc/passwd", content: "x" }])
    ).rejects.toThrow();
  });

  // Defense-in-depth for the round-13 codex critical: even if a future code
  // path bypasses validation, writeSkill itself must refuse to overwrite the
  // SKILL.md it just wrote, or the .autovault-* metadata files it manages.
  it("rejects a resource that would overwrite SKILL.md", async () => {
    await expect(
      writeSkill(
        "reserved-skill-md",
        skillMd.replace("parsed-skill", "reserved-skill-md"),
        [{ path: "SKILL.md", content: "imposter" }]
      )
    ).rejects.toThrow(/Reserved resource path/);
  });

  it("rejects a resource that would overwrite .autovault-manifest", async () => {
    await expect(
      writeSkill(
        "reserved-manifest",
        skillMd.replace("parsed-skill", "reserved-manifest"),
        [{ path: ".autovault-manifest", content: "{}" }]
      )
    ).rejects.toThrow(/Reserved resource path/);
  });

  it("rejects a resource that would overwrite .autovault-source.json", async () => {
    await expect(
      writeSkill(
        "reserved-source",
        skillMd.replace("parsed-skill", "reserved-source"),
        [{ path: ".autovault-source.json", content: "{}" }]
      )
    ).rejects.toThrow(/Reserved resource path/);
  });

  // Round-36 fix: a resource path equal to (or containing) `__proto__`,
  // `constructor`, or `prototype` collides with Object.prototype machinery on
  // a plain-object manifest map: `manifest.files["__proto__"] = sig` would
  // mutate the prototype chain instead of recording an own key, so the file
  // would be bundle-hashed but missing from the signed manifest. Reject at
  // the validation boundary so a malicious skill can't ship such a path.
  it("rejects a resource path equal to __proto__", async () => {
    await expect(
      writeSkill(
        "proto-skill",
        skillMd.replace("parsed-skill", "proto-skill"),
        [{ path: "__proto__", content: "x" }]
      )
    ).rejects.toThrow(/Reserved resource path/);
  });

  it("rejects a resource whose nested segment is __proto__", async () => {
    await expect(
      writeSkill(
        "proto-nested",
        skillMd.replace("parsed-skill", "proto-nested"),
        [{ path: "bin/__proto__", content: "x" }]
      )
    ).rejects.toThrow(/Reserved resource path/);
  });

  it("rejects a resource path equal to constructor", async () => {
    await expect(
      writeSkill(
        "ctor-skill",
        skillMd.replace("parsed-skill", "ctor-skill"),
        [{ path: "constructor", content: "x" }]
      )
    ).rejects.toThrow(/Reserved resource path/);
  });

  it("rejects a resource path equal to prototype", async () => {
    await expect(
      writeSkill(
        "proto-key-skill",
        skillMd.replace("parsed-skill", "proto-key-skill"),
        [{ path: "prototype", content: "x" }]
      )
    ).rejects.toThrow(/Reserved resource path/);
  });

  it("writes declared bin commands with mode 0o755 and other resources with 0o644", async () => {
    const binSkill = `---
name: bin-skill
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/setup
    description: setup
---

# Body
`;
    await writeSkill("bin-skill", binSkill, [
      { path: "bin/setup", content: "#!/usr/bin/env bash\necho ok\n" },
      { path: "references/notes.md", content: "# notes\n" }
    ]);
    const setupStat = await fs.stat(
      path.join(currentStorageRoot(), "skills", "bin-skill", "bin", "setup")
    );
    expect(setupStat.mode & 0o777).toBe(0o755);
    const notesStat = await fs.stat(
      path.join(currentStorageRoot(), "skills", "bin-skill", "references", "notes.md")
    );
    expect(notesStat.mode & 0o777).toBe(0o644);

    const skill = await readSkill("bin-skill");
    expect(skill).not.toBeNull();
    expect(skill!.bin.setup).toEqual({
      command: "bin/setup",
      args: [],
      description: "setup",
      requiresTty: true
    });
  });

  it("prunes resources dropped from a re-install", async () => {
    // First install ships two resources. Second install (same name) drops one.
    // Without stale-cleanup the dropped file lingers under the skill dir,
    // un-covered by the new manifest but still readable via read_skill_resource
    // and through profile-synced mirrors.
    const binSkill = (resources: string[]) => `---
name: prune-skill
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
${resources.length > 0 ? `resources:\n${resources.map((p) => `  - path: ${p}\n    type: file`).join("\n")}\n` : ""}---

# Body
`;
    await writeSkill("prune-skill", binSkill(["scripts/a.sh", "scripts/b.sh"]), [
      { path: "scripts/a.sh", content: "echo a\n" },
      { path: "scripts/b.sh", content: "echo b\n" }
    ]);
    const dir = path.join(currentStorageRoot(), "skills", "prune-skill");
    await expect(fs.stat(path.join(dir, "scripts", "a.sh"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(dir, "scripts", "b.sh"))).resolves.toBeDefined();

    await writeSkill("prune-skill", binSkill(["scripts/a.sh"]), [
      { path: "scripts/a.sh", content: "echo a-v2\n" }
    ]);
    await expect(fs.stat(path.join(dir, "scripts", "a.sh"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(dir, "scripts", "b.sh"))).rejects.toThrow();
  });

  it("rejects resource writes whose parent is a symlink escaping the skill root", async () => {
    // A pre-existing parent symlink would otherwise relocate fs.writeFile
    // outside AUTOVAULT_STORAGE_PATH. realpathIfExists on the leaf returns
    // null when the file doesn't yet exist, so the leaf-only check missed
    // this; the fix walks up to the closest existing ancestor.
    await writeSkill("symlink-parent", skillMd.replace("parsed-skill", "symlink-parent"));
    const skillRoot = path.join(currentStorageRoot(), "skills", "symlink-parent");
    const escapeTarget = path.join(currentStorageRoot(), "outside-target");
    await fs.mkdir(escapeTarget, { recursive: true });
    await fs.symlink(escapeTarget, path.join(skillRoot, "evil"));

    await expect(
      writeSkillResources("symlink-parent", [
        { path: "evil/passwd", content: "should-not-land" }
      ])
    ).rejects.toThrow(/parent symlink|escapes/i);
    await expect(fs.stat(path.join(escapeTarget, "passwd"))).rejects.toThrow();
  });

  it("rolls back atomically when a resource path fails validation", async () => {
    // A bad resource path throws inside writeSkill *after* the new tmp dir
    // has been created. The previous install must be observable in full,
    // unmodified — without staging+swap, the live dir would already have its
    // SKILL.md replaced by the time the throw fires.
    await writeSkill("rollback-skill", skillMd.replace("parsed-skill", "rollback-skill"), [
      { path: "scripts/keep.sh", content: "echo original\n" }
    ]);
    const dir = path.join(currentStorageRoot(), "skills", "rollback-skill");
    const originalSkillMd = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");

    await expect(
      writeSkill(
        "rollback-skill",
        skillMd.replace("parsed-skill", "rollback-skill").replace("# Body", "# UPDATED"),
        [{ path: "../escape.txt", content: "x" }]
      )
    ).rejects.toThrow();

    // Live dir untouched: original SKILL.md and original keep.sh still there.
    const afterSkillMd = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");
    expect(afterSkillMd).toBe(originalSkillMd);
    const keep = await fs.readFile(path.join(dir, "scripts", "keep.sh"), "utf-8");
    expect(keep).toBe("echo original\n");
  });

  it("treats `bin/./setup` and `bin/setup` as the same canonical resource", async () => {
    // Without full POSIX normalization in canonicalRelPath, the manifest
    // would key the file under `bin/./setup` while the on-disk path is
    // `bin/setup`. A subsequent stale-prune used to delete the just-written
    // file because the keep set didn't match. The atomic writeSkill swap
    // makes prune unnecessary, but the manifest key still has to match the
    // file the CLI actually looks up.
    const md = `---
name: canon-skill
description: Description long enough to pass the schema length check cleanly.
metadata:
  version: "1.0.0"
bin:
  setup:
    command: bin/./setup
    description: setup
---

# Body
`;
    await writeSkill("canon-skill", md, [
      { path: "bin/./setup", content: "#!/usr/bin/env bash\necho ok\n" }
    ]);
    const dir = path.join(currentStorageRoot(), "skills", "canon-skill");
    const setup = await fs.readFile(path.join(dir, "bin", "setup"), "utf-8");
    expect(setup).toContain("echo ok");
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, ".autovault-manifest"), "utf-8")
    );
    expect(manifest.files["bin/setup"]).toBeDefined();
    expect(manifest.files["bin/./setup"]).toBeUndefined();
  });

  it("recovers an orphaned .bak.* directory on boot when live is missing", async () => {
    // Simulates a crash between rename(live → bak) and rename(tmp → live):
    // the live dir is gone, only the .bak remains. listInstalledSkillNames
    // filters '.' so the install would otherwise be invisible. Before this
    // fix, the prior install was effectively lost on crash even though the
    // bytes were sitting on disk.
    //
    // Recovery is called directly (not via ensureStorage) because running it
    // from every storage access would race concurrent writeSkill calls — this
    // test exercises the public boot-time recovery surface.
    await writeSkill(
      "crash-recover",
      skillMd.replace("parsed-skill", "crash-recover"),
      [{ path: "scripts/keep.sh", content: "echo hi\n" }]
    );
    const liveDir = path.join(currentStorageRoot(), "skills", "crash-recover");
    const bakDir = `${liveDir}.bak.${Date.now()}.testfixture`;
    await fs.rename(liveDir, bakDir);
    await expect(fs.stat(liveDir)).rejects.toThrow();

    await recoverOrphanBackups();
    const stat = await fs.stat(liveDir);
    expect(stat.isDirectory()).toBe(true);
    const keep = await fs.readFile(path.join(liveDir, "scripts", "keep.sh"), "utf-8");
    expect(keep).toBe("echo hi\n");

    const names = await listInstalledSkillNames();
    expect(names).toContain("crash-recover");
  });

  it("does not clobber a live directory when an orphan .bak.* shares its name", async () => {
    // If recovery runs while a fresh install of the same name already exists,
    // the orphan must be discarded rather than overwriting the live install.
    // Otherwise re-installing a skill mid-recovery would silently roll back
    // to the old bytes.
    await writeSkill("name-collision", skillMd.replace("parsed-skill", "name-collision"));
    const liveDir = path.join(currentStorageRoot(), "skills", "name-collision");
    const bakDir = `${liveDir}.bak.${Date.now()}.colliding`;
    await fs.mkdir(bakDir, { recursive: true });
    await fs.writeFile(path.join(bakDir, "SKILL.md"), "should-not-replace-live", "utf-8");

    await recoverOrphanBackups();
    const liveSkillMd = await fs.readFile(path.join(liveDir, "SKILL.md"), "utf-8");
    expect(liveSkillMd).not.toBe("should-not-replace-live");
    expect(liveSkillMd).toContain("name-collision");
  });

  it("removes orphaned .tmp.* staging directories on recovery", async () => {
    await writeSkill("tmp-cleanup", skillMd.replace("parsed-skill", "tmp-cleanup"));
    const tmpDir = path.join(
      currentStorageRoot(),
      "skills",
      `tmp-cleanup.tmp.${Date.now()}.leak`
    );
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "garbage"), "x", "utf-8");

    await recoverOrphanBackups();
    await expect(fs.stat(tmpDir)).rejects.toThrow();
  });

  it("recoverOrphanBackups skips when another live process holds the storage lock", async () => {
    // Multi-process scenario: two MCP servers share one $AUTOVAULT_STORAGE_PATH
    // (Claude Code + Cursor + Codex), and process B boots while process A is
    // mid-install. Recovery used to unconditionally sweep .tmp.* dirs — exactly
    // what writeSkill uses as active staging — corrupting A's install. With
    // the cross-process lock, recovery probes the lock; if it's held by a live
    // PID, recovery defers to the next boot rather than racing the writer.
    //
    // We forge a lock pointing at THIS process's PID (process.pid is trivially
    // alive), drop a fake .tmp.* dir to simulate an in-flight staging, and
    // assert recovery left it alone.
    const lockPath = path.join(currentStorageRoot(), ".autovault-write-lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        token: "forged-token-live-pid"
      }),
      { encoding: "utf-8", mode: 0o600 }
    );
    const fakeStaging = path.join(
      currentStorageRoot(),
      "skills",
      `inflight.tmp.${Date.now()}.held-by-other-process`
    );
    await fs.mkdir(fakeStaging, { recursive: true });
    await fs.writeFile(path.join(fakeStaging, "SKILL.md"), "in-flight", "utf-8");

    await recoverOrphanBackups();

    // Recovery must have bailed out — the staging dir survives.
    const stat = await fs.stat(fakeStaging);
    expect(stat.isDirectory()).toBe(true);

    // Clean up so other tests aren't blocked by the forged lock.
    await fs.unlink(lockPath).catch(() => {});
  });

  it("recoverOrphanBackups reclaims a lock that predates the OS boot (round-27 PID-reuse guard)", async () => {
    // Round 27 finding: lock liveness checked only process.kill(pid, 0). After
    // a crash + reboot, the OS will eventually reuse the dead writer's PID
    // for an unrelated long-lived process; isOwnerAlive then returns true
    // forever, wedging every write past the 10s acquire ceiling. The fix is
    // a boot-epoch guard — a lock whose startedAt predates the current OS
    // boot is necessarily a different process even if the PID is alive.
    // We exercise the guard directly by stamping startedAt at epoch 0
    // (definitely before this boot), pointing pid at this trivially-alive
    // process, and asserting recovery reclaims the staging dir despite the
    // alive PID.
    const lockPath = path.join(currentStorageRoot(), ".autovault-write-lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: 0, // pre-boot, by construction
        token: "pre-boot-stale"
      }),
      { encoding: "utf-8", mode: 0o600 }
    );
    const orphan = path.join(currentStorageRoot(), "skills", "stale-test.bak.0.x");
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, "SKILL.md"), "stale", "utf-8");

    await recoverOrphanBackups();

    // The pre-boot lock got reclaimed and recovery was free to clean up.
    await expect(fs.stat(orphan)).rejects.toThrow();
    // Lock file released by the recovery wrapper after the critical section.
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it("recoverOrphanBackups does NOT steal an aged lock held by a live PID", async () => {
    // Round 25 finding: an earlier draft reclaimed locks older than 5 min even
    // when isOwnerAlive(owner) returned true. That meant a slow, paused, or
    // debugger-stopped writer could have its lock yanked out from under it,
    // letting recovery sweep its in-flight `.tmp.*` staging while the real
    // writer thought it still held the lock. Reclaim is now restricted to
    // dead PIDs and unparseable debris; we pin that here by forging a lock
    // whose startedAt is ~6 min ago but whose pid is process.pid (trivially
    // alive). Recovery must defer; the staging dir must survive.
    const lockPath = path.join(currentStorageRoot(), ".autovault-write-lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now() - 6 * 60_000,
        token: "aged-but-live"
      }),
      { encoding: "utf-8", mode: 0o600 }
    );
    const fakeStaging = path.join(
      currentStorageRoot(),
      "skills",
      `aged-inflight.tmp.${Date.now()}.aged`
    );
    await fs.mkdir(fakeStaging, { recursive: true });
    await fs.writeFile(path.join(fakeStaging, "SKILL.md"), "in-flight", "utf-8");

    await recoverOrphanBackups();

    const stat = await fs.stat(fakeStaging);
    expect(stat.isDirectory()).toBe(true);
    // And the forged lock must still be on disk — recovery declined to steal.
    const onDisk = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
      token: string;
    };
    expect(onDisk.token).toBe("aged-but-live");

    await fs.unlink(lockPath).catch(() => {});
  });

  it("withStorageLock serializes concurrent acquires (no overlap inside the critical section)", async () => {
    // Round 26 finding: an earlier implementation took the lock by opening
    // lockPath O_EXCL and *then* writing the owner JSON. A racing process
    // that hit EEXIST in that window would see an empty file, treat it as
    // unparseable debris, unlink it, and acquire — letting both processes
    // run their critical section at the same time. The fix writes the owner
    // record to a tmp file first and atomically link()s it into place, so
    // the lock file at lockPath always appears fully written. We exercise
    // the post-fix invariant directly: two concurrent acquires must
    // serialize. If the bug regresses, both critical sections will run in
    // parallel and the overlap counter will exceed 1.
    let inFlight = 0;
    let maxInFlight = 0;
    const enter = async () => {
      await withStorageLock(async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Hold the lock long enough that a buggy contender would observe
        // the partial-write window if one existed.
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
      });
    };
    await Promise.all([enter(), enter(), enter()]);
    expect(maxInFlight).toBe(1);
  });

  it("withStorageLock recovers from a manually-placed empty lock file (debris reclaim)", async () => {
    // The unparseable-debris reclaim path is still required for genuinely
    // corrupt lock files (manual tampering, disk corruption). With the
    // link-based acquire, an empty file on disk no longer indicates a peer
    // mid-acquire — peers always observe a fully-written lock. So unlinking
    // a parseable-debris lock and acquiring is safe. This test pins that.
    const lockPath = path.join(currentStorageRoot(), ".autovault-write-lock");
    await fs.writeFile(lockPath, "", { encoding: "utf-8", mode: 0o600 });

    let entered = false;
    await withStorageLock(async () => {
      entered = true;
    });
    expect(entered).toBe(true);
    // Lock file cleaned up after release.
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it("releaseLock is a no-op when the on-disk lock no longer carries our token", async () => {
    // Round 25 finding: an earlier draft of releaseLock unconditionally
    // unlinked the lock file. If process A's lock had been reclaimed (e.g.
    // because A's PID had died) and process B then took the lock, A's later
    // attempt to release would silently delete B's lock — letting a third
    // writer C race B inside the critical section. The fix: compare-and-
    // unlink. We exercise it through the public API by holding the lock,
    // then forging a different token on disk while still inside the
    // critical section. When the wrapper releases, it must see the token
    // mismatch and leave the forged lock alone.
    const lockPath = path.join(currentStorageRoot(), ".autovault-write-lock");

    let forgedSurvived = false;
    await withStorageLock(async () => {
      // Mid-critical-section: a hostile reclaim swaps in a different owner.
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
          token: "different-owner-token"
        }),
        { encoding: "utf-8", mode: 0o600 }
      );
    });
    // After wrapper completes, the forged lock should still exist because our
    // release saw the token mismatch and bailed out.
    try {
      const onDisk = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
        token: string;
      };
      forgedSurvived = onDisk.token === "different-owner-token";
    } catch {
      forgedSurvived = false;
    }
    expect(forgedSurvived).toBe(true);

    await fs.unlink(lockPath).catch(() => {});
  });

  it("releaseLock sweeps a reclaim scratch carrying our token (round-45)", async () => {
    // Round 45 finding: reclaimStaleLock can rename a freshly-acquired lock
    // aside while the owner is still inside the critical section. If the
    // owner exits before the reclaimer's restore link() fires, the reclaimer
    // would otherwise resurrect the (now-stale) record at lockPath and wedge
    // every subsequent withStorageLock call for 10s. The fix: releaseLock
    // sweeps any .reclaim.* scratch holding our token before unlinking
    // lockPath, so the reclaimer's link() loses the race into ENOENT.
    //
    // We exercise the post-fix invariant by mid-critical-section moving the
    // live lock to a scratch (which is exactly the on-disk state a concurrent
    // reclaimer creates between its rename and its restore link). Without the
    // fix, the scratch survives the wrapper and pretends to be a held lock;
    // the next acquire times out.
    const lockPath = path.join(currentStorageRoot(), ".autovault-write-lock");
    let scratchPath = "";

    await withStorageLock(async () => {
      const owner = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
        token: string;
      };
      scratchPath = `${lockPath}.reclaim.${owner.token}`;
      // Simulate the reclaimer's first step: rename lockPath aside. The
      // scratch now carries OUR token; lockPath itself is empty.
      await fs.rename(lockPath, scratchPath);
    });

    // After release, the scratch must be gone (release swept it).
    await expect(fs.stat(scratchPath)).rejects.toThrow();
    // And lockPath must be clear so future acquires succeed quickly.
    await expect(fs.stat(lockPath)).rejects.toThrow();

    let reAcquired = false;
    await withStorageLock(async () => {
      reAcquired = true;
    });
    expect(reAcquired).toBe(true);
  });

  it("ensureStorage does NOT touch transient .tmp.*/.bak.* siblings (race-safety)", async () => {
    // ensureStorage runs on every storage access. If it called recovery, a
    // concurrent writeSkill mid-swap could see its in-flight .tmp.<rand> dir
    // deleted, or see its .bak.<rand> rolled back over a fresh tmp swap. The
    // recovery contract is "boot-only"; this test pins that invariant by
    // staging a fake `.tmp.*` and expecting ensureStorage to leave it alone.
    const stagingDir = path.join(
      currentStorageRoot(),
      "skills",
      `concurrent-write.tmp.${Date.now()}.fake-inflight`
    );
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(path.join(stagingDir, "SKILL.md"), "in-flight", "utf-8");

    await ensureStorage();

    const stat = await fs.stat(stagingDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("round-trips skill source metadata", async () => {
    await writeSkill("src-skill", skillMd.replace("parsed-skill", "src-skill"));
    await writeSkillSource("src-skill", {
      source: "github",
      identifier: "owner/repo",
      fetchedAt: new Date().toISOString(),
      contentHash: "abc"
    });
    const source = await readSkillSource("src-skill");
    expect(source?.source).toBe("github");
    expect(source?.contentHash).toBe("abc");
  });

  it("writeSkill writes source provenance atomically with SKILL.md when supplied", async () => {
    // Pre-fix, install_skill swapped the staged dir into place THEN called
    // writeSkillSource. A crash (or even slow disk) between those steps left
    // the live SKILL.md/resources paired with the prior install's source —
    // and check_updates uses source.contentHash to detect upstream drift, so
    // the window made tampered or rolled-back bytes look upstream-clean.
    // Passing source through writeSkill puts it INSIDE the staged tmp dir
    // before the rename, so the atomic swap delivers SKILL.md and source
    // together. This test pins the structural property: writeSkill alone
    // (no follow-up writeSkillSource) lands a correct source.json on disk.
    const fetchedAt = new Date().toISOString();
    await writeSkill(
      "atomic-source",
      skillMd.replace("parsed-skill", "atomic-source"),
      [],
      {
        source: "github",
        identifier: "owner/repo",
        fetchedAt,
        contentHash: "deadbeef".repeat(8),
        upstreamSha: "0123456789abcdef0123456789abcdef01234567"
      }
    );
    const source = await readSkillSource("atomic-source");
    expect(source).not.toBeNull();
    expect(source!.source).toBe("github");
    expect(source!.identifier).toBe("owner/repo");
    expect(source!.fetchedAt).toBe(fetchedAt);
    expect(source!.upstreamSha).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("writeSkill carries forward existing source when no new source is supplied", async () => {
    // Repeated writes to an existing skill that don't refresh provenance
    // (e.g., a future bin-only patch path, or the test harness above) must
    // preserve the prior install's source record rather than blanking it.
    // Without carry-forward, a writeSkill called without source would
    // produce a live install with no source.json — and check_updates can't
    // distinguish that from a hand-built install.
    await writeSkill(
      "carry-fwd",
      skillMd.replace("parsed-skill", "carry-fwd"),
      [],
      {
        source: "github",
        identifier: "carry/origin",
        fetchedAt: new Date().toISOString(),
        contentHash: "abc"
      }
    );
    // Subsequent writeSkill without source should keep the original.
    await writeSkill("carry-fwd", skillMd.replace("parsed-skill", "carry-fwd"));
    const source = await readSkillSource("carry-fwd");
    expect(source?.identifier).toBe("carry/origin");
  });

  it("writeSkill replaces source on an upgrade install rather than carrying old", async () => {
    // The mirror invariant: when a fresh source IS supplied, it must replace
    // the prior record. Without this, an in-place upgrade from inline →
    // github source would leave readSkillSource reporting the original
    // inline identifier even though install_skill thought it had recorded
    // the upstream.
    await writeSkill(
      "upgrade-source",
      skillMd.replace("parsed-skill", "upgrade-source"),
      [],
      {
        source: "inline",
        identifier: "v1",
        fetchedAt: new Date().toISOString(),
        contentHash: "v1hash"
      }
    );
    await writeSkill(
      "upgrade-source",
      skillMd.replace("parsed-skill", "upgrade-source"),
      [],
      {
        source: "github",
        identifier: "owner/repo",
        fetchedAt: new Date().toISOString(),
        contentHash: "v2hash",
        upstreamSha: "ffffffffffffffffffffffffffffffffffffffff"
      }
    );
    const source = await readSkillSource("upgrade-source");
    expect(source?.source).toBe("github");
    expect(source?.identifier).toBe("owner/repo");
    expect(source?.contentHash).toBe("v2hash");
  });
});
