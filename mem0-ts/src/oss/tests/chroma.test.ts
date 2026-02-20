/// <reference types="jest" />
/**
 * ChromaDB vector store unit tests.
 * Tests the ChromaDB class with a mocked chromadb module.
 */

// Mock the chromadb module
const mockAdd = jest.fn().mockResolvedValue(undefined);
const mockQuery = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockDeleteCollection = jest.fn().mockResolvedValue(undefined);
const mockGetOrCreateCollection = jest.fn().mockResolvedValue({
  add: mockAdd,
  query: mockQuery,
  get: mockGet,
  update: mockUpdate,
  delete: mockDelete,
});

jest.mock("chromadb", () => ({
  ChromaClient: jest.fn().mockImplementation(() => ({
    getOrCreateCollection: mockGetOrCreateCollection,
    deleteCollection: mockDeleteCollection,
  })),
}), { virtual: true });

import { ChromaDB } from "../src/vector_stores/chroma";

describe("ChromaDB Vector Store", () => {
  let store: ChromaDB;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset the mock collection
    mockGetOrCreateCollection.mockResolvedValue({
      add: mockAdd,
      query: mockQuery,
      get: mockGet,
      update: mockUpdate,
      delete: mockDelete,
    });
    store = new ChromaDB({ collectionName: "test-collection", path: "test-db" });
    await store.initialize();
  });

  // ---- Constructor / Initialize ----
  it("should create a client and collection on initialize", async () => {
    expect(mockGetOrCreateCollection).toHaveBeenCalledWith({
      name: "test-collection",
    });
  });

  it("should default collection name to mem0", async () => {
    const s = new ChromaDB({ path: "test-db" } as any);
    await s.initialize();
    expect(mockGetOrCreateCollection).toHaveBeenCalledWith({ name: "mem0" });
  });

  // ---- insert ----
  it("should insert vectors with sanitized metadata", async () => {
    await store.insert(
      [[1, 0, 0]],
      ["id-1"],
      [{ user_id: "u1", memory: "hello", nested: { a: 1 }, nullVal: null }],
    );

    expect(mockAdd).toHaveBeenCalledWith({
      ids: ["id-1"],
      embeddings: [[1, 0, 0]],
      metadatas: [{ user_id: "u1", memory: "hello", nested: '{"a":1}' }],
    });
  });

  it("should strip null/undefined values from metadata", async () => {
    await store.insert(
      [[1, 0, 0]],
      ["id-1"],
      [{ keep: "yes", remove: null, alsoRemove: undefined }],
    );

    const meta = mockAdd.mock.calls[0][0].metadatas[0];
    expect(meta.keep).toBe("yes");
    expect("remove" in meta).toBe(false);
    expect("alsoRemove" in meta).toBe(false);
  });

  // ---- search ----
  it("should search and parse nested query results", async () => {
    mockQuery.mockResolvedValue({
      ids: [["id-1", "id-2"]],
      distances: [[0.1, 0.5]],
      metadatas: [[{ memory: "first" }, { memory: "second" }]],
    });

    const results = await store.search([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("id-1");
    expect(results[0].score).toBe(0.1);
    expect(results[0].payload.memory).toBe("first");
    expect(results[1].id).toBe("id-2");
  });

  it("should pass where clause for filtered search", async () => {
    mockQuery.mockResolvedValue({ ids: [[]], distances: [[]], metadatas: [[]] });

    await store.search([1, 0, 0], 5, { user_id: "u1" });
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.where).toBeDefined();
    expect(callArgs.where.user_id).toEqual({ $eq: "u1" });
  });

  // ---- get ----
  it("should get a single vector by ID", async () => {
    mockGet.mockResolvedValue({
      ids: ["id-1"],
      metadatas: [{ memory: "found" }],
    });

    const result = await store.get("id-1");
    expect(result).toBeDefined();
    expect(result!.id).toBe("id-1");
    expect(result!.payload.memory).toBe("found");
  });

  it("should return null when get finds nothing", async () => {
    mockGet.mockResolvedValue({ ids: [], metadatas: [] });

    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  // ---- update ----
  it("should update with vector and metadata", async () => {
    await store.update("id-1", [0, 1, 0], { memory: "updated" });
    expect(mockUpdate).toHaveBeenCalledWith({
      ids: ["id-1"],
      embeddings: [[0, 1, 0]],
      metadatas: [{ memory: "updated" }],
    });
  });

  it("should update metadata only when vector is null", async () => {
    await store.update("id-1", null, { memory: "meta only" });
    const callArgs = mockUpdate.mock.calls[0][0];
    expect(callArgs.ids).toEqual(["id-1"]);
    expect(callArgs.metadatas).toEqual([{ memory: "meta only" }]);
    expect(callArgs.embeddings).toBeUndefined();
  });

  // ---- delete ----
  it("should delete by ID", async () => {
    await store.delete("id-1");
    expect(mockDelete).toHaveBeenCalledWith({ ids: ["id-1"] });
  });

  // ---- deleteCol ----
  it("should delete the collection", async () => {
    await store.deleteCol();
    expect(mockDeleteCollection).toHaveBeenCalledWith({
      name: "test-collection",
    });
  });

  // ---- list ----
  it("should list vectors", async () => {
    mockGet.mockResolvedValue({
      ids: ["a", "b"],
      metadatas: [{ memory: "a" }, { memory: "b" }],
    });

    const [results, count] = await store.list(undefined, 100);
    expect(results).toHaveLength(2);
    expect(count).toBe(2);
  });

  it("should list with filters", async () => {
    mockGet.mockResolvedValue({
      ids: ["a"],
      metadatas: [{ memory: "a", user_id: "u1" }],
    });

    await store.list({ user_id: "u1" }, 10);
    const callArgs = mockGet.mock.calls[0][0];
    expect(callArgs.where).toBeDefined();
  });

  // ---- reset ----
  it("should reset by deleting and recreating collection", async () => {
    const callsBefore = mockGetOrCreateCollection.mock.calls.length;
    await store.reset();
    expect(mockDeleteCollection).toHaveBeenCalledWith({
      name: "test-collection",
    });
    expect(mockGetOrCreateCollection.mock.calls.length).toBe(callsBefore + 1);
  });

  // ---- getUserId / setUserId ----
  it("should get/set userId", async () => {
    await store.setUserId("u1");
    const uid = await store.getUserId();
    expect(uid).toBe("u1");
  });

  // ---- where clause building ----
  describe("buildWhereClause", () => {
    beforeEach(() => {
      mockQuery.mockResolvedValue({
        ids: [[]],
        distances: [[]],
        metadatas: [[]],
      });
    });

    it("should handle simple equality", async () => {
      await store.search([1, 0, 0], 5, { status: "active" });
      const where = mockQuery.mock.calls[0][0].where;
      expect(where.status).toEqual({ $eq: "active" });
    });

    it("should handle comparison operators", async () => {
      await store.search([1, 0, 0], 5, { age: { gt: 18 } } as any);
      const where = mockQuery.mock.calls[0][0].where;
      expect(where.age).toEqual({ $gt: 18 });
    });

    it("should handle OR operator", async () => {
      await store.search([1, 0, 0], 5, {
        OR: [{ status: "active" }, { status: "pending" }],
      } as any);
      const where = mockQuery.mock.calls[0][0].where;
      expect(where.$or).toBeDefined();
      expect(where.$or).toHaveLength(2);
    });

    it("should skip wildcard values", async () => {
      await store.search([1, 0, 0], 5, { user_id: "*" } as any);
      // When wildcard is skipped, no where clause should be passed
      const callArgs = mockQuery.mock.calls[0][0];
      // Empty or no where clause
      expect(
        callArgs.where === undefined || Object.keys(callArgs.where).length === 0,
      ).toBe(true);
    });
  });
});
