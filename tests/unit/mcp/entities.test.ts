export {};
/**
 * Unit tests — lib/mcp/entities.ts
 *
 * Tests searchEntities, invalidateMemoriesByDescription, and deleteEntityByNameOrId
 * by mocking the DB layer, embedding, hybrid search, and deleteMemory.
 *
 * searchEntities:
 *   ENTITY_SEARCH_01:  substring match returns enriched EntityProfile array
 *   ENTITY_SEARCH_02:  semantic arm merges with substring results (dedup by id)
 *   ENTITY_SEARCH_03:  semantic arm failure (embed throws) doesn't break result
 *   ENTITY_SEARCH_04:  entityType filter forwarded to both Cypher arms
 *   ENTITY_SEARCH_05:  default limit=5 applied when options omitted
 *   ENTITY_SEARCH_06:  custom limit respected (e.g., limit=2)
 *   ENTITY_SEARCH_07:  relationships fetched for each entity
 *   ENTITY_SEARCH_08:  both RELATED_TO directions captured (center→target, src→center)
 *   ENTITY_SEARCH_09:  no entities found → returns empty array
 *   ENTITY_SEARCH_10:  duplicate entity ids across arms appear only once in result
 *   ENTITY_SEARCH_11:  results capped at effectiveLimit after merge
 *
 * invalidateMemoriesByDescription:
 *   INVALIDATE_01:  high-score matches are deleted and returned
 *   INVALIDATE_02:  low-score matches (below RRF threshold) are not deleted
 *   INVALIDATE_03:  empty hybrid search result returns empty array
 *   INVALIDATE_04:  deleteMemory returning false (already gone) excluded from result
 *   INVALIDATE_05:  only matches at or above RRF_THRESHOLD=0.015 are deleted
 *   INVALIDATE_06:  multiple matches all invalidated when above threshold
 *
 * deleteEntityByNameOrId:
 *   DELETE_ENTITY_01:  found by entityId → deleted, returns result with counts
 *   DELETE_ENTITY_02:  found by entityName (case-insensitive) → deleted
 *   DELETE_ENTITY_03:  entityName not found → returns null
 *   DELETE_ENTITY_04:  entityId provided but entity count returns empty → returns null
 *   DELETE_ENTITY_05:  neither entityId nor entityName → returns null
 *   DELETE_ENTITY_06:  correct mentionEdgesRemoved and relationshipsRemoved counts returned
 *   DELETE_ENTITY_07:  DETACH DELETE called with correct userId and entityId (namespace isolation)
 */

const mockRunRead = jest.fn();
const mockRunWrite = jest.fn();
const mockEmbed = jest.fn();
const mockHybridSearch = jest.fn();
const mockDeleteMemory = jest.fn();

jest.mock("@/lib/db/memgraph", () => ({
  runRead: (...args: unknown[]) => mockRunRead(...args),
  runWrite: (...args: unknown[]) => mockRunWrite(...args),
}));

jest.mock("@/lib/embeddings/openai", () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}));

