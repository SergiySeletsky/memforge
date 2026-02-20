/// <reference types="jest" />
/**
 * MemoryVectorStore unit tests.
 * Tests the in-memory vector store CRUD, search, filtering, and reset.
 * No external dependencies needed.
 */

import { MemoryVectorStore } from "../src/vector_stores/memory";

describe("MemoryVectorStore", () => {
  let store: MemoryVectorStore;

  beforeEach(async () => {
    store = new MemoryVectorStore({
      collectionName: "test-collection",
      dimension: 4,
      dbPath: ":memory:",
    });
    await store.initialize();
  });

  // ---- insert / get ----
  it("should insert and retrieve a vector", async () => {
    await store.insert([[1, 0, 0, 0]], ["id-1"], [{ user_id: "u1", memory: "hello" }]);
    const result = await store.get("id-1");
    expect(result).toBeDefined();
    expect(result!.id).toBe("id-1");
    expect(result!.payload.memory).toBe("hello");
  });

  it("should return null for non-existent id", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  // ---- insert multiple ----
  it("should insert multiple vectors", async () => {
    await store.insert(
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
      ],
      ["a", "b", "c"],
      [
        { user_id: "u1", memory: "a" },
        { user_id: "u1", memory: "b" },
        { user_id: "u2", memory: "c" },
      ],
    );

    expect(await store.get("a")).toBeDefined();
    expect(await store.get("b")).toBeDefined();
    expect(await store.get("c")).toBeDefined();
  });

  // ---- search ----
  it("should search with cosine similarity", async () => {
    await store.insert(
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0.9, 0.1, 0, 0],
      ],
      ["a", "b", "c"],
      [
        { user_id: "u1", memory: "first" },
        { user_id: "u1", memory: "second" },
        { user_id: "u1", memory: "similar to first" },
      ],
    );

    const results = await store.search([1, 0, 0, 0], 2);
    expect(results.length).toBeLessThanOrEqual(2);
    // The most similar should be "a" (exact match) or "c" (close)
    expect(results[0].id).toBe("a");
  });

  it("should filter search by user_id", async () => {
    await store.insert(
      [
        [1, 0, 0, 0],
        [0.9, 0.1, 0, 0],
      ],
      ["a", "b"],
      [
        { user_id: "u1", memory: "first" },
        { user_id: "u2", memory: "second" },
      ],
    );

    const results = await store.search([1, 0, 0, 0], 10, { user_id: "u2" });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("b");
  });

  // ---- update ----
  it("should update vector and payload", async () => {
    await store.insert([[1, 0, 0, 0]], ["id-1"], [{ memory: "original" }]);
    await store.update("id-1", [0, 1, 0, 0], { memory: "updated" });

    const result = await store.get("id-1");
    expect(result!.payload.memory).toBe("updated");
  });

  it("should update payload along with a new vector", async () => {
    await store.insert([[1, 0, 0, 0]], ["id-1"], [{ memory: "original" }]);
    await store.update("id-1", [0, 0, 1, 0], { memory: "just payload" });

    const result = await store.get("id-1");
    expect(result!.payload.memory).toBe("just payload");
  });

  // ---- delete ----
  it("should delete a vector", async () => {
    await store.insert([[1, 0, 0, 0]], ["id-1"], [{ memory: "hello" }]);
    await store.delete("id-1");
    const result = await store.get("id-1");
    expect(result).toBeNull();
  });

  // ---- list ----
  it("should list all vectors", async () => {
    await store.insert(
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
      ["a", "b"],
      [
        { user_id: "u1", memory: "first" },
        { user_id: "u1", memory: "second" },
      ],
    );

    const [results, count] = await store.list(undefined, 100);
    expect(count).toBe(2);
    expect(results).toHaveLength(2);
  });

  it("should list with filters", async () => {
    await store.insert(
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
      ],
      ["a", "b", "c"],
      [
        { user_id: "u1", memory: "a" },
        { user_id: "u2", memory: "b" },
        { user_id: "u1", memory: "c" },
      ],
    );

    const [results] = await store.list({ user_id: "u1" }, 100);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.payload.user_id === "u1")).toBe(true);
  });

  it("should respect list limit", async () => {
    await store.insert(
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
      ],
      ["a", "b", "c"],
      [{ memory: "a" }, { memory: "b" }, { memory: "c" }],
    );

    const [results] = await store.list(undefined, 2);
    expect(results).toHaveLength(2);
  });

  // ---- deleteCol ----
  it("should delete all vectors on deleteCol", async () => {
    await store.insert(
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
      ["a", "b"],
      [{ memory: "a" }, { memory: "b" }],
    );

    await store.deleteCol();
    const [results] = await store.list(undefined, 100);
    expect(results).toHaveLength(0);
  });

  // ---- no reset on MemoryVectorStore (reset is on Memory class) ----
  // MemoryVectorStore uses deleteCol() instead

  // ---- getUserId / setUserId ----
  it("should get and set userId", async () => {
    await store.setUserId("test-user");
    const userId = await store.getUserId();
    expect(userId).toBe("test-user");
  });
});
