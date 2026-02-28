export {};
/**
 * Unit tests — relate.ts (lib/entities/relate.ts)
 *
 * RELATE_01: linkEntities calls runWrite with MERGE + correct params
 * RELATE_02: relType uppercased and spaces replaced with underscores
 * RELATE_03: default description is empty string
 */
import { linkEntities } from "@/lib/entities/relate";

jest.mock("@/lib/db/memgraph", () => ({ runWrite: jest.fn() }));

import { runWrite } from "@/lib/db/memgraph";

const mockRunWrite = runWrite as jest.MockedFunction<typeof runWrite>;

beforeEach(() => jest.clearAllMocks());

describe("linkEntities", () => {
  it("RELATE_01: calls runWrite with MERGE and correct entity IDs", async () => {
    mockRunWrite.mockResolvedValue([]);

    await linkEntities("ent-src", "ent-tgt", "WORKS_AT", "Alice works at Acme");

    expect(mockRunWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockRunWrite.mock.calls[0] as [string, Record<string, unknown>];

    expect(cypher).toContain("MERGE");
    expect(cypher).toContain("RELATED_TO");
    expect(cypher).toContain("ON CREATE SET");
    expect(cypher).toContain("ON MATCH SET");
    expect(params.sourceId).toBe("ent-src");
    expect(params.targetId).toBe("ent-tgt");
    expect(params.relType).toBe("WORKS_AT");
    expect(params.desc).toBe("Alice works at Acme");
  });

  it("RELATE_02: relType is uppercased and spaces become underscores", async () => {
    mockRunWrite.mockResolvedValue([]);

    await linkEntities("a", "b", "works at", "desc");

    const params = mockRunWrite.mock.calls[0][1] as Record<string, unknown>;
    expect(params.relType).toBe("WORKS_AT");
  });

  it("RELATE_03: empty description default", async () => {
    mockRunWrite.mockResolvedValue([]);

    await linkEntities("a", "b", "TYPE");

    const params = mockRunWrite.mock.calls[0][1] as Record<string, unknown>;
    expect(params.desc).toBe("");
  });
});