jest.mock("@/lib/search/hybrid", () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

jest.mock("@/lib/memory/write", () => ({
  deleteMemory: (...args: unknown[]) => mockDeleteMemory(...args),
}));

import {
  searchEntities,
  invalidateMemoriesByDescription,
  deleteEntityByNameOrId,
} from "@/lib/mcp/entities";

const USER_ID = "user-1";

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// searchEntities
// ---------------------------------------------------------------------------
describe("searchEntities", () => {
  it("ENTITY_SEARCH_01: substring match returns enriched EntityProfile array", async () => {
    // Arm 1: substring
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: "Engineer", memoryCount: 3 },
      ])
      // Arm 2: semantic (no embedding vector needed since embed returns value)
      .mockResolvedValueOnce([])
      // UNWIND relationships for all entities
      .mockResolvedValueOnce([
        { entityId: "e1", sourceName: "Alice", relType: "WORKS_AT", targetName: "Acme", description: null },
      ]);

    mockEmbed.mockResolvedValueOnce([0.1, 0.2]);

    const result = await searchEntities("Alice", USER_ID);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("e1");
    expect(result[0].name).toBe("Alice");
    expect(result[0].type).toBe("PERSON");
    expect(result[0].memoryCount).toBe(3);
    expect(result[0].relationships).toHaveLength(1);
    expect(result[0].relationships[0]).toEqual({
      source: "Alice",
      type: "WORKS_AT",
      target: "Acme",
      description: null,
      metadata: {},
    });
  });

  it("ENTITY_SEARCH_02: semantic arm results merged with substring; duplicates removed", async () => {
    // Arm 1: substring — returns e1
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: "Engineer", memoryCount: 3 },
      ])
      // Arm 2: semantic — returns e1 (dup) + e2 (new)
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: "Engineer", memoryCount: 3 },
        { id: "e2", name: "Bob", type: "PERSON", description: "Manager", memoryCount: 1 },
      ])
      // UNWIND relationships for [e1, e2]
      .mockResolvedValueOnce([]);

    mockEmbed.mockResolvedValueOnce([0.1, 0.2]);

    const result = await searchEntities("engineer", USER_ID);

    // e1 should appear only once despite being in both arms
    expect(result).toHaveLength(2);
    const ids = result.map((e) => e.id);
    expect(ids).toContain("e1");
    expect(ids).toContain("e2");
    expect(ids.filter((id) => id === "e1")).toHaveLength(1);
  });

  it("ENTITY_SEARCH_03: embed throws → semantic arm skipped, substring results returned", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: null, memoryCount: 2 },
      ])
      // Relationships for e1
      .mockResolvedValueOnce([]);

    mockEmbed.mockRejectedValueOnce(new Error("embedding service down"));

    const result = await searchEntities("Alice", USER_ID);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Alice");
  });

  it("ENTITY_SEARCH_04: entityType filter is forwarded to query params", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Acme", type: "ORGANIZATION", description: null, memoryCount: 1 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockEmbed.mockResolvedValueOnce([]);

    await searchEntities("Acme", USER_ID, { entityType: "ORGANIZATION" });

    // First runRead call should include entityType in params
    const firstCallParams = mockRunRead.mock.calls[0][1] as Record<string, unknown>;
    expect(firstCallParams.entityType).toBe("ORGANIZATION");
  });

  it("ENTITY_SEARCH_05: default limit is 5 when options omitted", async () => {
    // Return 6 entities from substring arm to confirm limit is applied
    const sixEntities = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`,
      name: `Entity${i}`,
      type: "CONCEPT",
      description: null,
      memoryCount: i,
    }));
    mockRunRead
      .mockResolvedValueOnce(sixEntities)
      .mockResolvedValueOnce([]) // semantic arm
      .mockResolvedValueOnce([]); // UNWIND relationships for 5 entities
    mockEmbed.mockResolvedValueOnce([]);

    const result = await searchEntities("Entity", USER_ID);

    // Default limit = 5 — only 5 should be returned
    expect(result).toHaveLength(5);
  });

  it("ENTITY_SEARCH_06: custom limit=2 respected", async () => {
    const threeEntities = Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`,
      name: `Entity${i}`,
      type: "CONCEPT",
      description: null,
      memoryCount: i,
    }));
    mockRunRead
      .mockResolvedValueOnce(threeEntities)
      .mockResolvedValueOnce([]) // semantic arm
      .mockResolvedValueOnce([]); // UNWIND relationships for 2 entities
    mockEmbed.mockResolvedValueOnce([]);

    const result = await searchEntities("Entity", USER_ID, { limit: 2 });

    expect(result).toHaveLength(2);
  });

  it("ENTITY_SEARCH_07: relationships fetched via UNWIND and mapped correctly", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: null, memoryCount: 1 },
      ])
      .mockResolvedValueOnce([]) // semantic
      .mockResolvedValueOnce([
        { entityId: "e1", sourceName: "Alice", relType: "MANAGES", targetName: "Team A", description: "Direct reports" },
        { entityId: "e1", sourceName: "HR", relType: "OVERSEES", targetName: "Alice", description: null },
      ]);

    mockEmbed.mockResolvedValueOnce([]);

    const result = await searchEntities("Alice", USER_ID);

    expect(result[0].relationships).toHaveLength(2);
    expect(result[0].relationships[0]).toEqual({
      source: "Alice",
      type: "MANAGES",
      target: "Team A",
      description: "Direct reports",
      metadata: {},
    });
    expect(result[0].relationships[1]).toEqual({
      source: "HR",
      type: "OVERSEES",
      target: "Alice",
      description: null,
      metadata: {},
    });
  });

  it("ENTITY_SEARCH_09: no entities found → returns empty array", async () => {
    mockRunRead
      .mockResolvedValueOnce([]) // substring
      .mockResolvedValueOnce([]); // semantic
    mockEmbed.mockResolvedValueOnce([]);

    const result = await searchEntities("unknown-entity", USER_ID);

    expect(result).toEqual([]);
  });

  it("ENTITY_SEARCH_10: userId is always passed to Cypher queries (namespace isolation)", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: null, memoryCount: 0 },
      ])
      .mockResolvedValueOnce([]) // semantic
      .mockResolvedValueOnce([]); // relationships
    mockEmbed.mockResolvedValueOnce([]);

    await searchEntities("Alice", "isolated-user");

    // Every runRead call should include the correct userId
    for (const call of mockRunRead.mock.calls) {
      const params = call[1] as Record<string, unknown>;
      expect(params.userId).toBe("isolated-user");
    }
  });

  it("ENTITY_SEARCH_11: UNWIND batch — single relationship query for N entities (not N queries)", async () => {
    // 3 entities returned from substring arm
    const threeEntities = [
      { id: "e1", name: "Alice", type: "PERSON", description: null, memoryCount: 3 },
      { id: "e2", name: "Bob", type: "PERSON", description: null, memoryCount: 2 },
      { id: "e3", name: "Carol", type: "PERSON", description: null, memoryCount: 1 },
    ];
    mockRunRead
      .mockResolvedValueOnce(threeEntities) // substring
      .mockResolvedValueOnce([]) // semantic
      // Single UNWIND returns rels for multiple entities
      .mockResolvedValueOnce([
        { entityId: "e1", sourceName: "Alice", relType: "WORKS_WITH", targetName: "Bob", description: null },
        { entityId: "e2", sourceName: "Bob", relType: "MANAGES", targetName: "Carol", description: "Direct report" },
      ]);
    mockEmbed.mockResolvedValueOnce([]);

    const result = await searchEntities("team", USER_ID);

    // Exactly 3 runRead calls: substring, semantic, 1 UNWIND (not 3 per-entity)
    expect(mockRunRead).toHaveBeenCalledTimes(3);

    // UNWIND call should pass entityIds array
    const unwindParams = mockRunRead.mock.calls[2][1] as Record<string, unknown>;
    expect(unwindParams.entityIds).toEqual(["e1", "e2", "e3"]);

    // Relationships correctly grouped per entity
    expect(result[0].relationships).toHaveLength(1); // Alice has 1
    expect(result[0].relationships[0].type).toBe("WORKS_WITH");
    expect(result[1].relationships).toHaveLength(1); // Bob has 1
    expect(result[1].relationships[0].type).toBe("MANAGES");
    expect(result[2].relationships).toHaveLength(0); // Carol has 0
  });

  it("ENTITY_SEARCH_12: UNWIND relationship Cypher reads r.type (not r.relType) for edge property", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: null, memoryCount: 1 },
      ])
      .mockResolvedValueOnce([]) // semantic
      .mockResolvedValueOnce([]); // relationships
    mockEmbed.mockResolvedValueOnce([]);

    await searchEntities("Alice", USER_ID);

    // The UNWIND relationship query should use r.type (the actual edge property)
    const relCypher = mockRunRead.mock.calls[2][0] as string;
    expect(relCypher).toContain("r.type AS relType");
    expect(relCypher).not.toContain("r.relType");
  });
});

