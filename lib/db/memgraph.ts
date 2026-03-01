/**
 * Memgraph connection layer — Spec 00
 *
 * Provides:
 *  - getDriver()          singleton neo4j-driver Driver instance
 *  - runRead(q, p)        execute read Cypher, return plain-object records
 *  - runWrite(q, p)       execute write Cypher, return plain-object records
 *  - initSchema()         idempotent DDL: constraints + vector index + text index
 *  - getOrCreateUserMg()  MERGE User node, return it
 *
 * Reliability features:
 *  - globalThis guard: driver survives Next.js HMR without leaking connections
 *  - withRetry(): automatic exponential-backoff retry for transient errors
 *    (connection closed, ECONNREFUSED, Tantivy index writer panics, tx conflicts)
 *  - Connection pool tuned for concurrent request profiles
 */

import neo4j, { Driver, Record as Neo4jRecord } from "neo4j-driver";

// ---------------------------------------------------------------------------
// Singleton driver — globalThis guard survives Next.js HMR module re-creates
// ---------------------------------------------------------------------------

type GlobalWithDriver = typeof globalThis & { __memgraphDriver?: Driver | null };

export function getDriver(): Driver {
  const g = globalThis as GlobalWithDriver;
  if (!g.__memgraphDriver) {
    const url = process.env.MEMGRAPH_URL ?? "bolt://localhost:7687";
    const user = process.env.MEMGRAPH_USER ?? process.env.MEMGRAPH_USERNAME ?? "";
    const pass = process.env.MEMGRAPH_PASSWORD ?? "";
    g.__memgraphDriver = neo4j.driver(url, neo4j.auth.basic(user, pass), {
      // Memgraph does not support APOC bookmarks — disable bookmark manager
      disableLosslessIntegers: true,
      // Memgraph 3.x listens on plain Bolt — disable TLS to avoid ECONNRESET
      encrypted: false,
      // Connection pool: allow enough sessions for concurrent reads + entity extraction
      maxConnectionPoolSize: 25,
      // Fail fast on unavailable connections rather than queuing indefinitely
      connectionAcquisitionTimeout: 10_000,
    });
  }
  return g.__memgraphDriver;
}

/** Close driver gracefully (call on app shutdown). */
export async function closeDriver(): Promise<void> {
  const g = globalThis as GlobalWithDriver;
  if (g.__memgraphDriver) {
    await g.__memgraphDriver.close().catch(() => {});
    g.__memgraphDriver = null;
  }
}

// ---------------------------------------------------------------------------
// Retry logic for transient Memgraph errors
// ---------------------------------------------------------------------------

// Declared here so withRetry() can reset it on connection errors
// (vector indexes may be lost after Memgraph restart)
let _vectorIndexVerified = false;

/**
 * Error messages that indicate a transient condition worth retrying:
 *   - "Connection was closed by server"  — Bolt TCP tear-down under load
 *   - "Failed to connect to server"      — Container restart / network blip
 *   - "ECONNREFUSED" / "ECONNRESET"      — OS-level TCP errors
 *   - "Cannot resolve conflicting transactions" — MVCC conflict, retry wins
 *   - "Tantivy error" / "index writer was killed" — Memgraph full-text index
 *     writer thread panic under concurrent writes; index resets on next write
 */
const TRANSIENT_PATTERNS = [
  "Connection was closed by server",
  "Failed to connect to server",
  "ServiceUnavailable",
  "ECONNREFUSED",
  "ECONNRESET",
  "Cannot resolve conflicting transactions",
  "Tantivy error",
  "index writer was killed",
  "An index writer was killed",
];

/** Returns true when the error is transient (safe to retry). */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}

/** Returns true when the error indicates a broken connection (invalidate driver). */
function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Connection was closed by server") ||
    msg.includes("Failed to connect to server") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ServiceUnavailable")
  );
}

/**
 * Execute `fn` up to `maxAttempts` times, retrying only on transient errors.
 * Delay between retries follows exponential backoff: baseDelayMs * 2^(attempt-1).
 * On connection-level errors the driver is invalidated so the next attempt
 * picks up a fresh connection.
 *
 * @param maxAttempts  default 3
 * @param baseDelayMs  default 300 ms  (300 → 600 → 1200)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 300
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[memgraph] transient error on attempt ${attempt}/${maxAttempts}, retry in ${delay}ms:`,
        err instanceof Error ? err.message.slice(0, 120) : String(err)
      );
      // Invalidate the driver on connection-level errors; next getDriver() call
      // will create a fresh Bolt connection to Memgraph.
      if (isConnectionError(err)) {
        const g = globalThis as GlobalWithDriver;
        if (g.__memgraphDriver) {
          g.__memgraphDriver.close().catch(() => {});
          g.__memgraphDriver = null;
        }
        // Also reset the vector-index verified flag so it re-checks on next call
        _vectorIndexVerified = false;
      }
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Internal: deserialize a Neo4j Record to a plain object
// ---------------------------------------------------------------------------

function toPlainObject(record: Neo4jRecord): Record<string, unknown> {
  return Object.fromEntries(
    record.keys.map((k) => [String(k), record.get(k as string)])
  );
}

/**
 * Memgraph requires SKIP / LIMIT values to be Bolt integer types, not floats.
 * The most reliable fix is to rewrite `SKIP $x` → `SKIP toInteger($x)` and
 * `LIMIT $x` → `LIMIT toInteger($x)` at the Cypher level so Memgraph converts
 * the type, regardless of how the neo4j-driver serializes the parameter.
 */
