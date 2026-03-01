export {};
/**
 * Unit tests — Open Metadata on Entity nodes and RELATED_TO edges
 *
 * Tests metadata flow through the full pipeline:
 *   extraction → normalization → resolveEntity → linkEntities → searchEntities → MCP
 *
 * METADATA HELPERS (resolve.ts exports):
 *   META_SERIALIZE_01–03: serializeMetadata
 *   META_PARSE_01–05: parseMetadata
 *   META_MERGE_01–05: mergeMetadata
 *
 * EXTRACTION (extract.ts — via public API):
 *   META_EXTRACT_01–04: Entity/relationship metadata normalization
 *
 * RESOLVE (resolveEntity):
 *   META_RESOLVE_CREATE_01: New entity stores metadata
 *   META_RESOLVE_UPDATE_01–03: Existing entity metadata merge / no-op
 *
 * RELATE (linkEntities):
 *   META_RELATE_01–03: Edge metadata create / merge / default
 *
 * SEARCH (searchEntities):
 *   META_SEARCH_01–03: Entity & relationship metadata in profiles
 */

// -----------------------------------------------------------------------
// Mocks — DB, embedding, LLM (all real implementations use these)
// -----------------------------------------------------------------------

const mockRunRead = jest.fn();
const mockRunWrite = jest.fn();
const mockEmbed = jest.fn();
const mockCreate = jest.fn();

jest.mock("@/lib/db/memgraph", () => ({
  runRead: (...args: unknown[]) => mockRunRead(...args),
  runWrite: (...args: unknown[]) => mockRunWrite(...args),
}));

jest.mock("@/lib/embeddings/openai", () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}));

jest.mock("@/lib/ai/client", () => ({
  getLLMClient: () => ({ chat: { completions: { create: mockCreate } } }),
}));

// Mocked transitively — searchEntities imports these but our tests don't exercise them
jest.mock("@/lib/search/hybrid");
jest.mock("@/lib/memory/write");

// -----------------------------------------------------------------------
// Imports (real implementations — they use the mocked DB/LLM/embed above)
// -----------------------------------------------------------------------
import {
  serializeMetadata,
  parseMetadata,
  mergeMetadata,
  resolveEntity,
} from "@/lib/entities/resolve";
import { extractEntitiesAndRelationships } from "@/lib/entities/extract";
import { linkEntities } from "@/lib/entities/relate";
import { searchEntities } from "@/lib/mcp/entities";

// -----------------------------------------------------------------------
// Global setup
// -----------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  // Default: embed fails → semantic dedup skipped (resolveEntity falls through to CREATE)
  mockEmbed.mockRejectedValue(new Error("no embed in test"));
});

// =======================================================================
// 1. METADATA HELPERS (pure functions)
// =======================================================================

describe("serializeMetadata", () => {
  it("META_SERIALIZE_01: serializes object to JSON string", () => {
    expect(serializeMetadata({ ticker: "AAPL", sector: "Technology" }))
      .toBe('{"ticker":"AAPL","sector":"Technology"}');
  });

  it("META_SERIALIZE_02: undefined → '{}'", () => {
    expect(serializeMetadata(undefined)).toBe("{}");
  });

  it("META_SERIALIZE_03: empty object → '{}'", () => {
    expect(serializeMetadata({})).toBe("{}");
  });
});

describe("parseMetadata", () => {
  it("META_PARSE_01: valid JSON string → object", () => {
    expect(parseMetadata('{"dosage":"50mg","frequency":"daily"}'))
      .toEqual({ dosage: "50mg", frequency: "daily" });
  });

  it("META_PARSE_02: null → empty object", () => {
    expect(parseMetadata(null)).toEqual({});
  });

  it("META_PARSE_03: invalid JSON → empty object", () => {
    expect(parseMetadata("not-json")).toEqual({});
  });

  it("META_PARSE_04: JSON array → empty object (arrays rejected)", () => {
    expect(parseMetadata("[1,2,3]")).toEqual({});
  });

  it("META_PARSE_05: undefined → empty object", () => {
    expect(parseMetadata(undefined)).toEqual({});
  });
});

