/**
 * Memory write pipeline — Spec 00
 *
 * Owns the full write path; replaces mem0ai/oss Memory.add() / Memory.update() /
 * Memory.delete().
 *
 * Pipeline for addMemory():
 *  1. Embed the text via OpenAI
 *  2. (Spec 03) Deduplication check — placeholder, always adds for now
 *  3. (Spec 05) Context-window injection — placeholder for now
 *  4. Write Memory node to Memgraph with embedding
 *  5. Create graph edges: (User)-[:HAS_MEMORY]->(m), (m)-[:CREATED_BY]->(App)
 *  6. (async, later) Categorize via LLM
 *  7. (async, Spec 04) Entity extraction
 */

import { randomUUID } from "crypto";
import { runWrite, runRead } from "@/lib/db/memgraph";
import { embed } from "@/lib/embeddings/openai";
import { getRecentMemories, buildContextPrefix } from "./context";
import { getContextWindowConfig } from "@/lib/config/helpers";
import { categorizeMemory } from "./categorize";
import { addHistory } from "./history";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddMemoryOptions {
  userId: string;
  appName?: string;
  metadata?: Record<string, unknown>;
  /** Explicit tags for scoped retrieval via search_memory(tag: "..."). */
  tags?: string[];
}

export interface MemoryNode {
  id: string;
  content: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  userId: string;
  appName?: string;
  metadata?: string;
}

export interface UpdateMemoryOptions {
  userId: string;
}

// ---------------------------------------------------------------------------
// Write: addMemory
// ---------------------------------------------------------------------------

/**
 * Embed text and write a new Memory node to Memgraph.
 * Creates (User)-[:HAS_MEMORY]->(Memory) and optionally
 * (Memory)-[:CREATED_BY]->(App).
 *
 * Returns the created Memory id.
 */
export async function addMemory(
  text: string,
  opts: AddMemoryOptions
): Promise<string> {
  const { userId, appName, metadata, tags } = opts;
  const id = randomUUID();
  const now = new Date().toISOString();

  // Spec 05: Context window — enrich embedding with recent user memories
  // The stored content is always the original text; context only affects embedding.
  let embeddingText = text;
  const ctxConfig = await getContextWindowConfig();
  if (ctxConfig.enabled && ctxConfig.size > 0) {
    const recent = await getRecentMemories(userId, ctxConfig.size);
    const prefix = buildContextPrefix(recent);
    if (prefix) {
      embeddingText = prefix + text;
    }
  }

  const embedding = await embed(embeddingText);

  // Ensure User node exists
  await runWrite(
    `MERGE (u:User {userId: $userId})
     ON CREATE SET u.createdAt = $now`,
    { userId, now }
  );

  // Create Memory node + HAS_MEMORY edge in a single session
  await runWrite(
    `MATCH (u:User {userId: $userId}) WITH u LIMIT 1
     CREATE (m:Memory {
       id: $id,
       content: $content,
       state: 'active',
       embedding: $embedding,
       metadata: $metadata,
       tags: $tags,
       validAt: $now,
       createdAt: $now,
       updatedAt: $now
     })
     CREATE (u)-[:HAS_MEMORY]->(m)
     ${appName ? `WITH u, m
     MERGE (u)-[:HAS_APP]->(a:App {appName: $appName})
     ON CREATE SET a.id = $appId, a.createdAt = $now, a.isActive = true
     MERGE (m)-[:CREATED_BY]->(a)` : ""}
     RETURN m.id AS id`,
    {
      userId,
      id,
      content: text,
      embedding,
      metadata: metadata ? JSON.stringify(metadata) : "{}",
      tags: tags ?? [],
      now,
      ...(appName ? { appName, appId: randomUUID() } : {}),
    }
  );

  // Async categorization — fire-and-forget, never blocks response
  categorizeMemory(id, text).catch((e) => console.warn("[categorize]", e));

  // Async audit trail — fire-and-forget
  addHistory(id, null, text, "ADD").catch((e) => console.warn("[history]", e));

  return id;
}

// ---------------------------------------------------------------------------
// Write: updateMemory
// ---------------------------------------------------------------------------

/**
 * @deprecated Use supersedeMemory() instead — in-place updates violate Spec 01
 * bi-temporal model. Kept only for backward-compatible test assertions.
 * All HTTP routes have been migrated to supersedeMemory() (see PUT /memories/:id).
 */
