/**
 * SPEC 00 — Memgraph data layer unit tests
 *
 * These tests define the contract for the new Memgraph layer.
 * They FAIL before implementation (Spec 00) and PASS after.
 *
 * All neo4j-driver calls are mocked — no running Memgraph needed.
 */

// Make this a TypeScript module to scope declarations (avoids TS2451)
export {};

// --- Mock neo4j-driver ---
const mockTx = {
  run: jest.fn(),
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
};

const mockSession = {
  run: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
  readTransaction: jest.fn(),
  writeTransaction: jest.fn(),
  beginTransaction: jest.fn().mockReturnValue(mockTx),
};

const mockDriver = {
  session: jest.fn().mockReturnValue(mockSession),
  close: jest.fn().mockResolvedValue(undefined),
  verifyConnectivity: jest.fn().mockResolvedValue(undefined),
};

jest.mock("neo4j-driver", () => ({
  // __esModule: true prevents esModuleInterop from double-wrapping the default export
  __esModule: true,
  default: {
    driver: jest.fn().mockReturnValue(mockDriver),
    auth: { basic: jest.fn().mockReturnValue({ scheme: "basic", principal: "neo4j", credentials: "test" }) },
    integer: { toNumber: (n: any) => (typeof n === "object" ? n.low ?? n : n) },
    types: { Node: class {}, Relationship: class {} },
  },
}));

function makeRecord(data: Record<string, any>) {
  return {
    keys: Object.keys(data),
    get: (key: string) => {
      const val = data[key];
      if (typeof val === "number" && Number.isInteger(val)) {
        return { low: val, high: 0, toNumber: () => val };
      }
      return val;
    },
    toObject: () => data,
  };
}