// ---------------------------------------------------------------------------
// invalidateMemoriesByDescription
// ---------------------------------------------------------------------------
describe("invalidateMemoriesByDescription", () => {
  it("INVALIDATE_01: high-score matches are deleted and returned", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Alice phone is 555-1234", rrfScore: 0.03, textRank: 1, vectorRank: 1, categories: [], createdAt: "2024-01-01", appName: null },
      { id: "m2", content: "Contact: 555-1234", rrfScore: 0.025, textRank: 2, vectorRank: 2, categories: [], createdAt: "2024-01-01", appName: null },
    ]);
    mockDeleteMemory.mockResolvedValue(true);

    const result = await invalidateMemoriesByDescription("Alice phone number", USER_ID);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: "m1", content: "Alice phone is 555-1234" });
    expect(result[1]).toEqual({ id: "m2", content: "Contact: 555-1234" });
    expect(mockDeleteMemory).toHaveBeenCalledTimes(2);
  });

  it("INVALIDATE_02: low-score matches (below RRF_THRESHOLD=0.015) are not deleted", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Some unrelated memory", rrfScore: 0.005, textRank: null, vectorRank: 1, categories: [], createdAt: "2024-01-01", appName: null },
    ]);

    const result = await invalidateMemoriesByDescription("phone number", USER_ID);

    expect(result).toHaveLength(0);
    expect(mockDeleteMemory).not.toHaveBeenCalled();
  });

  it("INVALIDATE_03: empty hybrid search result returns empty array", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);

    const result = await invalidateMemoriesByDescription("old address", USER_ID);

    expect(result).toEqual([]);
    expect(mockDeleteMemory).not.toHaveBeenCalled();
  });

  it("INVALIDATE_04: deleteMemory returning false excludes item from result", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Already deleted memory", rrfScore: 0.03, textRank: 1, vectorRank: 1, categories: [], createdAt: "2024-01-01", appName: null },
    ]);
    mockDeleteMemory.mockResolvedValueOnce(false); // already gone

    const result = await invalidateMemoriesByDescription("old memory", USER_ID);

    expect(result).toHaveLength(0);
  });

  it("INVALIDATE_05: exactly at RRF_THRESHOLD=0.015 is included", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Borderline match", rrfScore: 0.015, textRank: 1, vectorRank: null, categories: [], createdAt: "2024-01-01", appName: null },
    ]);
    mockDeleteMemory.mockResolvedValueOnce(true);

    const result = await invalidateMemoriesByDescription("something", USER_ID);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("INVALIDATE_06: mixed high/low scores — only above-threshold entries deleted", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "High match", rrfScore: 0.02, textRank: 1, vectorRank: 1, categories: [], createdAt: "2024-01-01", appName: null },
      { id: "m2", content: "Low match", rrfScore: 0.008, textRank: null, vectorRank: 2, categories: [], createdAt: "2024-01-01", appName: null },
      { id: "m3", content: "Another high match", rrfScore: 0.018, textRank: 2, vectorRank: null, categories: [], createdAt: "2024-01-01", appName: null },
    ]);
    mockDeleteMemory.mockResolvedValue(true);

    const result = await invalidateMemoriesByDescription("high match content", USER_ID);

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("m1");
    expect(ids).toContain("m3");
    expect(ids).not.toContain("m2");
    expect(mockDeleteMemory).toHaveBeenCalledTimes(2);
  });

  it("INVALIDATE_07: hybridSearch called with correct userId and hybrid mode", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);

    await invalidateMemoriesByDescription("test description", "target-user");

    expect(mockHybridSearch).toHaveBeenCalledWith(
      "test description",
      expect.objectContaining({ userId: "target-user", mode: "hybrid", topK: 10 })
    );
  });
});

