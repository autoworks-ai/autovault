import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { log } from "../util/log.js";

const STORAGE_LOCK_FILE = ".autovault-write-lock";
const PROFILE_SYNC_LOCK_FILE = ".autovault-profile-sync-lock";

type LockOwner = { pid: number; startedAt: number; token: string };

type AcquireResult =
  | { acquired: true; token: string }
  | { acquired: false; owner: LockOwner };

// Approximate wall-clock time (ms) at which the OS booted. `os.uptime()` is
// system uptime in seconds; subtracting from now() gives the boot epoch with
// a small drift (clock adjustments, ntp slew). The drift is bounded by a
// generous fudge factor in the caller — we only use this to detect locks
// recorded BEFORE the current boot, so seconds-scale skew is irrelevant.
function approximateBootEpochMs(): number {
  return Date.now() - os.uptime() * 1000;
}

// 60s of slack swallows clock-jump artifacts (sleep/wake, NTP large-step
// adjustments) that can shift apparent boot time. A real stale lock will be
// minutes-to-hours older than the boot, so this is plenty.
const BOOT_GUARD_FUDGE_MS = 60_000;

function isOwnerAlive(owner: LockOwner): boolean {
  if (typeof owner.pid !== "number" || owner.pid <= 0) return false;

  // Boot-time guard: if the lock predates the current OS boot, the recorded
  // PID is necessarily a different process even when process.kill(pid, 0)
  // succeeds (e.g. PID reuse by init=1, a kernel thread, or any long-lived
  // daemon that came up early in this boot). Without this check, a crash +
  // reboot cycle could wedge AutoVault forever — boot recovery would see a
  // "live" PID that is actually unrelated and refuse to reclaim the lock.
  // Within-boot PID reuse remains a residual edge case (documented in
  // THREAT-MODEL.md) requiring manual lock-file removal.
  if (owner.startedAt < approximateBootEpochMs() - BOOT_GUARD_FUDGE_MS) {
    return false;
  }

  if (owner.pid === process.pid) return true;
  try {
    // Signal 0 probes liveness without sending an actual signal.
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH → no such process. EPERM → process exists but we can't signal it,
    // which still means it is alive.
    if (code === "EPERM") return true;
    return false;
  }
}