function wrapSkipLimit(cypher: string): string {
  return cypher
    .replace(/\bSKIP\s+\$(\w+)/gi, "SKIP toInteger($$$1)")
    .replace(/\bLIMIT\s+\$(\w+)/gi, "LIMIT toInteger($$$1)");
}

// ---------------------------------------------------------------------------
// runRead / runWrite — with automatic retry on transient errors
// ---------------------------------------------------------------------------

/** Run a read-only Cypher query and return deserialized results. */
export async function runRead<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  return withRetry(async () => {
    const session = getDriver().session({ defaultAccessMode: "READ" });
    try {
      const result = await session.run(wrapSkipLimit(cypher), params);
      return result.records.map(toPlainObject) as T[];
    } finally {
      await session.close();
    }
  });
}

/** Run a write Cypher statement and return deserialized results. */
export async function runWrite<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  return withRetry(async () => {
    const session = getDriver().session({ defaultAccessMode: "WRITE" });
    try {
      const result = await session.run(wrapSkipLimit(cypher), params);
      return result.records.map(toPlainObject) as T[];
    } finally {
      await session.close();
    }
  });
}

/**
 * Execute multiple Cypher statements inside a single explicit write transaction
 * (DB-01). All steps share the same Bolt session; the transaction is committed
 * atomically or rolled back on the first error.
 *
 * Use this when two or more writes must be atomic — e.g. supersede-old +
 * create-new — to eliminate MVCC races between independent runWrite() calls.
 *
 * @param steps  Ordered array of { cypher, params? } pairs.
 * @returns      Array of result rows per step (same order as steps).
 */