describe("mergeMetadata", () => {
  it("META_MERGE_01: incoming keys overwrite existing", () => {
    const result = mergeMetadata(
      { dosage: "25mg", frequency: "daily" },
      { dosage: "50mg" }
    );
    expect(result).toEqual({ dosage: "50mg", frequency: "daily" });
  });

  it("META_MERGE_02: existing keys preserved when not in incoming", () => {
    const result = mergeMetadata(
      { ticker: "AAPL", sector: "Technology", marketCap: "3T" },
      { sector: "Tech" }
    );
    expect(result).toEqual({ ticker: "AAPL", sector: "Tech", marketCap: "3T" });
  });

  it("META_MERGE_03: undefined incoming → existing unchanged", () => {
    const existing = { language: "TypeScript", version: "5.0" };
    expect(mergeMetadata(existing, undefined)).toEqual(existing);
  });

  it("META_MERGE_04: empty incoming → existing unchanged", () => {
    const existing = { role: "Senior Engineer" };
    expect(mergeMetadata(existing, {})).toEqual(existing);
  });

  it("META_MERGE_05: both empty → empty object", () => {
    expect(mergeMetadata({}, {})).toEqual({});
  });
});

// =======================================================================
// 2. EXTRACTION (tests metadata normalization via public API)
// =======================================================================

describe("extractEntitiesAndRelationships — metadata normalization", () => {
  it("META_EXTRACT_01: entity metadata extracted and preserved", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            entities: [
              { name: "Aspirin", type: "MEDICATION", description: "Pain reliever", metadata: { dosage: "50mg", frequency: "daily" } },
            ],
            relationships: [],
          }),
        },
      }],
    });

    const result = await extractEntitiesAndRelationships("Takes 50mg Aspirin daily");

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].metadata).toEqual({ dosage: "50mg", frequency: "daily" });
  });

  it("META_EXTRACT_02: relationship metadata extracted and preserved", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            entities: [
              { name: "Alice", type: "PERSON", description: "Employee" },
              { name: "Acme", type: "ORGANIZATION", description: "Company" },
            ],
            relationships: [
              { source: "Alice", target: "Acme", type: "WORKS_AT", description: "Employee", metadata: { since: "2024-01", role: "Senior Engineer" } },
            ],
          }),
        },
      }],
    });

    const result = await extractEntitiesAndRelationships("Alice works at Acme since 2024 as Senior Engineer");

    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].metadata).toEqual({ since: "2024-01", role: "Senior Engineer" });
  });

  it("META_EXTRACT_03: invalid metadata (array) filtered out", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            entities: [
              { name: "Widget", type: "PRODUCT", description: "A widget", metadata: [1, 2, 3] },
            ],
            relationships: [],
          }),
        },
      }],
    });

    const result = await extractEntitiesAndRelationships("Widget is a product");

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].metadata).toBeUndefined();
  });

  it("META_EXTRACT_04: missing metadata → field omitted", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: JSON.stringify({
            entities: [{ name: "Alice", type: "PERSON", description: "A person" }],
            relationships: [{ source: "Alice", target: "Bob", type: "KNOWS", description: "Friends" }],
          }),
        },
      }],
    });

    const result = await extractEntitiesAndRelationships("Alice knows Bob");

    expect(result.entities[0].metadata).toBeUndefined();
    expect(result.relationships[0].metadata).toBeUndefined();
  });
});

// =======================================================================
// 3. RESOLVE — metadata on entity creation and updates
// =======================================================================

