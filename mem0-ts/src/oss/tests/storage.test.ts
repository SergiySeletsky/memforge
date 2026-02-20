/// <reference types="jest" />
/**
 * SQLiteManager unit tests.
 * Ported from Python tests/memory/test_storage.py.
 * Uses :memory: SQLite — no real files created.
 */

import { SQLiteManager } from "../src/storage/SQLiteManager";

// SQLiteManager initialises async in constructor; wait for it
async function makeManager(path = ":memory:"): Promise<SQLiteManager> {
  const m = new SQLiteManager(path);
  // give the async init a tick to complete
  await new Promise((r) => setTimeout(r, 20));
  return m;
}

describe("SQLiteManager", () => {
  let manager: SQLiteManager;

  beforeEach(async () => {
    manager = await makeManager();
  });

  afterEach(() => {
    manager.close();
  });

  // ========== Schema / Initialization ==========

  it("should create instance without throwing", () => {
    expect(manager).toBeDefined();
  });

  it("should expose a close() method", () => {
    expect(typeof manager.close).toBe("function");
  });

  // ========== addHistory ==========

  it("should add a history record and return it via getHistory", async () => {
    const memoryId = "mem-001";
    const now = new Date().toISOString();

    await manager.addHistory(memoryId, null, "New memory", "ADD", now);

    const result = await manager.getHistory(memoryId);
    expect(result).toHaveLength(1);

    const row = result[0];
    expect(row.memory_id).toBe(memoryId);
    expect(row.previous_value).toBeNull();
    expect(row.new_value).toBe("New memory");
    expect(row.action).toBe("ADD");
    expect(row.created_at).toBe(now);
    expect(row.is_deleted).toBe(0);
  });

  it("should store old_value → new_value for UPDATE events", async () => {
    const memoryId = "mem-002";
    const now = new Date().toISOString();

    await manager.addHistory(memoryId, "Old content", "New content", "UPDATE", now, now);

    const rows = await manager.getHistory(memoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0].previous_value).toBe("Old content");
    expect(rows[0].new_value).toBe("New content");
    expect(rows[0].updated_at).toBe(now);
  });

  it("should store is_deleted flag", async () => {
    const memoryId = "mem-003";
    const now = new Date().toISOString();

    await manager.addHistory(memoryId, "Old memory", null, "DELETE", now, now, 1);

    const rows = await manager.getHistory(memoryId);
    expect(rows[0].is_deleted).toBe(1);
  });

  it("should generate unique row ids for each record", async () => {
    const memoryId = "mem-004";
    const now = new Date().toISOString();

    await manager.addHistory(memoryId, null, "Memory 0", "ADD", now);
    await manager.addHistory(memoryId, "Memory 0", "Memory 1", "UPDATE", now, now);
    await manager.addHistory(memoryId, "Memory 1", "Memory 2", "UPDATE", now, now);

    const rows = await manager.getHistory(memoryId);
    expect(rows).toHaveLength(3);

    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
  });

  // ========== getHistory ==========

  it("should return empty array for unknown memoryId", async () => {
    const result = await manager.getHistory("does-not-exist");
    expect(result).toEqual([]);
  });

  it("should return all records for a given memoryId", async () => {
    const id1 = "mem-a";
    const id2 = "mem-b";
    const now = new Date().toISOString();

    await manager.addHistory(id1, null, "Memory A1", "ADD", now);
    await manager.addHistory(id1, "Memory A1", "Memory A2", "UPDATE", now, now);
    await manager.addHistory(id2, null, "Memory B", "ADD", now);

    const rowsA = await manager.getHistory(id1);
    const rowsB = await manager.getHistory(id2);

    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(1);
    expect(rowsA.every((r) => r.memory_id === id1)).toBe(true);
    expect(rowsB[0].memory_id).toBe(id2);
  });

  it("should include all expected fields in each record", async () => {
    const memoryId = "mem-fields";
    const now = new Date().toISOString();

    await manager.addHistory(memoryId, "old", "new", "ADD", now, now, 0);
    const rows = await manager.getHistory(memoryId);
    const row = rows[0];

    expect("id" in row).toBe(true);
    expect("memory_id" in row).toBe(true);
    expect("previous_value" in row).toBe(true);
    expect("new_value" in row).toBe(true);
    expect("action" in row).toBe(true);
    expect("created_at" in row).toBe(true);
    expect("updated_at" in row).toBe(true);
    expect("is_deleted" in row).toBe(true);
  });

  it("should isolate records by memoryId", async () => {
    const now = new Date().toISOString();

    for (let i = 0; i < 5; i++) {
      await manager.addHistory(`mem-${i}`, null, `Content ${i}`, "ADD", now);
    }

    for (let i = 0; i < 5; i++) {
      const rows = await manager.getHistory(`mem-${i}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].new_value).toBe(`Content ${i}`);
    }
  });

  // ========== reset ==========

  it("reset() should clear all history records", async () => {
    const now = new Date().toISOString();

    await manager.addHistory("m1", null, "A", "ADD", now);
    await manager.addHistory("m2", null, "B", "ADD", now);
    await manager.addHistory("m1", "A", "C", "UPDATE", now, now);

    await manager.reset();

    expect(await manager.getHistory("m1")).toEqual([]);
    expect(await manager.getHistory("m2")).toEqual([]);
  });

  it("should be usable after reset()", async () => {
    const now = new Date().toISOString();

    await manager.addHistory("m1", null, "First", "ADD", now);
    await manager.reset();
    await manager.addHistory("m1", null, "After reset", "ADD", now);

    const rows = await manager.getHistory("m1");
    expect(rows).toHaveLength(1);
    expect(rows[0].new_value).toBe("After reset");
  });

  // ========== bulk / performance ==========

  it("should handle many records efficiently", async () => {
    const now = new Date().toISOString();
    const count = 200;

    for (let i = 0; i < count; i++) {
      await manager.addHistory(`bulk-mem-${i}`, null, `Content ${i}`, "ADD", now);
    }

    // Spot-check 5 random ones
    for (const i of [0, 49, 99, 149, 199]) {
      const rows = await manager.getHistory(`bulk-mem-${i}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].new_value).toBe(`Content ${i}`);
    }
  });

  it("should accumulate multiple events for the same memory", async () => {
    const memoryId = "multi-event";
    const now = new Date().toISOString();

    await manager.addHistory(memoryId, null, "v1", "ADD", now);
    await manager.addHistory(memoryId, "v1", "v2", "UPDATE", now, now);
    await manager.addHistory(memoryId, "v2", "v3", "UPDATE", now, now);
    await manager.addHistory(memoryId, "v3", null, "DELETE", now, now, 1);

    const rows = await manager.getHistory(memoryId);
    expect(rows).toHaveLength(4);

    const actions = rows.map((r) => r.action);
    expect(actions).toContain("ADD");
    expect(actions).toContain("UPDATE");
    expect(actions).toContain("DELETE");
  });
});