// ---------------------------------------------------------------------------
// deleteEntityByNameOrId
// ---------------------------------------------------------------------------
describe("deleteEntityByNameOrId", () => {
  it("DELETE_ENTITY_01: found by entityId → deleted, returns counts", async () => {
    // No name lookup needed (entityId provided)
    mockRunRead
      .mockResolvedValueOnce([
        { name: "Alice", mentionCount: 5, relationCount: 2 },
      ]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await deleteEntityByNameOrId(USER_ID, "e1");

    expect(result).toEqual({
      entity: "Alice",
      mentionEdgesRemoved: 5,
      relationshipsRemoved: 2,
    });
    expect(mockRunWrite).toHaveBeenCalledTimes(1);
    // Verify DETACH DELETE is called with correct params
    const [query, params] = mockRunWrite.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("DETACH DELETE");
    expect(params.userId).toBe(USER_ID);
    expect(params.entityId).toBe("e1");
  });

  it("DELETE_ENTITY_02: found by entityName (case-insensitive lookup)", async () => {
    // Name lookup: returns entity id
    mockRunRead
      .mockResolvedValueOnce([{ id: "e42" }])
      // Count query
      .mockResolvedValueOnce([{ name: "Bob", mentionCount: 3, relationCount: 0 }]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await deleteEntityByNameOrId(USER_ID, undefined, "BOB");

    expect(result).toEqual({
      entity: "Bob",
      mentionEdgesRemoved: 3,
      relationshipsRemoved: 0,
    });
  });

  it("DELETE_ENTITY_03: entityName not found → returns null", async () => {
    mockRunRead.mockResolvedValueOnce([]); // name lookup returns nothing

    const result = await deleteEntityByNameOrId(USER_ID, undefined, "NonExistent");

    expect(result).toBeNull();
    expect(mockRunWrite).not.toHaveBeenCalled();
  });

  it("DELETE_ENTITY_04: entityId provided but count query returns empty → returns null", async () => {
    mockRunRead.mockResolvedValueOnce([]); // count query returns no rows

    const result = await deleteEntityByNameOrId(USER_ID, "missing-id");

    expect(result).toBeNull();
    expect(mockRunWrite).not.toHaveBeenCalled();
  });

  it("DELETE_ENTITY_05: neither entityId nor entityName → returns null immediately", async () => {
    const result = await deleteEntityByNameOrId(USER_ID);

    expect(result).toBeNull();
    expect(mockRunRead).not.toHaveBeenCalled();
    expect(mockRunWrite).not.toHaveBeenCalled();
  });

  it("DELETE_ENTITY_06: count query returns row with null name → returns null", async () => {
    mockRunRead.mockResolvedValueOnce([{ name: null, mentionCount: 0, relationCount: 0 }]);

    const result = await deleteEntityByNameOrId(USER_ID, "e-bad");

    expect(result).toBeNull();
    expect(mockRunWrite).not.toHaveBeenCalled();
  });

  it("DELETE_ENTITY_07: userId always passed to all queries (namespace isolation)", async () => {
    mockRunRead.mockResolvedValueOnce([{ name: "Carol", mentionCount: 1, relationCount: 0 }]);
    mockRunWrite.mockResolvedValueOnce([]);

    await deleteEntityByNameOrId("ns-user", "e99");

    const readParams = mockRunRead.mock.calls[0][1] as Record<string, unknown>;
    expect(readParams.userId).toBe("ns-user");

    const writeParams = mockRunWrite.mock.calls[0][1] as Record<string, unknown>;
    expect(writeParams.userId).toBe("ns-user");
  });

  it("DELETE_ENTITY_08: entityId takes precedence over entityName when both provided", async () => {
    // When entityId is provided, name lookup should NOT be called
    mockRunRead.mockResolvedValueOnce([{ name: "Dave", mentionCount: 2, relationCount: 1 }]);
    mockRunWrite.mockResolvedValueOnce([]);

    await deleteEntityByNameOrId(USER_ID, "direct-id", "Dave");

    // Only one runRead call (the count query), not two (no name lookup needed)
    expect(mockRunRead).toHaveBeenCalledTimes(1);
    const [query, params] = mockRunRead.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.entityId).toBe("direct-id");
  });
});
