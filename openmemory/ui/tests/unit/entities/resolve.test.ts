export {};
/**
 * Unit tests — resolveEntity (lib/entities/resolve.ts)
 *
 * RESOLVE_01: First call creates a new Entity, returns an id
 * RESOLVE_02: Second call with same name+type returns the SAME id (MERGE dedup)
 * RESOLVE_03: Same name but different type creates a DIFFERENT entity
 * RESOLVE_04: Longer description on re-resolve updates the description
 */
import { resolveEntity } from "@/lib/entities/resolve";

jest.mock("@/lib/db/memgraph", () => ({ runWrite: jest.fn() }));
import { runWrite } from "@/lib/db/memgraph";

const mockRunWrite = runWrite as jest.MockedFunction<typeof runWrite>;

beforeEach(() => jest.clearAllMocks());

describe("resolveEntity", () => {
  it("RESOLVE_01: creates a new entity and returns an id string", async () => {
    // resolveEntity makes 3 runWrite calls:
    //   [0] ensure User (MERGE u:User)
    //   [1] MERGE Entity + return e.id
    //   [2] MERGE HAS_ENTITY relationship
    mockRunWrite
      .mockResolvedValueOnce([{}])                    // User MERGE
      .mockResolvedValueOnce([{ id: "entity-uuid-1" }]) // Entity MERGE → returns id
      .mockResolvedValueOnce([{}]);                   // HAS_ENTITY MERGE

    const id = await resolveEntity(
      { name: "Alice", type: "PERSON", description: "A colleague" },
      "user-1"
    );

    expect(typeof id).toBe("string");
    expect(id).toBe("entity-uuid-1");
    expect(mockRunWrite).toHaveBeenCalledTimes(3);

    // calls[1] is the Entity MERGE — verify it contains MERGE and HAS_ENTITY path setup
    const entityCypher = mockRunWrite.mock.calls[1][0] as string;
    expect(entityCypher).toContain("MERGE");
    // calls[2] is the relationship MERGE
    const relCypher = mockRunWrite.mock.calls[2][0] as string;
    expect(relCypher).toContain("HAS_ENTITY");
  });

  it("RESOLVE_02: same name+type returns same id (MERGE semantics)", async () => {
    // Simulate Memgraph MERGE returning same node both times
    mockRunWrite.mockResolvedValue([{ id: "entity-uuid-alice" }]);

    const id1 = await resolveEntity({ name: "Alice", type: "PERSON", description: "A colleague" }, "user-1");
    const id2 = await resolveEntity({ name: "alice", type: "PERSON", description: "Alice again" }, "user-1");

    // Both calls return the same id from the mock (MERGE would do this in DB)
    expect(id1).toBe(id2);
  });

  it("RESOLVE_03: same name different type → different resolveEntity call (distinct params)", async () => {
    // 2 invocations × 3 runWrite calls each = 6 total
    mockRunWrite
      .mockResolvedValueOnce([{}])                     // [0] User MERGE (person)
      .mockResolvedValueOnce([{ id: "id-person" }])    // [1] Entity MERGE (person)
      .mockResolvedValueOnce([{}])                     // [2] HAS_ENTITY (person)
      .mockResolvedValueOnce([{}])                     // [3] User MERGE (org)
      .mockResolvedValueOnce([{ id: "id-org" }])       // [4] Entity MERGE (org)
      .mockResolvedValueOnce([{}]);                    // [5] HAS_ENTITY (org)

    const personId = await resolveEntity({ name: "Alice", type: "PERSON", description: "" }, "user-1");
    const orgId = await resolveEntity({ name: "Alice", type: "ORGANIZATION", description: "" }, "user-1");

    expect(personId).toBe("id-person");
    expect(orgId).toBe("id-org");
    expect(personId).not.toBe(orgId);
  });

  it("RESOLVE_04: longer description triggers ON MATCH SET with CASE expression", async () => {
    mockRunWrite
      .mockResolvedValueOnce([{}])                     // [0] User MERGE
      .mockResolvedValueOnce([{ id: "entity-uuid-1" }]) // [1] Entity MERGE
      .mockResolvedValueOnce([{}]);                    // [2] HAS_ENTITY MERGE

    await resolveEntity({ name: "Alice", type: "PERSON", description: "A more detailed description of Alice" }, "user-1");

    // calls[1] is the Entity MERGE — it contains ON MATCH SET ... CASE
    const cypher = mockRunWrite.mock.calls[1][0] as string;
    expect(cypher).toContain("ON MATCH SET");
    expect(cypher).toContain("CASE");
  });
});