// --- Tests ---
describe("SPEC 00: Memgraph layer contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  // ---- Connection ----
  test("MG_01: getDriver() returns a singleton neo4j-driver instance", async () => {
    const { getDriver } = require("@/lib/db/memgraph");
    const d1 = getDriver();
    const d2 = getDriver();
    expect(d1).toBe(d2);
    const neo4j = require("neo4j-driver").default;
    expect(neo4j.driver).toHaveBeenCalledTimes(1);
    expect(neo4j.driver).toHaveBeenCalledWith(
      expect.stringContaining("bolt://"),
      expect.anything(),
      expect.any(Object)
    );
  });

  test("MG_02: runRead() calls session.run and returns deserialized records", async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [makeRecord({ id: "abc", content: "hello world" })],
      summary: {},
    });

    const { runRead } = require("@/lib/db/memgraph");
    const result = await runRead("MATCH (m:Memory {id: $id}) RETURN m.id AS id, m.content AS content", { id: "abc" });

    expect(mockSession.run).toHaveBeenCalledWith(
      "MATCH (m:Memory {id: $id}) RETURN m.id AS id, m.content AS content",
      { id: "abc" }
    );
    expect(result).toEqual([{ id: "abc", content: "hello world" }]);
    expect(mockSession.close).toHaveBeenCalled();
  });

  test("MG_03: runWrite() calls session.run in a write session and closes it", async () => {
    mockSession.run.mockResolvedValueOnce({ records: [], summary: {} });

    const { runWrite } = require("@/lib/db/memgraph");
    await runWrite("CREATE (u:User {userId: $uid})", { uid: "user-1" });

    expect(mockSession.run).toHaveBeenCalledWith(
      "CREATE (u:User {userId: $uid})",
      { uid: "user-1" }
    );
    expect(mockSession.close).toHaveBeenCalled();
  });

  test("MG_04: runRead() closes session even when query throws", async () => {
    mockSession.run.mockRejectedValueOnce(new Error("Cypher syntax error"));

    const { runRead } = require("@/lib/db/memgraph");
    await expect(
      runRead("INVALID CYPHER", {})
    ).rejects.toThrow("Cypher syntax error");
    expect(mockSession.close).toHaveBeenCalled();
  });

  // ---- Schema initialization ----
  test("MG_05: initSchema() creates vector index on :Memory(embedding)", async () => {
    mockSession.run.mockResolvedValue({ records: [], summary: {} });

    const { initSchema } = require("@/lib/db/memgraph");
    await initSchema();

    const allCalls: string[] = mockSession.run.mock.calls.map((c: any[]) => c[0] as string);
    const vectorIndexCall = allCalls.find(q => q.includes("VECTOR INDEX") && q.includes(":Memory") && q.includes("embedding"));
    expect(vectorIndexCall).toBeDefined();
  });

  test("MG_06: initSchema() creates text index on :Memory", async () => {
    mockSession.run.mockResolvedValue({ records: [], summary: {} });

    const { initSchema } = require("@/lib/db/memgraph");
    await initSchema();

    const allCalls: string[] = mockSession.run.mock.calls.map((c: any[]) => c[0] as string);
    const textIndexCall = allCalls.find(q => q.includes("TEXT INDEX") && q.includes(":Memory"));
    expect(textIndexCall).toBeDefined();
  });

  test("MG_07: initSchema() creates UNIQUE constraint on User.userId", async () => {
    mockSession.run.mockResolvedValue({ records: [], summary: {} });

    const { initSchema } = require("@/lib/db/memgraph");
    await initSchema();

    const allCalls: string[] = mockSession.run.mock.calls.map((c: any[]) => c[0] as string);
    const constraintCall = allCalls.find(q =>
      q.toLowerCase().includes("constraint") &&
      q.includes("User") &&
      q.includes("userId")
    );
    expect(constraintCall).toBeDefined();
  });

  // ---- Graph helpers ----
  test("MG_08: getOrCreateUser() MERGEs a User node and returns it", async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [makeRecord({ userId: "alice", id: "uuid-alice", createdAt: "2026-01-01T00:00:00.000Z" })],
      summary: {},
    });

    const { getOrCreateUserMg } = require("@/lib/db/memgraph");
    const user = await getOrCreateUserMg("alice");

    expect(user.userId).toBe("alice");
    const query: string = mockSession.run.mock.calls[0][0];
    expect(query.toUpperCase()).toContain("MERGE");
    expect(query).toContain(":User");
  });

  test("MG_09: user-scoped memory query is structurally isolated by graph traversal", async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        makeRecord({ id: "mem-1", content: "Test memory" }),
      ],
      summary: {},
    });

    const { runRead } = require("@/lib/db/memgraph");
    // The canonical pattern: anchor to User node
    await runRead(
      `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
       WHERE m.invalidAt IS NULL AND m.state <> 'deleted'
       RETURN m.id AS id, m.content AS content`,
      { userId: "alice" }
    );

    // Verify the call anchors to User (structural isolation)
    const query: string = mockSession.run.mock.calls[0][0];
    expect(query).toContain("(u:User {userId: $userId})");
    expect(query).toContain("[:HAS_MEMORY]");
    expect(query).toContain("m.invalidAt IS NULL");
  });

  // ---- closeDriver ----
  test("MG_10: closeDriver() calls driver.close() and clears the singleton", async () => {
    const { getDriver, closeDriver } = require("@/lib/db/memgraph");

    // Create the singleton
    getDriver();
    expect(mockDriver.close).not.toHaveBeenCalled();

    await closeDriver();
    expect(mockDriver.close).toHaveBeenCalledTimes(1);

    // After close, getDriver() should create a new instance
    const neo4j = require("neo4j-driver").default;
    const callsBefore = neo4j.driver.mock.calls.length;
    getDriver();
    expect(neo4j.driver.mock.calls.length).toBe(callsBefore + 1);
  });

  test("MG_11: closeDriver() is a no-op if driver was never created", async () => {
    // Clear any driver that a previous test may have stored on globalThis so
    // that this module instance truly sees no driver.
    (globalThis as { __memgraphDriver?: unknown }).__memgraphDriver = null;

    const { closeDriver } = require("@/lib/db/memgraph");
    // Should not throw even though _driver is null
    await expect(closeDriver()).resolves.not.toThrow();
    expect(mockDriver.close).not.toHaveBeenCalled();
  });

  // ---- initSchema error handling ----
  test('MG_12: initSchema() ignores errors containing "violates"', async () => {
    mockSession.run
      .mockResolvedValueOnce({ records: [], summary: {} })
      .mockRejectedValueOnce(new Error("Existing data violates it"))
      .mockResolvedValue({ records: [], summary: {} });

    const { initSchema } = require("@/lib/db/memgraph");
    await expect(initSchema()).resolves.not.toThrow();
  });

  test('MG_13: initSchema() ignores errors containing "experimental"', async () => {
    mockSession.run
      .mockResolvedValueOnce({ records: [], summary: {} })
      .mockRejectedValueOnce(new Error("Feature requires experimental flag"))
      .mockResolvedValue({ records: [], summary: {} });

    const { initSchema } = require("@/lib/db/memgraph");
    await expect(initSchema()).resolves.not.toThrow();
  });

  test("MG_14: initSchema() rethrows non-ignorable errors", async () => {
    mockSession.run.mockRejectedValueOnce(new Error("Out of memory"));

    const { initSchema } = require("@/lib/db/memgraph");
    await expect(initSchema()).rejects.toThrow("Out of memory");
  });

  // ---- ensureVectorIndexes ----
  test("MG_15: ensureVectorIndexes() is a no-op when both indexes exist", async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        makeRecord({ index_name: "memory_vectors" }),
        makeRecord({ index_name: "entity_vectors" }),
      ],
      summary: {},
    });

    const { ensureVectorIndexes } = require("@/lib/db/memgraph");
    await ensureVectorIndexes();

    // Only the show_index_info call, no CREATE calls
    const allCalls: string[] = mockSession.run.mock.calls.map((c: any[]) => c[0] as string);
    expect(allCalls.some((q: string) => q.includes("vector_search.show_index_info"))).toBe(true);
    expect(allCalls.some((q: string) => q.includes("CREATE VECTOR INDEX"))).toBe(false);
  });

  test("MG_16: ensureVectorIndexes() re-creates memory_vectors when missing", async () => {
    // show_index_info returns only entity_vectors
    mockSession.run
      .mockResolvedValueOnce({
        records: [makeRecord({ index_name: "entity_vectors" })],
        summary: {},
      })
      // CREATE VECTOR INDEX memory_vectors
      .mockResolvedValueOnce({ records: [], summary: {} });

    const { ensureVectorIndexes } = require("@/lib/db/memgraph");
    await ensureVectorIndexes();

    const allCalls: string[] = mockSession.run.mock.calls.map((c: any[]) => c[0] as string);
    const createCall = allCalls.find((q: string) => q.includes("CREATE VECTOR INDEX") && q.includes("memory_vectors"));
    expect(createCall).toBeDefined();
  });

  test("MG_17: ensureVectorIndexes() re-creates entity_vectors when missing", async () => {
    // show_index_info returns only memory_vectors
    mockSession.run
      .mockResolvedValueOnce({
        records: [makeRecord({ index_name: "memory_vectors" })],
        summary: {},
      })
      // CREATE VECTOR INDEX entity_vectors
      .mockResolvedValueOnce({ records: [], summary: {} });

    const { ensureVectorIndexes } = require("@/lib/db/memgraph");
    await ensureVectorIndexes();

    const allCalls: string[] = mockSession.run.mock.calls.map((c: any[]) => c[0] as string);
    const createCall = allCalls.find((q: string) => q.includes("CREATE VECTOR INDEX") && q.includes("entity_vectors"));
    expect(createCall).toBeDefined();
  });

  test("MG_18: ensureVectorIndexes() re-creates both indexes when none exist", async () => {
    // show_index_info returns empty
    mockSession.run
      .mockResolvedValueOnce({ records: [], summary: {} })
      // CREATE memory_vectors
      .mockResolvedValueOnce({ records: [], summary: {} })
      // CREATE entity_vectors
      .mockResolvedValueOnce({ records: [], summary: {} });

    const { ensureVectorIndexes } = require("@/lib/db/memgraph");
    await ensureVectorIndexes();

    const allCalls: string[] = mockSession.run.mock.calls.map((c: any[]) => c[0] as string);
    expect(allCalls.filter((q: string) => q.includes("CREATE VECTOR INDEX")).length).toBe(2);
  });

  test("MG_19: ensureVectorIndexes() skips DB call on second invocation (cached)", async () => {
    // First call: indexes exist
    mockSession.run.mockResolvedValueOnce({
      records: [
        makeRecord({ index_name: "memory_vectors" }),
        makeRecord({ index_name: "entity_vectors" }),
      ],
      summary: {},
    });

    const { ensureVectorIndexes } = require("@/lib/db/memgraph");
    await ensureVectorIndexes();
    const callsAfterFirst = mockSession.run.mock.calls.length;

    // Second call should be a no-op (cached flag)
    await ensureVectorIndexes();
    expect(mockSession.run.mock.calls.length).toBe(callsAfterFirst);
  });

  test("MG_20: ensureVectorIndexes() logs warning and does not throw on failure", async () => {
    mockSession.run.mockRejectedValueOnce(new Error("query modules not loaded"));

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const { ensureVectorIndexes } = require("@/lib/db/memgraph");
    await expect(ensureVectorIndexes()).resolves.not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ensureVectorIndexes]"),
      expect.stringContaining("query modules not loaded"),
    );
    warnSpy.mockRestore();
  });

  // ---- withRetry resilience (MG_RETRY) ----
  // setTimeout is patched to fire immediately so retry delays do not slow tests.

  function noDelaySetTimeout() {
    jest.spyOn(global, "setTimeout").mockImplementation((fn: any) => { fn(); return 0 as any; });
  }

  test('MG_RETRY_01: runWrite() retries on "Connection was closed by server" and succeeds on 2nd attempt', async () => {
    noDelaySetTimeout();
    mockSession.run
      .mockRejectedValueOnce(new Error("Connection was closed by server"))
      .mockResolvedValueOnce({ records: [], summary: {} });

    const { runWrite } = require("@/lib/db/memgraph");
    await expect(runWrite("CREATE (n)", {})).resolves.not.toThrow();

    // session.run called twice — first attempt failed, second succeeded
    expect(mockSession.run).toHaveBeenCalledTimes(2);
  });

  test('MG_RETRY_02: runWrite() retries on "Tantivy error: index writer was killed"', async () => {
    noDelaySetTimeout();
    mockSession.run
      .mockRejectedValueOnce(new Error(
        "Tantivy error: Unable to add document -> An error occurred in a thread: An index writer was killed"
      ))
      .mockResolvedValueOnce({ records: [], summary: {} });

    const { runWrite } = require("@/lib/db/memgraph");
    await expect(runWrite("CREATE (n)", {})).resolves.not.toThrow();
    expect(mockSession.run).toHaveBeenCalledTimes(2);
  });

  test('MG_RETRY_03: runRead() retries on transient "ServiceUnavailable" error', async () => {
    noDelaySetTimeout();
    mockSession.run
      .mockRejectedValueOnce(new Error("ServiceUnavailable"))
      .mockResolvedValueOnce({ records: [{ keys: ["id"], get: () => "a", toObject: () => ({ id: "a" }) }], summary: {} });

    const { runRead } = require("@/lib/db/memgraph");
    const result: Array<{ id: string }> = await runRead("MATCH (n) RETURN n.id AS id", {});

    expect(result).toEqual([{ id: "a" }]);
    expect(mockSession.run).toHaveBeenCalledTimes(2);
  });

  test("MG_RETRY_04: non-transient errors (Cypher syntax) are NOT retried", async () => {
    noDelaySetTimeout();
    mockSession.run.mockRejectedValue(new Error("SyntaxError: Invalid Cypher statement"));

    const { runWrite } = require("@/lib/db/memgraph");
    await expect(runWrite("INVALID CYPHER", {})).rejects.toThrow("SyntaxError");

    // Only 1 attempt — non-transient, no retry
    expect(mockSession.run).toHaveBeenCalledTimes(1);
  });

  test("MG_RETRY_05: after 3 consecutive transient failures the final error is propagated", async () => {
    noDelaySetTimeout();
    const transientErr = new Error("Connection was closed by server");
    mockSession.run
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(transientErr);

    const { runWrite } = require("@/lib/db/memgraph");
    await expect(runWrite("CREATE (n)", {})).rejects.toThrow("Connection was closed by server");

    // 3 attempts total (max 3)
    expect(mockSession.run).toHaveBeenCalledTimes(3);
  });

  test("MG_RETRY_06: driver is invalidated (globalThis cache cleared) on connection-level error", async () => {
    noDelaySetTimeout();
    // First call: connection error; second: succeeds (driver recreated)
    const neo4j = require("neo4j-driver").default;
    const driverCallsBefore = neo4j.driver.mock.calls.length;

    mockSession.run
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ records: [], summary: {} });

    const { runWrite } = require("@/lib/db/memgraph");
    await runWrite("CREATE (n)", {});

    // Driver must have been re-created (invalidated and re-initialised)
    expect(neo4j.driver.mock.calls.length).toBeGreaterThan(driverCallsBefore);
  });

  test("MG_DRV_01: getDriver() stores singleton on globalThis (survives module cache invalidation)", async () => {
    const { getDriver } = require("@/lib/db/memgraph");
    const d1 = getDriver();

    // Simulate HMR: drop the module from the registry and re-import
    jest.resetModules();
    const { getDriver: getDriver2 } = require("@/lib/db/memgraph");
    const d2 = getDriver2();

    // Both calls should return the same driver instance (stored on globalThis)
    expect(d1).toBe(d2);
  });

  // ---- runTransaction (DB-01) ----
  test("MG_TX_01: runTransaction() executes all steps in order and calls commit", async () => {
    mockTx.run
      .mockResolvedValueOnce({ records: [makeRecord({ a: "val-a" })], summary: {} })
      .mockResolvedValueOnce({ records: [makeRecord({ b: "val-b" })], summary: {} });

    const { runTransaction } = require("@/lib/db/memgraph");
    const results = await runTransaction([
      { cypher: "CREATE (a:Foo) RETURN 'val-a' AS a", params: {} },
      { cypher: "CREATE (b:Bar) RETURN 'val-b' AS b", params: {} },
    ]);

    // Both steps return deserialized rows
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([{ a: "val-a" }]);
    expect(results[1]).toEqual([{ b: "val-b" }]);

    // All Cypher ran through the tx
    expect(mockTx.run).toHaveBeenCalledTimes(2);
    // Transaction committed
    expect(mockTx.commit).toHaveBeenCalledTimes(1);
    // Rollback NOT called on success
    expect(mockTx.rollback).not.toHaveBeenCalled();
    // Session closed
    expect(mockSession.close).toHaveBeenCalled();
  });

  test("MG_TX_02: runTransaction() rolls back when a step throws", async () => {
    mockTx.run
      .mockResolvedValueOnce({ records: [], summary: {} })
      .mockRejectedValueOnce(new Error("constraint violation"));

    const { runTransaction } = require("@/lib/db/memgraph");
    await expect(
      runTransaction([
        { cypher: "MERGE (u:User {id: $id})", params: { id: "x" } },
        { cypher: "MERGE (u:User {id: $id})", params: { id: "x" } }, // duplicate
      ])
    ).rejects.toThrow("constraint violation");

    expect(mockTx.rollback).toHaveBeenCalledTimes(1);
    expect(mockTx.commit).not.toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalled();
  });

  test("MG_TX_03: runTransaction() closes session even when commit throws", async () => {
    mockTx.run.mockResolvedValueOnce({ records: [], summary: {} });
    mockTx.commit.mockRejectedValueOnce(new Error("commit failed"));

    const { runTransaction } = require("@/lib/db/memgraph");
    await expect(
      runTransaction([{ cypher: "CREATE (n)", params: {} }])
    ).rejects.toThrow("commit failed");

    expect(mockSession.close).toHaveBeenCalled();
  });
});
