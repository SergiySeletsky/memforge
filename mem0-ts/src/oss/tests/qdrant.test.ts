/// <reference types="jest" />
/**
 * Qdrant vector store unit tests.
 * Ported from Python tests/vector_stores/test_qdrant.py.
 * All QdrantClient calls are mocked — no real Qdrant instance needed.
 */

// ---- mock QdrantClient ----
const mockUpsert = jest.fn().mockResolvedValue(undefined);
const mockSearch = jest.fn();
const mockRetrieve = jest.fn();
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockDeleteCollection = jest.fn().mockResolvedValue(undefined);
const mockScroll = jest.fn();
const mockGetCollections = jest.fn().mockResolvedValue({ collections: [] });
const mockCreateCollection = jest.fn().mockResolvedValue(undefined);
const mockGetCollection = jest.fn().mockResolvedValue({});

jest.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({
    upsert: mockUpsert,
    search: mockSearch,
    retrieve: mockRetrieve,
    delete: mockDelete,
    deleteCollection: mockDeleteCollection,
    scroll: mockScroll,
    getCollections: mockGetCollections,
    createCollection: mockCreateCollection,
    getCollection: mockGetCollection,
  })),
}));

import { Qdrant } from "../src/vector_stores/qdrant";

function makeQdrant(collectionName = "test_collection"): Qdrant {
  return new Qdrant({
    collectionName,
    embeddingModelDims: 128,
    dimension: 128,
    path: ":memory:",
  });
}

