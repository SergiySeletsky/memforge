/**
 * lib/memory/history.ts — Memory audit trail (migrated from memforge-ts/oss)
 *
 * Tracks every ADD / SUPERSEDE / DELETE / ARCHIVE / PAUSE action per memory
 * as :MemoryHistory nodes in Memgraph.
 *
 * Uses runRead/runWrite from @/lib/db/memgraph.
 * The MemoryHistory index is created by initSchema() in instrumentation.ts.
 */
import { runRead, runWrite } from "@/lib/db/memgraph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistoryRecord {
  id: string;
  memoryId: string;
  previousValue: string | null;
  newValue: string | null;
  action: string;
  createdAt: string;
  updatedAt: string | null;
  isDeleted: number;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Record a history event for a memory.
 * Fire-and-forget safe — callers should .catch() rather than await.
 */
export async function addHistory(
  memoryId: string,
  previousValue: string | null,
  newValue: string | null,
  action: string,
  createdAt?: string,
  updatedAt?: string,
  isDeleted: number = 0,
): Promise<void> {
  await runWrite(
    `CREATE (h:MemoryHistory {
       id: randomUUID(),
       memoryId: $memoryId,
       previousValue: $previousValue,
       newValue: $newValue,
       action: $action,
       createdAt: $createdAt,
       updatedAt: $updatedAt,
       isDeleted: $isDeleted
     })`,
    {
      memoryId,
      previousValue: previousValue ?? null,
      newValue: newValue ?? null,
      action,
      createdAt: createdAt ?? new Date().toISOString(),
      updatedAt: updatedAt ?? null,
      isDeleted,
    },
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Get the change history for a specific memory, newest first.
 */
export async function getHistory(
  memoryId: string,
  limit: number = 100,
): Promise<HistoryRecord[]> {
  const rows = await runRead<{
    id: string;
    memoryId: string;
    previousValue: string | null;
    newValue: string | null;
    action: string;
    createdAt: string;
    updatedAt: string | null;
    isDeleted: number;
  }>(
    `MATCH (h:MemoryHistory {memoryId: $memoryId})
     RETURN h.id AS id, h.memoryId AS memoryId,
            h.previousValue AS previousValue, h.newValue AS newValue,
            h.action AS action, h.createdAt AS createdAt,
            h.updatedAt AS updatedAt, h.isDeleted AS isDeleted
     ORDER BY h.createdAt DESC
     LIMIT toInteger($limit)`,
    { memoryId, limit },
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Reset (admin / test use)
// ---------------------------------------------------------------------------

/**
 * Delete all history records from the database. Intended for testing.
 */
export async function resetHistory(): Promise<void> {
  await runWrite("MATCH (h:MemoryHistory) DETACH DELETE h", {});
}