describe("resolveEntity — metadata", () => {
  it("META_RESOLVE_CREATE_01: new entity stores metadata as JSON string", async () => {
    // User MERGE
    mockRunWrite.mockResolvedValueOnce([]);
    // normalizedName lookup → not found
    mockRunRead.mockResolvedValueOnce([]);
    // semantic dedup fails (embed rejected by default) → falls through to CREATE
    // MERGE create
    mockRunWrite.mockResolvedValueOnce([{ entityId: "new-entity-id" }]);

    const entityId = await resolveEntity(
      {
        name: "Aspirin",
        type: "MEDICATION",
        description: "Pain reliever",
        metadata: { dosage: "50mg", frequency: "daily" },
      },
      "user-1"
    );

    expect(entityId).toBe("new-entity-id");

    // Verify MERGE query includes serialized metadata
    const mergeCall = mockRunWrite.mock.calls[1]; // second runWrite = MERGE
    const params = mergeCall[1] as Record<string, unknown>;
    expect(params.metadata).toBe('{"dosage":"50mg","frequency":"daily"}');
  });

  it("META_RESOLVE_UPDATE_01: existing entity merges metadata (shallow merge)", async () => {
    // User MERGE
    mockRunWrite.mockResolvedValueOnce([]);
    // normalizedName lookup → found
    mockRunRead.mockResolvedValueOnce([
      { id: "existing-entity", name: "Aspirin", type: "MEDICATION", description: "Pain reliever" },
    ]);
    // Read current metadata for merge
    mockRunRead.mockResolvedValueOnce([{ metadata: '{"dosage":"25mg","brand":"Bayer"}' }]);
    // Update entity
    mockRunWrite.mockResolvedValueOnce([]);

    const entityId = await resolveEntity(
      {
        name: "Aspirin",
        type: "MEDICATION",
        description: "Pain reliever",
        metadata: { dosage: "50mg", frequency: "daily" },
      },
      "user-1"
    );

    expect(entityId).toBe("existing-entity");

    // Verify UPDATE query has merged metadata
    const updateCall = mockRunWrite.mock.calls[1]; // second runWrite = update
    const params = updateCall[1] as Record<string, unknown>;
    const mergedMeta = JSON.parse(params.metadata as string);
    expect(mergedMeta.dosage).toBe("50mg"); // overwritten
    expect(mergedMeta.brand).toBe("Bayer"); // preserved from existing
    expect(mergedMeta.frequency).toBe("daily"); // new key added
  });

  it("META_RESOLVE_UPDATE_02: no incoming metadata → entity metadata untouched", async () => {
    // User MERGE
    mockRunWrite.mockResolvedValueOnce([]);
    // normalizedName lookup → found (longer desc — no upgrade)
    mockRunRead.mockResolvedValueOnce([
      { id: "existing-entity", name: "Aspirin", type: "MEDICATION", description: "Pain reliever and anti-inflammatory" },
    ]);

    const entityId = await resolveEntity(
      {
        name: "Aspirin",
        type: "MEDICATION",
        description: "Pain reliever", // shorter — no desc upgrade
        // no metadata
      },
      "user-1"
    );

    expect(entityId).toBe("existing-entity");
    // No update write — neither type, desc, nor metadata changed
    expect(mockRunWrite).toHaveBeenCalledTimes(1); // only User MERGE
  });

  it("META_RESOLVE_UPDATE_03: only metadata change triggers update (no type/desc upgrade)", async () => {
    // User MERGE
    mockRunWrite.mockResolvedValueOnce([]);
    // normalizedName lookup → found
    mockRunRead.mockResolvedValueOnce([
      { id: "existing-entity", name: "Tesla", type: "ORGANIZATION", description: "Electric car company" },
    ]);
    // Read current metadata for merge
    mockRunRead.mockResolvedValueOnce([{ metadata: '{}' }]);
    // Update entity (metadata only)
    mockRunWrite.mockResolvedValueOnce([]);

    const entityId = await resolveEntity(
      {
        name: "Tesla",
        type: "ORGANIZATION",
        description: "Electric car", // shorter — no desc upgrade
        metadata: { ticker: "TSLA", sector: "Automotive" },
      },
      "user-1"
    );

    expect(entityId).toBe("existing-entity");
    // Update DID fire because hasIncomingMeta is true
    expect(mockRunWrite).toHaveBeenCalledTimes(2); // User MERGE + entity update
    const updateParams = mockRunWrite.mock.calls[1][1] as Record<string, unknown>;
    expect(updateParams.hasIncomingMeta).toBe(true);
    expect(updateParams.shouldUpgradeType).toBe(false);
    expect(updateParams.shouldUpgradeDesc).toBe(false);
    const storedMeta = JSON.parse(updateParams.metadata as string);
    expect(storedMeta).toEqual({ ticker: "TSLA", sector: "Automotive" });
  });
});

// =======================================================================
// 4. RELATE — metadata on [:RELATED_TO] edges
// =======================================================================