export async function runTransaction<T = Record<string, unknown>>(
  steps: Array<{ cypher: string; params?: Record<string, unknown> }>
): Promise<T[][]> {
  return withRetry(async () => {
    const session = getDriver().session({ defaultAccessMode: "WRITE" });
    const tx = session.beginTransaction();
    const results: T[][] = [];
    try {
      for (const { cypher, params = {} } of steps) {
        const result = await tx.run(wrapSkipLimit(cypher), params);
        results.push(result.records.map(toPlainObject) as T[]);
      }
      await tx.commit();
      return results;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      await session.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Schema initialisation (idempotent)
// ---------------------------------------------------------------------------

/**
 * Resolve the embedding vector dimension from environment.
 * Matches the logic in lib/embeddings/openai.ts so the vector index is
 * always created with the correct dimension for the selected provider.
 *
 * EMBEDDING_PROVIDER=intelli (default) → 1024 (intelli-embed-v3)
 * EMBEDDING_PROVIDER=azure             → 1536 (Azure text-embedding-3-small)
 * EMBEDDING_PROVIDER=nomic             → 768 (nomic-embed-text-v1.5)
 * EMBEDDING_DIMS override              → whatever is set
 */
function resolveEmbedDim(): number {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "intelli").toLowerCase();
  let defaultDim: string;
  if (provider === "nomic") defaultDim = "768";
  else if (provider === "azure") defaultDim = "1536";
  else defaultDim = "1024"; // intelli-embed-v3
  return parseInt(process.env.EMBEDDING_DIMS ?? defaultDim, 10);
}

function getSchemaStatements(): string[] {
  const dim = resolveEmbedDim();
  return [
    // Node uniqueness constraints
    `CREATE CONSTRAINT ON (u:User) ASSERT u.userId IS UNIQUE`,
    `CREATE CONSTRAINT ON (m:Memory) ASSERT m.id IS UNIQUE`,
    `CREATE CONSTRAINT ON (a:App) ASSERT a.id IS UNIQUE`,
    `CREATE CONSTRAINT ON (e:Entity) ASSERT e.id IS UNIQUE`,

    // VECTOR INDEX on :Memory(embedding) for cosine similarity search
    `CREATE VECTOR INDEX memory_vectors ON :Memory(embedding)
   WITH CONFIG {"dimension": ${dim}, "capacity": 100000, "metric": "cos"}`,

    // TEXT INDEX on :Memory for full-text search (Memgraph text indexes are label-based, no property)
    `CREATE TEXT INDEX memory_text ON :Memory`,

    // Bi-temporal indexes (Spec 01)
    `CREATE INDEX ON :Memory(validAt)`,
    `CREATE INDEX ON :Memory(invalidAt)`,

    // Entity indexes (Spec 04)
    `CREATE INDEX ON :Entity(name)`,
    `CREATE INDEX ON :Entity(type)`,
    `CREATE INDEX ON :Entity(normalizedName)`,
    // userId index speeds up the MERGE pattern ENTITY-DUP-FIX:
    // MERGE (u)-[:HAS_ENTITY]->(e:Entity {normalizedName, userId}) needs both fields.
    `CREATE INDEX ON :Entity(userId)`,

    // VECTOR INDEX on :Entity(descriptionEmbedding) for semantic entity dedup (Spec 04)
    `CREATE VECTOR INDEX entity_vectors ON :Entity(descriptionEmbedding)
   WITH CONFIG {"dimension": ${dim}, "capacity": 10000, "metric": "cos"}`,

    // Community constraint (Spec 07)
    `CREATE CONSTRAINT ON (c:Community) ASSERT c.id IS UNIQUE`,

    // Memory History index — audit trail for ADD/SUPERSEDE/DELETE/ARCHIVE/PAUSE
    `CREATE INDEX ON :MemoryHistory(memoryId)`,
  ];
}


/**
 * Apply all schema DDL statements idempotently.
 * Silently ignores "already exists" errors so it is safe to call on every
 * startup.
 */
export async function initSchema(): Promise<void> {
  for (const stmt of getSchemaStatements()) {
    try {
      await runWrite(stmt, {});
    } catch (err: unknown) {
      // Memgraph raises ClientError when a constraint / index already exists,
      // when existing data violates a new constraint ("violates it"),
      // or when a feature requires an experimental flag (e.g. text-search).
      // All are treated as no-ops — schema is already or cannot-be-in desired state.
      const msg = err instanceof Error ? err.message : String(err);
      const isIgnorable =
        msg.includes("already exists") ||
        msg.includes("violates") ||
        msg.includes("experimental");
      if (!isIgnorable) {
        console.warn("[initSchema] statement failed:", msg.slice(0, 200));
        throw err;
      }
    }
  }
  _vectorIndexVerified = true;
}

// ---------------------------------------------------------------------------
// Lazy vector index verification
// ---------------------------------------------------------------------------

/**
 * Ensure vector indexes exist. Memgraph's vector indexes may be lost after
 * container restarts (they are in-memory HNSW structures). This function
 * checks once per server lifecycle and re-creates them if missing.
 *
 * Safe to call frequently — after the first successful check, subsequent
 * calls are no-ops (no DB roundtrip).
 */
export async function ensureVectorIndexes(): Promise<void> {
  if (_vectorIndexVerified) return;

  try {
    const rows = await runRead(
      `CALL vector_search.show_index_info() YIELD index_name RETURN index_name`
    );
    const existingNames = new Set(
      rows.map((r) => String(r.index_name ?? "").replace(/"/g, ""))
    );

    const dim = resolveEmbedDim();

    if (!existingNames.has("memory_vectors")) {
      console.warn("[ensureVectorIndexes] memory_vectors index missing — re-creating");
      await runWrite(
        `CREATE VECTOR INDEX memory_vectors ON :Memory(embedding)
         WITH CONFIG {"dimension": ${dim}, "capacity": 100000, "metric": "cos"}`,
        {}
      );
    }

    if (!existingNames.has("entity_vectors")) {
      console.warn("[ensureVectorIndexes] entity_vectors index missing — re-creating");
      await runWrite(
        `CREATE VECTOR INDEX entity_vectors ON :Entity(descriptionEmbedding)
         WITH CONFIG {"dimension": ${dim}, "capacity": 10000, "metric": "cos"}`,
        {}
      );
    }

    _vectorIndexVerified = true;
  } catch (err: unknown) {
    // Don't block callers — log and let vector search try anyway
    console.warn("[ensureVectorIndexes] check failed:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

export interface UserNode {
  id: string;
  userId: string;
  createdAt: string;
}

/**
 * MERGE a :User node by userId.
 * Returns the node as a plain object { id, userId, createdAt }.
 */
export async function getOrCreateUserMg(userId: string): Promise<UserNode> {
  const { generateId } = await import("@/lib/id");
  const rows = await runWrite(
    `MERGE (u:User {userId: $userId})
     ON CREATE SET u.id = $uid, u.createdAt = toString(datetime())
     RETURN u.userId AS userId, u.id AS id, u.createdAt AS createdAt`,
    { userId, uid: generateId() }
  );
  if (!rows.length) throw new Error(`Failed to getOrCreateUser for ${userId}`);
  return rows[0] as unknown as UserNode;
}