// Round-50 fix A: factor the lock primitive into a per-filename closure so we
// can run two independent mutual-exclusion domains side by side. The storage
// lock continues to serialize writeSkill / recoverOrphanBackups; a separate
// profile-sync lock serializes the prune+apply phase of syncProfiles so two
// overlapping post-install syncs cannot race their stale keep-sets and
// silently delete a freshly-installed profile symlink. Single source of
// truth — token-bound release, atomic rename-aside reclaim, boot-time guard,
// and reclaim-scratch sweep all live here exactly once.
function createFileLock(lockFilename: string): {
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  tryWithLock: <T>(fn: () => Promise<T>) => Promise<T | null>;
} {
  const reclaimScratchPrefix = `${lockFilename}.reclaim.`;

  function lockPath(): string {
    return path.join(loadConfig().storagePath, lockFilename);
  }

  // Round-45 fix: locate any reclaim-scratch files that currently hold OUR
  // token. A concurrent reclaimer can have renamed our live lock aside in the
  // middle of our critical section (see reclaimStaleLock); if the owner exits
  // before the reclaimer's restore link() fires, the reclaimer would happily
  // link our stale record back at lockPath and wedge future acquires for 10s
  // each until our process actually exits. releaseLock sweeps these scratches
  // before unlinking lockPath so the reclaimer's link() races into ENOENT and
  // the lock truly clears.
  async function findReclaimScratchByToken(token: string): Promise<string[]> {
    const dir = loadConfig().storagePath;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const matches: string[] = [];
    for (const name of entries) {
      if (!name.startsWith(reclaimScratchPrefix)) continue;
      const full = path.join(dir, name);
      try {
        const raw = await fs.readFile(full, "utf-8");
        const parsed = JSON.parse(raw) as Partial<LockOwner>;
        if (parsed.token === token) matches.push(full);
      } catch {
        // Unreadable / unparseable — not ours, leave alone.
      }
    }
    return matches;
  }

  async function readOwner(): Promise<LockOwner | null> {
    try {
      const raw = await fs.readFile(lockPath(), "utf-8");
      const parsed = JSON.parse(raw) as Partial<LockOwner>;
      if (
        typeof parsed.pid !== "number" ||
        typeof parsed.startedAt !== "number" ||
        typeof parsed.token !== "string" ||
        parsed.token.length === 0
      ) {
        return null;
      }
      return { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token };
    } catch {
      return null;
    }
  }

  // tryWriteLock returns the token written on success, or null when another
  // owner already holds the lock. Two invariants matter here:
  //
  // 1. **Token-bound release.** Only the process whose token still matches the
  //    on-disk lock may unlink it. A slow/stalled writer that returns from its
  //    critical section after the lock was reclaimed and re-acquired must NOT
  //    delete the new owner's lock.
  //
  // 2. **Lock file appears atomically with content.** A naive
  //    `fs.open(lockPath, "wx") → fs.writeFile(...)` opens a window where the
  //    lock file exists at lockPath but is still empty. A contender that hits
  //    EEXIST during that window, then reads an empty file, would treat it as
  //    unparseable debris and unlink it — letting both processes acquire
  //    concurrently. Avoid the window entirely: write the owner record to a
  //    `<lockPath>.tmp.<uuid>` file first, then `fs.link()` it into place. POSIX
  //    link() is atomic; the lock file never appears at lockPath without its
  //    full content. Crashed acquirers leak the tmp file, but those are tiny
  //    and named after the lock so they don't masquerade as orphan staging.
  async function tryWriteLock(): Promise<string | null> {
    const token = randomUUID();
    const owner: LockOwner = { pid: process.pid, startedAt: Date.now(), token };
    // First-run safety for direct library callers: writeSkill enters
    // withStorageLock BEFORE any mkdir of the storage root. The MCP server boot
    // path calls ensureStorage(), but installSkill is also exported as a library
    // API and a caller on a fresh machine would otherwise ENOENT here when
    // fs.open tries to create the tmp lock file. mkdir(recursive) is a no-op when
    // the directory already exists, so this is cheap on the hot path; permissions
    // intentionally inherit the process umask to match ensureStorage's posture.
    await fs.mkdir(loadConfig().storagePath, { recursive: true });
    const tmpPath = `${lockPath()}.tmp.${randomUUID()}`;
    let tmpFh: fs.FileHandle | null = null;
    try {
      tmpFh = await fs.open(tmpPath, "wx", 0o600);
      await tmpFh.writeFile(JSON.stringify(owner), "utf-8");
      await tmpFh.close();
      tmpFh = null;
    } catch (err) {
      if (tmpFh) await tmpFh.close().catch(() => {});
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }

    try {
      await fs.link(tmpPath, lockPath());
      await fs.unlink(tmpPath).catch(() => {});
      return token;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      await fs.unlink(tmpPath).catch(() => {});
      if (code === "EEXIST") return null;
      throw err;
    }
  }

  // Reclaim a lock we've observed to be stale (dead PID, pre-boot, or unparseable
  // debris). The naive approach — `await fs.unlink(lockPath())` — has a race:
  // two processes both observe the stale lock, both race to unlink, and one of
  // them ends up calling unlink AFTER the other has already reclaimed and
  // written its own fresh lock. The second unlink would silently delete the
  // fresh lock, letting a third process acquire concurrently.
  //
  // The fix is atomic compare-and-discard via rename-aside-and-verify:
  //   1. fs.rename(lockPath, scratch) — POSIX atomic. We've isolated whatever
  //      was at lockPath at the moment of rename.
  //   2. Re-read scratch. If the token matches what we observed (or both were
  //      unparseable), the stale lock is what we just isolated → discard scratch.
  //   3. If the token differs (some other process raced through reclaim+
  //      acquire between our read and our rename), we accidentally moved a
  //      fresh, valid lock. Try fs.link(scratch, lockPath) — link fails with
  //      EEXIST if a newer occupant already arrived; on success we've put the
  //      fresh lock back. Either way, drop the scratch.
  //
  // This guarantees: a freshly-acquired lock is never deleted by a concurrent
  // reclaim operating on a stale observation.
  async function reclaimStaleLock(observed: LockOwner | null): Promise<void> {
    const scratchPath = `${lockPath()}.reclaim.${randomUUID()}`;
    try {
      await fs.rename(lockPath(), scratchPath);
    } catch {
      // ENOENT (already reclaimed by a peer) or any other error: nothing to do.
      return;
    }

    let snapshot: LockOwner | null = null;
    try {
      const raw = await fs.readFile(scratchPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<LockOwner>;
      if (
        typeof parsed.token === "string" &&
        parsed.token.length > 0 &&
        typeof parsed.pid === "number" &&
        typeof parsed.startedAt === "number"
      ) {
        snapshot = { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token };
      }
    } catch {
      snapshot = null;
    }

    const observedToken = observed?.token ?? null;
    const snapshotToken = snapshot?.token ?? null;
    if (observedToken === snapshotToken) {
      // Confirmed stale (same token, or both unparseable).
      await fs.unlink(scratchPath).catch(() => {});
      return;
    }

    // We accidentally renamed a fresh lock. Restore it via link() so we never
    // overwrite a newer arrival. EEXIST means a newer occupant won — drop
    // scratch silently.
    try {
      await fs.link(scratchPath, lockPath());
    } catch {
      // Already a fresh occupant; the snapshot we hold is moot.
    }
    await fs.unlink(scratchPath).catch(() => {});
  }

  // Try once to acquire. Reclaim is restricted to dead-PID owners and unparseable
  // debris. We deliberately do NOT reclaim aged-but-live locks: a slow, paused,
  // debugger-stopped, or overloaded writer is still the lock holder, and stealing
  // from a live owner would let two writers run their critical sections at the
  // same time. If a writer truly hangs, the operator's recourse is to kill it —
  // the OS then makes the PID dead and the next acquire reclaims naturally.
  async function tryAcquireOnce(): Promise<AcquireResult> {
    const tokenA = await tryWriteLock();
    if (tokenA !== null) return { acquired: true, token: tokenA };

    const owner = await readOwner();
    if (!owner) {
      // Lock file present but unparseable — treat as stale debris and retry.
      await reclaimStaleLock(null);
      const tokenB = await tryWriteLock();
      if (tokenB !== null) return { acquired: true, token: tokenB };
      const refreshed = await readOwner();
      return refreshed
        ? { acquired: false, owner: refreshed }
        : { acquired: false, owner: { pid: -1, startedAt: 0, token: "" } };
    }

    if (!isOwnerAlive(owner)) {
      // Dead PID, pre-boot lock, or otherwise stale — atomic reclaim.
      await reclaimStaleLock(owner);
      const tokenC = await tryWriteLock();
      if (tokenC !== null) return { acquired: true, token: tokenC };
      const refreshed = await readOwner();
      return refreshed ? { acquired: false, owner: refreshed } : { acquired: false, owner };
    }

    return { acquired: false, owner };
  }

  // Release only when the on-disk lock still bears OUR token. Compare-and-unlink
  // closes a use-after-free style hole: if recovery reclaimed our (apparently
  // stale) lock and another process took it, our delayed unlink would otherwise
  // silently free the new owner's lock and break mutual exclusion downstream.
  //
  // Round-45 fix: also sweep any .reclaim.* scratch files holding our token
  // BEFORE the readOwner+unlink dance. A concurrent reclaimer can rename our
  // live lock aside between our acquire and our release; if we exit before its
  // restore link() runs, it would otherwise link a stale-but-now-empty record
  // back at lockPath, fooling future acquires into waiting on a non-existent
  // owner. Sweeping the scratch first turns the racing link() into ENOENT.
  async function releaseLock(token: string): Promise<void> {
    for (const scratch of await findReclaimScratchByToken(token)) {
      await fs.unlink(scratch).catch(() => {});
    }
    const owner = await readOwner();
    if (!owner) return;
    if (owner.token !== token) {
      log.warn("storage.lock_release_skipped_token_mismatch", {
        lock: lockFilename,
        heldByPid: owner.pid,
        heldByStartedAt: owner.startedAt
      });
      return;
    }
    await fs.unlink(lockPath()).catch(() => {});
  }

  // Acquire the lock with bounded waiting. writeSkill swaps are millisecond-fast,
  // so a 10s ceiling is generous; if it elapses the storage is contended in a
  // pathological way and we fail loud rather than block forever.
  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const maxWaitMs = 10_000;
    let token: string | null = null;
    while (true) {
      const result = await tryAcquireOnce();
      if (result.acquired) {
        token = result.token;
        break;
      }
      if (Date.now() - start > maxWaitMs) {
        throw new Error(
          `Could not acquire AutoVault ${lockFilename} within ${maxWaitMs}ms (held by PID ${result.owner.pid}).`
        );
      }
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
    }
    try {
      return await fn();
    } finally {
      await releaseLock(token);
    }
  }

  // Variant for boot-time recovery: try once. If another live process holds the
  // lock, return null so the caller can skip recovery rather than wait. Recovery
  // is a startup nicety — losing it for one boot is recoverable next start; what
  // is NOT recoverable is racing an active writer.
  async function tryWithLock<T>(fn: () => Promise<T>): Promise<T | null> {
    const result = await tryAcquireOnce();
    if (!result.acquired) {
      log.warn("storage.lock_held_skip_recovery", {
        lock: lockFilename,
        heldByPid: result.owner.pid,
        heldByStartedAt: result.owner.startedAt
      });
      return null;
    }
    try {
      return await fn();
    } finally {
      await releaseLock(result.token);
    }
  }

  return { withLock, tryWithLock };
}

const storageLock = createFileLock(STORAGE_LOCK_FILE);
const profileSyncLock = createFileLock(PROFILE_SYNC_LOCK_FILE);

export const withStorageLock = storageLock.withLock;
export const tryWithStorageLock = storageLock.tryWithLock;

// Round-50 fix A: separate lock domain for syncProfiles. The storage lock is
// held only briefly (snapshot + recovery); the apply phase — removeManagedLinks
// + replaceSymlink across one or more user-controlled profile roots — runs
// outside it (round-48). That left a window where two overlapping syncs could
// each compute a keep-set, then race their applies: a stale keep-set from an
// older sync could remove a managed symlink that a newer sync had just placed.
// Wrapping the entire syncProfiles body (recovery, snapshot, apply) in this
// dedicated lock serializes syncs against each other while leaving writeSkill
// free to take the storage lock independently.
export const withProfileSyncLock = profileSyncLock.withLock;