describe("linkEntities — metadata", () => {
  beforeEach(() => {
    mockRunRead.mockReset();
    mockRunWrite.mockReset();
  });

  it("META_RELATE_01: new edge stores metadata as JSON string", async () => {
    mockRunRead.mockResolvedValueOnce([]); // no existing edge
    mockRunWrite.mockResolvedValue([]);

    await linkEntities("ent-src", "ent-tgt", "WORKS_AT", "Alice works at Acme", "Alice", "Acme", {
      since: "2024-01",
      role: "Senior Engineer",
    });

    // CREATE edge includes metadata
    const [cypher, params] = mockRunWrite.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher).toContain("metadata: $metadata");
    expect(params.metadata).toBe('{"since":"2024-01","role":"Senior Engineer"}');
  });

  it("META_RELATE_02: replacement edge merges metadata from old edge", async () => {
    // Existing edge with metadata + different description
    mockRunRead.mockResolvedValueOnce([{
      desc: "Old description",
      metadata: '{"since":"2023-06","department":"Engineering"}',
    }]);
    mockRunWrite.mockResolvedValue([]);
    // LLM classifies as UPDATE
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"verdict": "UPDATE"}' } }],
    });

    await linkEntities("ent-src", "ent-tgt", "WORKS_AT", "New description", "Alice", "Acme", {
      since: "2024-01",
      role: "Senior Engineer",
    });

    // Last runWrite = CREATE new edge (after invalidation of old)
    const createCall = mockRunWrite.mock.calls[mockRunWrite.mock.calls.length - 1];
    const params = createCall[1] as Record<string, unknown>;
    const mergedMeta = JSON.parse(params.metadata as string);
    expect(mergedMeta.since).toBe("2024-01"); // overwritten by incoming
    expect(mergedMeta.department).toBe("Engineering"); // preserved from old
    expect(mergedMeta.role).toBe("Senior Engineer"); // new key
  });

  it("META_RELATE_03: no metadata → edge stored with '{}'", async () => {
    mockRunRead.mockResolvedValueOnce([]); // no existing edge
    mockRunWrite.mockResolvedValue([]);

    await linkEntities("ent-src", "ent-tgt", "KNOWS");

    const params = mockRunWrite.mock.calls[0][1] as Record<string, unknown>;
    expect(params.metadata).toBe("{}");
  });
});

// =======================================================================
// 5. SEARCH — metadata in entity profiles
// =======================================================================

describe("searchEntities — metadata", () => {
  beforeEach(() => {
    mockRunRead.mockReset();
    mockRunWrite.mockReset();
    mockEmbed.mockReset();
  });

  it("META_SEARCH_01: entity metadata returned parsed in profile", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Apple", type: "ORGANIZATION", description: "Tech company", metadata: '{"ticker":"AAPL","sector":"Technology"}', memoryCount: 10 },
      ])
      .mockResolvedValueOnce([]) // semantic arm
      .mockResolvedValueOnce([]); // relationships
    mockEmbed.mockResolvedValueOnce([0.1, 0.2]);

    const result = await searchEntities("Apple", "user-1");

    expect(result).toHaveLength(1);
    expect(result[0].metadata).toEqual({ ticker: "AAPL", sector: "Technology" });
  });

  it("META_SEARCH_02: relationship metadata returned parsed in profile", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: "Engineer", metadata: null, memoryCount: 5 },
      ])
      .mockResolvedValueOnce([]) // semantic arm
      .mockResolvedValueOnce([
        {
          entityId: "e1", sourceName: "Alice", relType: "WORKS_AT", targetName: "Acme",
          description: "Employee",
          metadata: '{"since":"2024-01","role":"Senior Engineer"}',
        },
      ]);
    mockEmbed.mockResolvedValueOnce([0.1, 0.2]);

    const result = await searchEntities("Alice", "user-1");

    expect(result[0].relationships).toHaveLength(1);
    expect(result[0].relationships[0].metadata).toEqual({
      since: "2024-01",
      role: "Senior Engineer",
    });
  });

  it("META_SEARCH_03: missing metadata → empty object in profile", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "e1", name: "Alice", type: "PERSON", description: null, memoryCount: 1 },
      ])
      .mockResolvedValueOnce([]) // semantic
      .mockResolvedValueOnce([]); // no relationships
    mockEmbed.mockResolvedValueOnce([0.1, 0.2]);

    const result = await searchEntities("Alice", "user-1");

    expect(result[0].metadata).toEqual({});
  });
});
