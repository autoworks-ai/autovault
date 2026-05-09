import type { SyncProfilesResult, SyncSkillStatus } from "../profiles/sync.js";

export type CompactSyncResult = {
  profiles: Record<string, number>;
  linkedRoots: Record<string, string>;
  statusCounts: Record<string, Partial<Record<SyncSkillStatus["status"], number>>>;
  warningCount: number;
};

export type FormattedSyncResult<T extends Record<string, unknown>> = Omit<T, "sync"> & {
  sync?: T["sync"] | CompactSyncResult;
};

export function compactSyncResult(sync: SyncProfilesResult): CompactSyncResult {
  return {
    profiles: Object.fromEntries(
      Object.entries(sync.profiles).map(([agent, names]) => [agent, names.length])
    ),
    linkedRoots: sync.linkedRoots,
    statusCounts: Object.fromEntries(
      Object.entries(sync.profileStatus).map(([agent, statuses]) => [
        agent,
        countStatuses(statuses)
      ])
    ),
    warningCount: sync.warnings.length
  };
}

export function formatResultSync<T extends Record<string, unknown>>(
  result: T,
  verbose?: boolean
): FormattedSyncResult<T> {
  if (verbose) return result;
  const sync = result.sync;
  if (!isSyncProfilesResult(sync)) return result;
  return {
    ...result,
    sync: compactSyncResult(sync)
  };
}

function countStatuses(
  statuses: SyncSkillStatus[]
): Partial<Record<SyncSkillStatus["status"], number>> {
  const counts: Partial<Record<SyncSkillStatus["status"], number>> = {};
  for (const status of statuses) {
    counts[status.status] = (counts[status.status] ?? 0) + 1;
  }
  return counts;
}

function isSyncProfilesResult(value: unknown): value is SyncProfilesResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.profiles === "object" &&
    record.profiles !== null &&
    typeof record.linkedRoots === "object" &&
    record.linkedRoots !== null &&
    typeof record.profileStatus === "object" &&
    record.profileStatus !== null &&
    Array.isArray(record.warnings)
  );
}