describe("Qdrant Vector Store", () => {
  let qdrant: Qdrant;

  beforeEach(() => {
    jest.clearAllMocks();
    // initialize() resolves getCollections → [] → createCollection
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue(undefined);
    qdrant = makeQdrant();
  });

  // ========== insert ==========

  it("should upsert points on insert", async () => {
    const vectors = [[0.1, 0.2], [0.3, 0.4]];
    const payloads = [{ key: "val1" }, { key: "val2" }];
    const ids = ["id-a", "id-b"];

    await qdrant.insert(vectors, ids, payloads);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const callArgs = mockUpsert.mock.calls[0];
    expect(callArgs[0]).toBe("test_collection");
    const points = callArgs[1].points;
    expect(points).toHaveLength(2);
    expect(points[0].id).toBe("id-a");
    expect(points[0].vector).toEqual([0.1, 0.2]);
    expect(points[0].payload).toEqual({ key: "val1" });
    expect(points[1].id).toBe("id-b");
  });

  // ========== search ==========

  it("should call client.search with correct args", async () => {
    mockSearch.mockResolvedValue([
      { id: "id-x", score: 0.95, payload: { key: "value" } },
    ]);

    const results = await qdrant.search([0.1, 0.2], 1);

    expect(mockSearch).toHaveBeenCalledTimes(1);
    const args = mockSearch.mock.calls[0];
    expect(args[0]).toBe("test_collection");
    expect(args[1].vector).toEqual([0.1, 0.2]);
    expect(args[1].limit).toBe(1);

    expect(results).toHaveLength(1);
    expect(results[0].payload).toEqual({ key: "value" });
    expect(results[0].score).toBe(0.95);
  });

  it("should pass no filter when filters is undefined", async () => {
    mockSearch.mockResolvedValue([]);

    await qdrant.search([0.1], 5, undefined);

    const args = mockSearch.mock.calls[0][1];
    expect(args.filter).toBeUndefined();
  });

  it("should pass no filter when filters is empty object", async () => {
    mockSearch.mockResolvedValue([]);

    await qdrant.search([0.1], 5, {});

    const args = mockSearch.mock.calls[0][1];
    expect(args.filter).toBeUndefined();
  });

  it("should build single-field filter for search", async () => {
    mockSearch.mockResolvedValue([
      { id: "id-1", score: 0.9, payload: { userId: "alice" } },
    ]);

    await qdrant.search([0.1], 5, { userId: "alice" });

    const args = mockSearch.mock.calls[0][1];
    expect(args.filter).toBeDefined();
    expect(args.filter.must).toHaveLength(1);
    expect(args.filter.must[0].key).toBe("userId");
    expect(args.filter.must[0].match.value).toBe("alice");
  });

  it("should build multi-field filter (userId + agentId + runId)", async () => {
    mockSearch.mockResolvedValue([]);

    await qdrant.search([0.1], 5, { userId: "alice", agentId: "agent1", runId: "run1" });

    const args = mockSearch.mock.calls[0][1];
    const must = args.filter.must;
    expect(must).toHaveLength(3);

    const keys = must.map((c: any) => c.key);
    expect(keys).toContain("userId");
    expect(keys).toContain("agentId");
    expect(keys).toContain("runId");
  });

  it("should build range filter for comparison operators", async () => {
    mockSearch.mockResolvedValue([]);

    await qdrant.search([0.1], 5, { score: { gte: 5, lte: 10 } });

    const args = mockSearch.mock.calls[0][1];
    const must = args.filter.must;
    // TS emits separate conditions for each operator (gte → one, lte → another)
    expect(must.length).toBeGreaterThanOrEqual(1);
    const rangeConditions = must.filter((c: any) => c.key === "score" && c.range);
    expect(rangeConditions.length).toBeGreaterThanOrEqual(1);
    const rangeKeys = rangeConditions.flatMap((c: any) => Object.keys(c.range));
    expect(rangeKeys).toContain("gte");
    expect(rangeKeys).toContain("lte");
  });

  it("should build must_not for ne operator", async () => {
    mockSearch.mockResolvedValue([]);

    await qdrant.search([0.1], 5, { status: { ne: "deleted" } });

    const args = mockSearch.mock.calls[0][1];
    expect(args.filter.must_not).toHaveLength(1);
    expect(args.filter.must_not[0].key).toBe("status");
    expect(args.filter.must_not[0].match.value).toBe("deleted");
  });

  it("should skip wildcard values in filters", async () => {
    mockSearch.mockResolvedValue([]);

    await qdrant.search([0.1], 5, { userId: "*" });

    const args = mockSearch.mock.calls[0][1];
    expect(args.filter).toBeUndefined();
  });

  // ========== get ==========

  it("should retrieve a single vector by id", async () => {
    const vectorId = "vec-001";
    mockRetrieve.mockResolvedValue([{ id: vectorId, payload: { key: "value" } }]);

    const result = await qdrant.get(vectorId);

    expect(mockRetrieve).toHaveBeenCalledWith("test_collection", {
      ids: [vectorId],
      with_payload: true,
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe(vectorId);
    expect(result!.payload).toEqual({ key: "value" });
  });

  it("should return null when vector not found", async () => {
    mockRetrieve.mockResolvedValue([]);

    const result = await qdrant.get("nonexistent");
    expect(result).toBeNull();
  });

  // ========== update ==========

  it("should upsert on update with new vector and payload", async () => {
    const vectorId = "vec-update";
    const vector = [0.2, 0.3];
    const payload = { key: "updated_value" };

    await qdrant.update(vectorId, vector, payload);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const point = mockUpsert.mock.calls[0][1].points[0];
    expect(point.id).toBe(vectorId);
    expect(point.vector).toEqual(vector);
    expect(point.payload).toEqual(payload);
  });

  // ========== delete ==========

  it("should call client.delete with the vector id", async () => {
    const vectorId = "vec-to-delete";

    await qdrant.delete(vectorId);

    expect(mockDelete).toHaveBeenCalledWith("test_collection", {
      points: [vectorId],
    });
  });

  // ========== deleteCol ==========

  it("should call deleteCollection on deleteCol()", async () => {
    await qdrant.deleteCol();

    expect(mockDeleteCollection).toHaveBeenCalledWith("test_collection");
  });

  // ========== list ==========

  it("should scroll with no filter when filters is undefined", async () => {
    mockScroll.mockResolvedValue({
      points: [{ id: "p1", payload: { key: "v" } }],
    });

    const [results, count] = await qdrant.list(undefined, 10);

    expect(mockScroll).toHaveBeenCalledTimes(1);
    const scrollArgs = mockScroll.mock.calls[0][1];
    expect(scrollArgs.filter).toBeUndefined();
    expect(scrollArgs.limit).toBe(10);
    expect(results).toHaveLength(1);
    expect(count).toBe(1);
  });

  it("should scroll with filter for list with userId", async () => {
    mockScroll.mockResolvedValue({
      points: [{ id: "p1", payload: { userId: "alice" } }],
    });

    const [results] = await qdrant.list({ userId: "alice" }, 10);

    const scrollArgs = mockScroll.mock.calls[0][1];
    expect(scrollArgs.filter).toBeDefined();
    expect(scrollArgs.filter.must).toHaveLength(1);
    expect(scrollArgs.filter.must[0].key).toBe("userId");

    expect(results[0].payload.userId).toBe("alice");
  });

  it("should build multi-field filter for list", async () => {
    mockScroll.mockResolvedValue({
      points: [{ id: "p1", payload: { userId: "alice", agentId: "a1", runId: "r1" } }],
    });

    await qdrant.list({ userId: "alice", agentId: "a1", runId: "r1" }, 10);

    const scrollArgs = mockScroll.mock.calls[0][1];
    expect(scrollArgs.filter.must).toHaveLength(3);
  });

  it("should return empty results and zero count when collection is empty", async () => {
    mockScroll.mockResolvedValue({ points: [] });

    const [results, count] = await qdrant.list(undefined, 100);

    expect(results).toEqual([]);
    expect(count).toBe(0);
  });

  // ========== initialize ==========

  it("should call createCollection when collection does not exist", async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue(undefined);

    const q = new Qdrant({ collectionName: "new-col", embeddingModelDims: 64, dimension: 64 });
    await new Promise((r) => setTimeout(r, 20)); // let async init run

    expect(mockCreateCollection).toHaveBeenCalledWith(
      "new-col",
      expect.objectContaining({ vectors: expect.objectContaining({ size: 64 }) }),
    );
  });

  it("should not recreate collection when it already exists", async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: "existing-col" }, { name: "memory_migrations" }],
    });
    mockCreateCollection.mockClear();

    new Qdrant({ collectionName: "existing-col", embeddingModelDims: 64, dimension: 64 });
    await new Promise((r) => setTimeout(r, 20));

    expect(mockCreateCollection).not.toHaveBeenCalled();
  });
});