export async function updateMemory(
  memoryId: string,
  newContent: string,
  opts: UpdateMemoryOptions
): Promise<boolean> {
  const { userId } = opts;
  const now = new Date().toISOString();
  const embedding = await embed(newContent);

  const rows = await runWrite(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $id})
     SET m.content = $content,
         m.embedding = $embedding,
         m.updatedAt = $now
     RETURN m.id AS id`,
    { userId, id: memoryId, content: newContent, embedding, now }
  );

  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Write: supersedeMemory (Spec 01 -- bi-temporal supersession)
// ---------------------------------------------------------------------------

/**
 * Temporal update: invalidate the old Memory node and create a new one that
 * supersedes it.  Creates a (new)-[:SUPERSEDES {at}]->(old) edge.
 *
 * Consolidated from 4 runWrite calls to 2 to reduce Memgraph write pressure
 * and Tantivy text-index writer contention:
 *   Call 1: Invalidate old + create new + HAS_MEMORY edge + SUPERSEDES edge (atomic)
 *   Call 2: Attach new Memory to App (optional, only when appName provided)
 *
 * Returns the id of the newly created Memory node.
 */
export async function supersedeMemory(
  oldId: string,
  newContent: string,
  userId: string,
  appName?: string,
  /** Tags to propagate to the new memory node. When omitted, inherits tags from the old node. */
  tags?: string[]
): Promise<string> {
  const now = new Date().toISOString();
  const newId = randomUUID();
  const embedding = await embed(newContent);

  // Inherit tags from old memory when not explicitly provided (WRITE-04 fix)
  let effectiveTags = tags;
  if (!effectiveTags) {
    const oldRows = await runRead<{ tags: string[] }>(
      `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $oldId})
       RETURN coalesce(m.tags, []) AS tags`,
      { userId, oldId }
    );
    effectiveTags = oldRows[0]?.tags ?? [];
  }

  // WRITE-SUPERSEDE-NOT-ATOMIC fix: All steps in a single Cypher query.
  // Invalidate old + create new + HAS_MEMORY + SUPERSEDES + optional App attach.
  // Anchored to User (Spec 09 — namespace isolation).
  await runWrite(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(old:Memory {id: $oldId})
     SET old.invalidAt = $now, old.updatedAt = $now
     WITH u, old
     CREATE (new:Memory {
       id: $newId,
       content: $newContent,
       state: 'active',
       embedding: $embedding,
       metadata: '{}',
       tags: $tags,
       validAt: $now,
       createdAt: $now,
       updatedAt: $now
     })
     CREATE (u)-[:HAS_MEMORY]->(new)
     CREATE (new)-[:SUPERSEDES {at: $now}]->(old)
     ${appName ? `WITH u, new
     MERGE (u)-[:HAS_APP]->(a:App {appName: $appName})
     ON CREATE SET a.id = $appId, a.createdAt = $now, a.isActive = true
     MERGE (new)-[:CREATED_BY]->(a)` : ""}
     RETURN new.id AS id`,
    {
      userId, oldId, newId, newContent, embedding, now, tags: effectiveTags,
      ...(appName ? { appName, appId: randomUUID() } : {}),
    }
  );

  // Async categorization of the new node — fire-and-forget
  categorizeMemory(newId, newContent).catch((e) => console.warn("[categorize]", e));

  // Async audit trail — fire-and-forget (records old → new content change)
  addHistory(newId, null, newContent, "SUPERSEDE").catch((e) => console.warn("[history]", e));

  return newId;
}

// ---------------------------------------------------------------------------
// Write: deleteMemory (soft delete)
// ---------------------------------------------------------------------------

/**
 * Soft-delete a memory by setting state = 'deleted' and invalidAt = now (Spec 01).
 */
export async function deleteMemory(
  memoryId: string,
  userId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await runWrite(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $id})
     SET m.state = 'deleted', m.invalidAt = $now, m.deletedAt = $now
     RETURN m.id AS id`,
    { userId, id: memoryId, now }
  );
  const deleted = rows.length > 0;

  // Async audit trail — fire-and-forget
  if (deleted) {
    addHistory(memoryId, null, null, "DELETE").catch((e) => console.warn("[history]", e));
  }

  return deleted;
}

// ---------------------------------------------------------------------------
// Write: archiveMemory / pauseMemory
// ---------------------------------------------------------------------------

export async function archiveMemory(
  memoryId: string,
  userId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  // WRITE-ARCHIVE-NO-INVALIDAT fix: set invalidAt so archived memories are
  // excluded from bi-temporal queries (WHERE m.invalidAt IS NULL)
  const rows = await runWrite(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $id})
     WHERE m.state = 'active'
     SET m.state = 'archived', m.archivedAt = $now, m.invalidAt = $now, m.updatedAt = $now
     RETURN m.id AS id`,
    { userId, id: memoryId, now }
  );
  const archived = rows.length > 0;

  if (archived) {
    addHistory(memoryId, null, null, "ARCHIVE").catch((e) => console.warn("[history]", e));
  }

  return archived;
}

export async function pauseMemory(
  memoryId: string,
  userId: string
): Promise<boolean> {
  const rows = await runWrite(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $id})
     WHERE m.state = 'active'
     SET m.state = 'paused', m.updatedAt = $updatedAt
     RETURN m.id AS id`,
    { userId, id: memoryId, updatedAt: new Date().toISOString() }
  );
  const paused = rows.length > 0;

  if (paused) {
    addHistory(memoryId, null, null, "PAUSE").catch((e) => console.warn("[history]", e));
  }

  return paused;
}

// ---------------------------------------------------------------------------
// Read: getMemory (single)
// ---------------------------------------------------------------------------

export async function getMemory(
  memoryId: string,
  userId: string
): Promise<MemoryNode | null> {
  const rows = await runRead<MemoryNode>(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $id})
     OPTIONAL MATCH (m)-[:CREATED_BY]->(a:App)
     RETURN m.id AS id, m.content AS content, m.state AS state,
            m.createdAt AS createdAt, m.updatedAt AS updatedAt,
            m.metadata AS metadata, $userId AS userId,
            a.appName AS appName`,
    { userId, id: memoryId }
  );
  return rows[0] ?? null;
}
