/**
 * Unit tests — MCP tool handlers (2-tool architecture)
 *
 * Tests the 2 MCP tools (add_memories, search_memory) by mocking the DB layer,
 * embedding layer, pipeline modules, intent classifier, and entity functions,
 * then invoking handlers via the MCP SDK in-process client-server pair
 * (InMemoryTransport).
 *
 * Coverage:
 *   add_memories:
 *     MCP_ADD_01:    single-string backward compat — ADD path returns {id, memory, event: "ADD"}
 *     MCP_ADD_02:    single-string dedup skip returns event: "SKIP_DUPLICATE"
 *     MCP_ADD_03:    single-string dedup supersede returns event: "SUPERSEDE"
 *     MCP_ADD_04:    fires entity extraction asynchronously
 *     MCP_ADD_05:    array of strings: all items processed, returns one result per item
 *     MCP_ADD_06:    array: per-item error isolation — failed item returns event "ERROR", others succeed
 *     MCP_ADD_07:    empty array returns { results: [] } immediately
 *     MCP_ADD_08:    array with mixed dedup outcomes (ADD + SKIP + SUPERSEDE)
 *     MCP_ADD_09:    INVALIDATE intent — soft-deletes matching memories
 *     MCP_ADD_10:    DELETE_ENTITY intent — removes entity from knowledge graph
 *     MCP_ADD_11:    intent classifier failure defaults to STORE (fail-open)
 *
 *   search_memory (search mode):
 *     MCP_SM_01:     returns hybrid search results with score, text_rank, vector_rank
 *     MCP_SM_02:     category filter removes non-matching results
 *     MCP_SM_03:     created_after filter removes older results
 *     MCP_SM_04:     logs access via runWrite (non-blocking)
 *     MCP_SM_05:     entity enrichment returns entity profiles alongside results
 *     MCP_SM_06:     include_entities=false skips entity enrichment
 *
 *   search_memory (browse mode — no query):
 *     MCP_SM_BROWSE_01:  no query returns paginated shape { total, offset, limit, results }
 *     MCP_SM_BROWSE_02:  offset parameter is forwarded to SKIP clause
 *     MCP_SM_BROWSE_03:  clamps limit to max 200
 *     MCP_SM_BROWSE_04:  results include categories per memory
 *     MCP_SM_BROWSE_05:  category filter applied in browse mode
 *     MCP_SM_BROWSE_06:  empty string query also triggers browse mode
 */

export {};

// ---------------------------------------------------------------------------
// Mocks — must come before imports
// ---------------------------------------------------------------------------
const mockRunRead = jest.fn();
const mockRunWrite = jest.fn();
const mockEmbed = jest.fn();

jest.mock("@/lib/db/memgraph", () => ({
  runRead: (...args: unknown[]) => mockRunRead(...args),
  runWrite: (...args: unknown[]) => mockRunWrite(...args),
}));

jest.mock("@/lib/embeddings/openai", () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}));

jest.mock("@/lib/memory/write", () => ({
  addMemory: jest.fn(),
  deleteMemory: jest.fn(),
  supersedeMemory: jest.fn(),
}));

jest.mock("@/lib/memory/search", () => ({
  searchMemories: jest.fn(),
  listMemories: jest.fn(),
}));

jest.mock("@/lib/search/hybrid", () => ({
  hybridSearch: jest.fn(),
}));

jest.mock("@/lib/dedup", () => ({
  checkDeduplication: jest.fn(),
}));

jest.mock("@/lib/entities/worker", () => ({
  processEntityExtraction: jest.fn(),
}));

jest.mock("@/lib/entities/resolve", () => ({
  resolveEntity: jest.fn(),
}));

// Mock intent classifier — default to STORE for all existing tests
jest.mock("@/lib/mcp/classify", () => ({
  classifyIntent: jest.fn(),
}));

// Mock entity functions used by the 2-tool architecture
jest.mock("@/lib/mcp/entities", () => ({
  searchEntities: jest.fn(),
  invalidateMemoriesByDescription: jest.fn(),
  deleteEntityByNameOrId: jest.fn(),
  touchMemoryByDescription: jest.fn(),
  resolveMemoryByDescription: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------
import { createMcpServer } from "@/lib/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { addMemory, supersedeMemory } from "@/lib/memory/write";
import { hybridSearch } from "@/lib/search/hybrid";
import { checkDeduplication } from "@/lib/dedup";
import { processEntityExtraction } from "@/lib/entities/worker";
import { classifyIntent } from "@/lib/mcp/classify";
import { searchEntities, invalidateMemoriesByDescription, deleteEntityByNameOrId, touchMemoryByDescription, resolveMemoryByDescription } from "@/lib/mcp/entities";

const mockAddMemory = addMemory as jest.MockedFunction<typeof addMemory>;
const mockSupersedeMemory = supersedeMemory as jest.MockedFunction<typeof supersedeMemory>;
const mockHybridSearch = hybridSearch as jest.MockedFunction<typeof hybridSearch>;
const mockCheckDeduplication = checkDeduplication as jest.MockedFunction<typeof checkDeduplication>;
const mockProcessEntityExtraction = processEntityExtraction as jest.MockedFunction<typeof processEntityExtraction>;
const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
const mockSearchEntities = searchEntities as jest.MockedFunction<typeof searchEntities>;
const mockInvalidateMemories = invalidateMemoriesByDescription as jest.MockedFunction<typeof invalidateMemoriesByDescription>;
const mockDeleteEntity = deleteEntityByNameOrId as jest.MockedFunction<typeof deleteEntityByNameOrId>;
const mockTouchMemory = touchMemoryByDescription as jest.MockedFunction<typeof touchMemoryByDescription>;
const mockResolveMemory = resolveMemoryByDescription as jest.MockedFunction<typeof resolveMemoryByDescription>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const USER_ID = "test-user";
const CLIENT_NAME = "test-client";

async function setupClientServer() {
  const server = createMcpServer(USER_ID, CLIENT_NAME);
  const client = new Client({ name: "test-mcp-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, clientTransport, serverTransport };
}

function parseToolResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
describe("MCP Tool Handlers — add_memories", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: intent classifier returns STORE for all items
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_ADD_01: single string backward compat — ADD returns {id, memory, event: 'ADD'}", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("new-mem-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "Alice prefers TypeScript" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(1);
    expect(parsed.ids).toEqual(["new-mem-id"]);
    expect(parsed).not.toHaveProperty("results"); // no per-item array
    expect(mockAddMemory).toHaveBeenCalledTimes(1);
  });

  it("MCP_ADD_02: single string dedup skip returns event: 'SKIP_DUPLICATE'", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({
      action: "skip",
      existingId: "existing-id",
    } as any);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "Duplicate content" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.skipped).toBe(1);
    expect(parsed).not.toHaveProperty("ids");
    expect(mockAddMemory).not.toHaveBeenCalled();
  });

  it("MCP_ADD_03: single string dedup supersede returns event: 'SUPERSEDE'", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({
      action: "supersede",
      existingId: "old-id",
    } as any);
    mockSupersedeMemory.mockResolvedValueOnce("superseded-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "Updated preference" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.superseded).toBe(1);
    expect(parsed.ids).toEqual(["superseded-id"]);
    expect(mockSupersedeMemory).toHaveBeenCalledWith("old-id", "Updated preference", "test-user", "test-client", undefined);
  });

  it("MCP_TAG_SUPERSEDE: supersede path forwards explicit tags as 5th arg to supersedeMemory (WRITE-04)", async () => {
    // When caller provides tags alongside content that triggers a SUPERSEDE,
    // those tags must be forwarded to supersedeMemory so the new node inherits them.
    mockCheckDeduplication.mockResolvedValueOnce({
      action: "supersede",
      existingId: "old-tagged-id",
    } as any);
    mockSupersedeMemory.mockResolvedValueOnce("new-tagged-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: { content: "Updated pref with tags", tags: ["myTag", "project-alpha"] },
    });

    expect(mockSupersedeMemory).toHaveBeenCalledWith(
      "old-tagged-id",
      "Updated pref with tags",
      "test-user",
      "test-client",
      ["myTag", "project-alpha"]
    );
  });

  it("MCP_ADD_04: fires entity extraction asynchronously", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("ext-mem-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: { content: "Entity test" },
    });

    // processEntityExtraction called with the new memory id
    expect(mockProcessEntityExtraction).toHaveBeenCalledWith("ext-mem-id");
  });

  it("MCP_ADD_05: array of strings processes all items, returns one result each", async () => {
    mockCheckDeduplication
      .mockResolvedValueOnce({ action: "add" } as any)
      .mockResolvedValueOnce({ action: "add" } as any)
      .mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory
      .mockResolvedValueOnce("id-1")
      .mockResolvedValueOnce("id-2")
      .mockResolvedValueOnce("id-3");
    mockProcessEntityExtraction.mockResolvedValue(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Fact one", "Fact two", "Fact three"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(3);
    expect(parsed.ids).toEqual(["id-1", "id-2", "id-3"]);
    expect(mockAddMemory).toHaveBeenCalledTimes(3);
    expect(mockProcessEntityExtraction).toHaveBeenCalledTimes(3);
  });

  it("MCP_ADD_06: per-item error isolation — failed item has event 'ERROR', others succeed", async () => {
    mockCheckDeduplication
      .mockResolvedValueOnce({ action: "add" } as any)
      .mockRejectedValueOnce(new Error("DB timeout"))
      .mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory
      .mockResolvedValueOnce("ok-id-1")
      .mockResolvedValueOnce("ok-id-3");
    mockProcessEntityExtraction.mockResolvedValue(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Good fact", "Bad fact", "Another good fact"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(2);
    expect(parsed.ids).toEqual(["ok-id-1", "ok-id-3"]);
    expect(parsed.errors).toEqual([{ index: 1, message: "DB timeout" }]);
  });

  it("MCP_ADD_07: empty array returns { results: [] } immediately", async () => {
    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: [] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed).toEqual({});
    expect(mockCheckDeduplication).not.toHaveBeenCalled();
    expect(mockAddMemory).not.toHaveBeenCalled();
  });

  it("MCP_ADD_08: array with mixed ADD + SKIP + SUPERSEDE outcomes", async () => {
    mockCheckDeduplication
      .mockResolvedValueOnce({ action: "add" } as any)
      .mockResolvedValueOnce({ action: "skip", existingId: "dup-id" } as any)
      .mockResolvedValueOnce({ action: "supersede", existingId: "old-id" } as any);
    mockAddMemory.mockResolvedValueOnce("new-id");
    mockSupersedeMemory.mockResolvedValueOnce("supersede-id");
    mockProcessEntityExtraction.mockResolvedValue(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["new fact", "duplicate fact", "updated fact"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(1);
    expect(parsed.superseded).toBe(1);
    expect(parsed.skipped).toBe(1);
    expect(parsed.ids).toEqual(["new-id", "supersede-id"]);
    // entity extraction only for ADD and SUPERSEDE items
    expect(mockProcessEntityExtraction).toHaveBeenCalledTimes(2);
  });

  it("MCP_ADD_09: explicit categories are written via runWrite after memory creation", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("cat-mem-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);
    mockRunWrite.mockResolvedValue([]); // category MERGE calls

    const result = await client.callTool({
      name: "add_memories",
      arguments: {
        content: "TypeScript is the best language",
        categories: ["Technology", "Work"],
      },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(1);
    expect(parsed.ids).toEqual(["cat-mem-id"]);

    // runWrite should have been called once for all explicit categories (UNWIND batch)
    const categoryWriteCalls = mockRunWrite.mock.calls.filter(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("HAS_CATEGORY")
    );
    expect(categoryWriteCalls).toHaveLength(1);
    // Verify category names match what was passed via UNWIND $categories
    const catNames = (categoryWriteCalls[0][1] as Record<string, unknown>).categories;
    expect(catNames).toEqual(["Technology", "Work"]);
  });

  it("MCP_ADD_10: no categories param — no explicit category writes (LLM handles it)", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("no-cat-mem-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "I like pizza" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(1);

    // No explicit runWrite calls for categories (LLM categorizer is inside addMemory, not mocked here)
    const categoryWriteCalls = mockRunWrite.mock.calls.filter(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("HAS_CATEGORY")
    );
    expect(categoryWriteCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("MCP Tool Handlers — search_memory", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("MCP_SM_01: returns hybrid search results with score fields", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      {
        id: "m1", content: "Alice uses TypeScript", rrfScore: 0.05,
        textRank: 1, vectorRank: 2, createdAt: "2026-01-15", categories: ["tech"], tags: ["session-1"],
      },
    ] as any);
    mockRunWrite.mockResolvedValueOnce([]); // access log

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "TypeScript" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toHaveProperty("id", "m1");
    expect(parsed.results[0]).toHaveProperty("memory", "Alice uses TypeScript");
    expect(parsed.results[0]).toHaveProperty("relevance_score", 1.0); // 0.05 / 0.032786 > 1.0 -> capped at 1.0
    expect(parsed.results[0]).not.toHaveProperty("raw_score");
    expect(parsed.results[0]).not.toHaveProperty("text_rank");
    expect(parsed.results[0]).not.toHaveProperty("vector_rank");
    expect(parsed.results[0]).toHaveProperty("categories", ["tech"]);
    expect(parsed.results[0]).toHaveProperty("tags", ["session-1"]);
  });

  it("MCP_SM_02: category filter removes non-matching results", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "A", rrfScore: 0.1, textRank: 1, vectorRank: 1, createdAt: "2026-01-15", categories: ["tech"] },
      { id: "m2", content: "B", rrfScore: 0.08, textRank: 2, vectorRank: 2, createdAt: "2026-01-14", categories: ["personal"] },
    ] as any);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "test", category: "tech" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].id).toBe("m1");
  });

  it("MCP_SM_03: created_after filter removes older results", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "New", rrfScore: 0.1, textRank: 1, vectorRank: 1, createdAt: "2026-02-10", categories: [] },
      { id: "m2", content: "Old", rrfScore: 0.08, textRank: 2, vectorRank: 2, createdAt: "2026-01-01", categories: [] },
    ] as any);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "test", created_after: "2026-02-01" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].id).toBe("m1");
  });

  it("MCP_SM_04: logs access via runWrite (non-blocking)", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Hit", rrfScore: 0.1, textRank: 1, vectorRank: 1, createdAt: "2026-01-15", categories: [] },
    ] as any);
    mockRunWrite.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search_memory",
      arguments: { query: "hit" },
    });

    // Wait a tick for the fire-and-forget runWrite to be called
    await new Promise((r) => setTimeout(r, 50));
    expect(mockRunWrite).toHaveBeenCalledTimes(1);
    const accessCypher = mockRunWrite.mock.calls[0][0] as string;
    expect(accessCypher).toContain("ACCESSED");
    // ACCESS-LOG-01 fix: must use MERGE (not CREATE) to avoid duplicate edges + track accessCount
    expect(accessCypher.toUpperCase()).toContain("MERGE");
    expect(accessCypher).toContain("accessCount");
  });

  it("MCP_SM_05: includes confident:true when BM25 matches exist", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Relevant result", rrfScore: 0.05, textRank: 1, vectorRank: 2, createdAt: "2026-01-15", categories: [] },
    ] as any);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "relevant" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.confident).toBe(true);
    expect(parsed.message).toContain("Found relevant results");
    expect(parsed.results).toHaveLength(1);
  });

  it("MCP_SM_06: includes confident:false when all text_rank null and low scores", async () => {
    // Simulate irrelevant query — vector-only results with scores below 0.012 threshold
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Unrelated A", rrfScore: 0.010, textRank: null, vectorRank: 5, createdAt: "2026-01-15", categories: [] },
      { id: "m2", content: "Unrelated B", rrfScore: 0.008, textRank: null, vectorRank: 8, createdAt: "2026-01-14", categories: [] },
    ] as any);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "quantum blockchain NFT" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.confident).toBe(false);
    expect(parsed.message).toContain("confidence is LOW");
    expect(parsed.results).toHaveLength(2);
  });

  it("MCP_SM_07: confident:true when no text_rank but high RRF scores", async () => {
    // Vector-only match but with high score (above 0.012 confidence threshold)
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Semantically close", rrfScore: 0.03, textRank: null, vectorRank: 1, createdAt: "2026-01-15", categories: [] },
    ] as any);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "semantic match only" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.confident).toBe(true);
    expect(parsed.message).toContain("Found relevant results");
  });

  it("MCP_SM_08: confident:true when results are empty (nothing to misjudge)", async () => {
    mockHybridSearch.mockResolvedValueOnce([] as any);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "nothing matches" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.confident).toBe(true);
    expect(parsed.message).toContain("No results found");
    expect(parsed.results).toHaveLength(0);
  });

  it("MCP_FILTER_FETCH_01: fetches 5× limit candidates when category filter active (MCP-FILTER-02)", async () => {
    // With limit=5 and a category filter, hybridSearch topK must be 25 (5 × 5)
    mockHybridSearch.mockResolvedValueOnce([]);
    mockRunWrite.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search_memory",
      arguments: { query: "find me something", category: "technology", limit: 5 },
    });

    expect(mockHybridSearch).toHaveBeenCalledWith(
      "find me something",
      expect.objectContaining({ topK: 25 })
    );
  });

  it("MCP_FILTER_FETCH_02: fetches min(10×, 200) candidates when tag filter active (MCP-FILTER-02 + MCP-TAG-RECALL-02)", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);
    mockRunWrite.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search_memory",
      arguments: { query: "tagged query", tag: "session-42", limit: 4 },
    });

    // MCP-TAG-RECALL-02: tag search uses Math.max(limit*10, 200) → 200
    expect(mockHybridSearch).toHaveBeenCalledWith(
      "tagged query",
      expect.objectContaining({ topK: 200 })
    );
  });

  it("MCP_FILTER_FETCH_03: uses exact limit as topK when no post-filters active (MCP-FILTER-02)", async () => {
    // Without filters, fetchLimit === effectiveLimit (no 3× overhead)
    mockHybridSearch.mockResolvedValueOnce([]);
    mockRunWrite.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search_memory",
      arguments: { query: "plain query", limit: 7 },
    });

    expect(mockHybridSearch).toHaveBeenCalledWith(
      "plain query",
      expect.objectContaining({ topK: 7 })
    );
  });
});

// ---------------------------------------------------------------------------
describe("MCP Tool Handlers — search_memory (browse mode)", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("MCP_SM_BROWSE_01: no query returns paginated shape { total, offset, limit, results }", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "m1", content: "Memory one", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: ["work"], total: 3 },
        { id: "m2", content: "Memory two", createdAt: "2026-01-02", updatedAt: "2026-01-02", categories: [], total: 3 },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: {},  // no query → browse mode
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed).toHaveProperty("total", 3);
    expect(parsed).toHaveProperty("offset", 0);
    expect(parsed).toHaveProperty("limit", 50);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toHaveProperty("id", "m1");
    expect(parsed.results[0]).toHaveProperty("memory", "Memory one");
    // Semantic date: created_at present, no updated_at when createdAt === updatedAt
    expect(parsed.results[0]).toHaveProperty("created_at");
    expect(parsed.results[0].created_at).toMatch(/^2026-01-01/);
    expect(parsed.results[0]).not.toHaveProperty("updated_at");
    // browse mode must NOT call hybridSearch
    expect(mockHybridSearch).not.toHaveBeenCalled();
  });

  it("MCP_SM_BROWSE_02: offset parameter forwarded to SKIP clause", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "m6", content: "Memory six", createdAt: "2026-01-06", updatedAt: "2026-01-06", categories: [], total: 10 },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { offset: 5, limit: 1 },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.offset).toBe(5);
    expect(parsed.limit).toBe(1);

    const paginationCypher = mockRunRead.mock.calls[0][0] as string;
    expect(paginationCypher).toContain("$offset");
    expect(paginationCypher).toContain("$limit");
  });

  it("MCP_SM_BROWSE_03: clamps limit to max 200", async () => {
    mockRunRead
      .mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { limit: 9999 },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.limit).toBe(200);
  });

  it("MCP_SM_BROWSE_04: results include categories per memory", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "m1", content: "Test", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: ["architecture", "decisions"], total: 1 },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: {},
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results[0].categories).toEqual(["architecture", "decisions"]);

    const cypher = mockRunRead.mock.calls[0][0] as string;
    expect(cypher).toContain("HAS_CATEGORY");
    expect(cypher).toContain("Category");
  });

  it("MCP_SM_BROWSE_05: category filter applied in browse mode", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "m1", content: "Test", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: ["security"], total: 1 },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { category: "security" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);

    const cypher = mockRunRead.mock.calls[0][0] as string;
    expect(cypher).toContain("toLower(cFilter.name) = toLower($category)");
  });

  it("MCP_SM_BROWSE_06: empty string query also triggers browse mode", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "m1", content: "A", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: [], total: 2 },
        { id: "m2", content: "B", createdAt: "2026-01-02", updatedAt: "2026-01-02", categories: [], total: 2 },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "   " },  // whitespace-only → browse mode
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed).toHaveProperty("total");
    expect(parsed.results).toHaveLength(2);
    expect(mockHybridSearch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEW: Intent classification tests (INVALIDATE / DELETE_ENTITY / fail-open)
// ---------------------------------------------------------------------------
describe("MCP Tool Handlers -- add_memories intent classification", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_ADD_09: INVALIDATE intent routes to invalidateMemoriesByDescription", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "INVALIDATE" as const,
      target: "Alice's phone number",
    });
    mockInvalidateMemories.mockResolvedValueOnce([
      { id: "inv-1", content: "Alice phone is 555-1234" },
      { id: "inv-2", content: "Alice mobile is 555-5678" },
    ]);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Forget Alice phone number"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.invalidated).toBe(2);
    expect(parsed).not.toHaveProperty("ids");
    expect(mockInvalidateMemories).toHaveBeenCalledWith(
      "Alice's phone number",
      "test-user"
    );
    // Should NOT call addMemory for INVALIDATE intents
    expect(mockAddMemory).not.toHaveBeenCalled();
  });

  it("MCP_ADD_10: DELETE_ENTITY intent routes to deleteEntityByNameOrId", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "DELETE_ENTITY" as const,
      entityName: "Alice",
    });
    mockDeleteEntity.mockResolvedValueOnce({
      entity: "Alice",
      mentionEdgesRemoved: 3,
      relationshipsRemoved: 1,
    });

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Stop tracking Alice"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.deleted).toBe("Alice");
    expect(parsed).not.toHaveProperty("ids");
    expect(mockDeleteEntity).toHaveBeenCalledWith(
      "test-user",
      undefined,
      "Alice"
    );
    expect(mockAddMemory).not.toHaveBeenCalled();
  });

  it("MCP_ADD_11: classifier failure defaults to STORE (fail-open)", async () => {
    mockClassifyIntent.mockRejectedValueOnce(new Error("LLM timeout"));
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("stored-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Forget my email"] },
    });

    const parsed = parseToolResult(result as any) as any;
    // Should fall back to STORE when classifier throws
    expect(parsed.stored).toBe(1);
    expect(parsed.ids).toEqual(["stored-id"]);
    expect(mockAddMemory).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEW: Entity enrichment in search_memory
// ---------------------------------------------------------------------------
describe("MCP Tool Handlers -- search_memory entity enrichment", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_SM_05: search response includes entity profiles by default", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Alice works at Acme", rrfScore: 0.03, textRank: 1, vectorRank: 1, categories: ["work"], tags: [], createdAt: "2024-01-01", updatedAt: "2024-01-01", appName: "test-client" },
    ]);
    mockRunRead.mockResolvedValueOnce([{ appName: "test-client", lastAccessed: "2024-01-01" }]);
    mockSearchEntities.mockResolvedValueOnce([
      {
        id: "e1",
        name: "Alice",
        type: "PERSON",
        description: "Engineer",
        metadata: {},
        memoryCount: 5,
        relationships: [{ source: "Alice", target: "Acme", type: "WORKS_AT", description: null, metadata: {} }],
      },
    ]);

    const result = await client.callTool({
      name: "search_memory",
      // No include_entities param — default is true
      arguments: { query: "Alice" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    expect(parsed.entities).toBeDefined();
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].name).toBe("Alice");
    expect(parsed.entities[0].relationships).toHaveLength(1);
    expect(mockSearchEntities).toHaveBeenCalledWith("Alice", "test-user", { limit: 5 });
  });

  it("MCP_SM_06: include_entities=false skips entity enrichment", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Alice works at Acme", rrfScore: 0.03, textRank: 1, vectorRank: 1, categories: ["work"], tags: [], createdAt: "2024-01-01", updatedAt: "2024-01-01", appName: "test-client" },
    ]);
    mockRunRead.mockResolvedValueOnce([{ appName: "test-client", lastAccessed: "2024-01-01" }]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "Alice", include_entities: false },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    expect(parsed.entities).toBeUndefined();
    expect(mockSearchEntities).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Extraction drain (Tantivy concurrency prevention)
// ---------------------------------------------------------------------------
describe("MCP add_memories -- extraction drain (Tantivy concurrency prevention)", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_ADD_DRAIN: entity extraction from item N completes before item N+1's addMemory starts", async () => {
    const execOrder: string[] = [];

    // Item 1 extraction takes 50ms -- should be awaited (drain) before item 2 addMemory
    mockCheckDeduplication.mockResolvedValue({ action: "add" } as any);
    mockAddMemory
      .mockImplementationOnce(async () => {
        execOrder.push("addMemory-1");
        return "id-1";
      })
      .mockImplementationOnce(async () => {
        execOrder.push("addMemory-2");
        return "id-2";
      });

    let extraction1Resolved = false;
    mockProcessEntityExtraction
      .mockImplementationOnce(async () => {
        execOrder.push("extraction-1-start");
        await new Promise<void>((r) => setTimeout(r, 50));
        extraction1Resolved = true;
        execOrder.push("extraction-1-done");
      })
      .mockImplementationOnce(async () => {
        execOrder.push("extraction-2-start");
      });

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["memory one", "memory two"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(2);
    expect(parsed.ids).toEqual(["id-1", "id-2"]);

    // extraction-1-done must appear before addMemory-2 in the execution order
    const ext1DoneIdx = execOrder.indexOf("extraction-1-done");
    const addMem2Idx = execOrder.indexOf("addMemory-2");
    if (ext1DoneIdx !== -1 && addMem2Idx !== -1) {
      expect(ext1DoneIdx).toBeLessThan(addMem2Idx);
    }
    // extraction-1 must have resolved
    expect(extraction1Resolved).toBe(true);
  });

  it("MCP_ADD_DRAIN_TIMEOUT: if extraction hangs >3 s batch continues (does not deadlock)", async () => {
    jest.useFakeTimers({ advanceTimers: false });

    mockCheckDeduplication.mockResolvedValue({ action: "add" } as any);
    mockAddMemory
      .mockResolvedValueOnce("id-1")
      .mockResolvedValueOnce("id-2");

    // Item 1 extraction never resolves (simulates a hung Tantivy writer)
    let hangResolved = false;
    mockProcessEntityExtraction
      .mockImplementationOnce(
        () => new Promise<void>((r) => {
          // resolve after 10 s (beyond the 3 s drain timeout)
          setTimeout(() => { hangResolved = true; r(); }, 10_000);
        })
      )
      .mockResolvedValueOnce(undefined);

    const callPromise = client.callTool({
      name: "add_memories",
      arguments: { content: ["memory one", "memory two"] },
    });

    // Advance fake timers by 3.1 s to trigger the drain timeout
    await jest.advanceTimersByTimeAsync(3_100);

    const result = await callPromise;
    const parsed = parseToolResult(result as any) as any;

    // Both items must have been processed (batch didn't hang)
    expect(parsed.stored).toBe(2);
    expect(parsed.ids).toEqual(["id-1", "id-2"]);
    // The extraction was NOT yet resolved (we only advanced 3.1 s, timeout is 10 s)
    expect(hangResolved).toBe(false);

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// NEW: tags support in add_memories / search_memory (Session 18 audit fix)
// ---------------------------------------------------------------------------
describe("MCP Tool Handlers — tags support", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // mockReset clears the Once queue too (clearAllMocks only clears call history).
    // Needed because entity-enrichment tests queue mockRunRead.Once values that are
    // never consumed (the search path uses no runRead), and they'd leak into these tests.
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_TAG_01: add_memories with tags passes them to addMemory and writes SET m.tags", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("tag-mem-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "Alice prefers dark mode", tags: ["audit-17", "ux"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(1);
    expect(parsed.ids).toEqual(["tag-mem-id"]);

    // addMemory called with tags in opts
    expect(mockAddMemory).toHaveBeenCalledWith(
      "Alice prefers dark mode",
      expect.objectContaining({ tags: ["audit-17", "ux"] })
    );

    // On ADD path, tags are passed directly to addMemory (no separate SET m.tags patch needed).
    // The SET m.tags patch only fires on the SUPERSEDE path.
    const tagWriteCalls = mockRunWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("SET m.tags")
    );
    expect(tagWriteCalls).toHaveLength(0);
  });

  it("MCP_TAG_02: search_memory(tag) filters hybrid results to only matching tag (case-insensitive)", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Tagged mem",   rrfScore: 0.05, textRank: 1, vectorRank: 1, createdAt: "2026-01-15", categories: [], tags: ["session-17", "prod"] },
      { id: "m2", content: "Other mem",    rrfScore: 0.04, textRank: 2, vectorRank: 2, createdAt: "2026-01-14", categories: [], tags: ["other-tag"] },
      { id: "m3", content: "No tags mem",  rrfScore: 0.03, textRank: 3, vectorRank: 3, createdAt: "2026-01-13", categories: [], tags: [] },
    ] as any);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "Alice", tag: "SESSION-17" },  // upper-case to verify case-insensitive
    });

    const parsed = parseToolResult(result as any) as any;
    // Only m1 has "session-17" (case-insensitively)
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].id).toBe("m1");
  });

  it("MCP_TAG_03: browse mode with tag passes tag to runRead and includes tag clause in Cypher", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { id: "m1", content: "Test mem", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: [], total: 1 },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { tag: "session-17" },  // no query → browse mode
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed).toHaveProperty("total", 1);
    expect(parsed.results).toHaveLength(1);

    // Single combined query — params must include tag
    const queryParams = mockRunRead.mock.calls[0][1] as Record<string, unknown>;
    expect(queryParams).toHaveProperty("tag", "session-17");

    // Cypher must filter by tag
    const queryCypher = mockRunRead.mock.calls[0][0] as string;
    expect(queryCypher).toContain("toLower($tag)");
  });

  it("MCP_BROWSE_NO_UNDEF_PARAMS: browse without tag/category — no undefined keys in runRead params", async () => {
    mockRunRead
      .mockResolvedValueOnce([]);

    await client.callTool({
      name: "search_memory",
      arguments: {},  // no tag, no category
    });

    for (const call of mockRunRead.mock.calls) {
      const params = call[1] as Record<string, unknown>;
      if (params && typeof params === "object") {
        expect(params).not.toHaveProperty("tag");
        expect(params).not.toHaveProperty("category");
        // Ensure no value is undefined (would cause Memgraph to error)
        for (const val of Object.values(params)) {
          expect(val).not.toBeUndefined();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NEW: Global drain budget cap across entire batch (MCP-02)
// ---------------------------------------------------------------------------
describe("MCP add_memories — global drain budget (MCP-02)", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset(); // clear orphaned Once values from prior describe blocks
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_ADD_DRAIN_GLOBAL_BUDGET: 5-item batch with hanging extractions completes once 12 s budget exhausted", async () => {
    jest.useFakeTimers({ advanceTimers: false });

    // All 5 items: dedup → add → extraction hangs for 10 s each
    mockCheckDeduplication
      .mockResolvedValue({ action: "add" } as any);
    mockAddMemory
      .mockResolvedValueOnce("id-1")
      .mockResolvedValueOnce("id-2")
      .mockResolvedValueOnce("id-3")
      .mockResolvedValueOnce("id-4")
      .mockResolvedValueOnce("id-5");

    const extractionSettled: boolean[] = [false, false, false, false, false];
    mockProcessEntityExtraction.mockImplementation(async () => {
      const i = mockProcessEntityExtraction.mock.calls.length - 1;
      await new Promise<void>((r) => setTimeout(r, 10_000));
      extractionSettled[i] = true;
    });

    const callPromise = client.callTool({
      name: "add_memories",
      arguments: { content: ["Item 1", "Item 2", "Item 3", "Item 4", "Item 5"] },
    });

    // Advance timers by 15 s — this covers both the per-item 3 s caps
    // AND exhausts the 12 s global budget so remaining items get 0 ms drain.
    await jest.advanceTimersByTimeAsync(15_000);

    const result = await callPromise;
    const parsed = parseToolResult(result as any) as any;

    // All 5 items processed — global budget exhaustion must not block
    expect(parsed.stored).toBe(5);
    expect(parsed.ids).toEqual(["id-1", "id-2", "id-3", "id-4", "id-5"]);

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #1 — semantic date fields in search results (MCP-UPDATED-AT-01)
// ---------------------------------------------------------------------------
describe("MCP search_memory — semantic date fields", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_UPDATED_AT_01: search mode results include semantic date fields", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      {
        id: "m1", content: "Alice works at Acme", rrfScore: 0.03, textRank: 1, vectorRank: 1,
        categories: ["work"], tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-15", appName: "test-client",
      },
    ]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "Alice" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    // Semantic date format: "YYYY-MM-DD (bucket)"
    expect(parsed.results[0].created_at).toMatch(/^2026-01-01 \(/);
    // updated_at present because updatedAt (Jan 15) differs from createdAt (Jan 1)
    expect(parsed.results[0].updated_at).toMatch(/^2026-01-15 \(/);
  });

  it("MCP_UPDATED_AT_02: last_modified absent when updatedAt missing from hybrid result", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      {
        id: "m1", content: "No updatedAt field", rrfScore: 0.03, textRank: 1, vectorRank: 1,
        categories: [], tags: [], createdAt: "2026-01-01", appName: "test-client",
        // updatedAt intentionally omitted — falls back to createdAt, which equals createdAt → no last_modified
      } as any,
    ]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "test" },
    });

    const parsed = parseToolResult(result as any) as any;
    // When updatedAt falls back to createdAt, they match → no updated_at emitted
    expect(parsed.results[0].created_at).toMatch(/^2026-01-01 \(/);
    expect(parsed.results[0]).not.toHaveProperty("updated_at");
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #2 — total_matching in search results (MCP-TOTAL-01)
// ---------------------------------------------------------------------------
describe("MCP search_memory — total_matching count", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_TOTAL_01: total_matching reflects pre-limit count when results exceed limit", async () => {
    // Return 5 results but request limit=2
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Mem 1", rrfScore: 0.05, textRank: 1, vectorRank: 1, categories: [], tags: [], createdAt: "2026-01-05", updatedAt: "2026-01-05", appName: "test-client" },
      { id: "m2", content: "Mem 2", rrfScore: 0.04, textRank: 2, vectorRank: 2, categories: [], tags: [], createdAt: "2026-01-04", updatedAt: "2026-01-04", appName: "test-client" },
      { id: "m3", content: "Mem 3", rrfScore: 0.03, textRank: 3, vectorRank: 3, categories: [], tags: [], createdAt: "2026-01-03", updatedAt: "2026-01-03", appName: "test-client" },
      { id: "m4", content: "Mem 4", rrfScore: 0.02, textRank: 4, vectorRank: 4, categories: [], tags: [], createdAt: "2026-01-02", updatedAt: "2026-01-02", appName: "test-client" },
      { id: "m5", content: "Mem 5", rrfScore: 0.01, textRank: 5, vectorRank: 5, categories: [], tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", appName: "test-client" },
    ]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "test", limit: 2 },
    });

    const parsed = parseToolResult(result as any) as any;
    // total_matching = 5 (all results matched), but only 2 returned
    expect(parsed.total_matching).toBe(5);
    expect(parsed.results).toHaveLength(2);
  });

  it("MCP_TOTAL_02: total_matching reflects post-filter count when tag filter applied", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Tagged", rrfScore: 0.05, textRank: 1, vectorRank: 1, categories: [], tags: ["audit"], createdAt: "2026-01-05", updatedAt: "2026-01-05", appName: "test-client" },
      { id: "m2", content: "Untagged", rrfScore: 0.04, textRank: 2, vectorRank: 2, categories: [], tags: [], createdAt: "2026-01-04", updatedAt: "2026-01-04", appName: "test-client" },
      { id: "m3", content: "Also tagged", rrfScore: 0.03, textRank: 3, vectorRank: 3, categories: [], tags: ["audit"], createdAt: "2026-01-03", updatedAt: "2026-01-03", appName: "test-client" },
    ]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "test", tag: "audit", limit: 10 },
    });

    const parsed = parseToolResult(result as any) as any;
    // total_matching = 2 (only 2 matched the tag), all 2 returned (under limit)
    expect(parsed.total_matching).toBe(2);
    expect(parsed.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #3 — tag_filter_warning (MCP-TAG-RECALL-01)
// ---------------------------------------------------------------------------
describe("MCP search_memory — tag filter recall warning", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_TAG_WARN_01: warning emitted when tag filter drops >70% of results", async () => {
    // 10 results from hybridSearch, only 1 has the tag → 10% retention → warning
    const results = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i + 1}`,
      content: `Memory ${i + 1}`,
      rrfScore: 0.05 - i * 0.004,
      textRank: i + 1,
      vectorRank: i + 1,
      categories: [],
      tags: i === 0 ? ["rare-tag"] : [],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      appName: "test-client",
    }));
    mockHybridSearch.mockResolvedValueOnce(results);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "test", tag: "rare-tag" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    expect(parsed).toHaveProperty("tag_filter_warning");
    expect(parsed.tag_filter_warning).toContain("rare-tag");
    expect(parsed.tag_filter_warning).toContain("browse mode");
  });

  it("MCP_TAG_WARN_02: no warning when tag filter retains >30% of results", async () => {
    // 3 results, 2 have the tag → 67% retention → no warning
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "A", rrfScore: 0.05, textRank: 1, vectorRank: 1, categories: [], tags: ["common-tag"], createdAt: "2026-01-01", updatedAt: "2026-01-01", appName: "test-client" },
      { id: "m2", content: "B", rrfScore: 0.04, textRank: 2, vectorRank: 2, categories: [], tags: ["common-tag"], createdAt: "2026-01-01", updatedAt: "2026-01-01", appName: "test-client" },
      { id: "m3", content: "C", rrfScore: 0.03, textRank: 3, vectorRank: 3, categories: [], tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", appName: "test-client" },
    ]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "test", tag: "common-tag" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(2);
    expect(parsed).not.toHaveProperty("tag_filter_warning");
  });

  it("MCP_TAG_WARN_03: no warning when no tag filter is applied", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "A", rrfScore: 0.05, textRank: 1, vectorRank: 1, categories: [], tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", appName: "test-client" },
    ]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "test" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed).not.toHaveProperty("tag_filter_warning");
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #4 — suppress_auto_categories (MCP-CAT-SUPPRESS)
// ---------------------------------------------------------------------------
describe("MCP add_memories — suppress_auto_categories", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_CAT_SUPPRESS_01: suppress_auto_categories=true passes suppressAutoCategories to addMemory", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("cat-sup-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: {
        content: "A finding about security",
        categories: ["Security"],
        suppress_auto_categories: true,
      },
    });

    expect(mockAddMemory).toHaveBeenCalledWith(
      "A finding about security",
      expect.objectContaining({
        suppressAutoCategories: true,
      })
    );
  });

  it("MCP_CAT_SUPPRESS_02: without suppress_auto_categories + categories provided, addMemory receives true (auto-default)", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("cat-no-sup-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: {
        content: "A normal memory",
        categories: ["Work"],
      },
    });

    expect(mockAddMemory).toHaveBeenCalledWith(
      "A normal memory",
      expect.objectContaining({
        suppressAutoCategories: true,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #5 — SUPERSEDE provenance tags (SUPERSEDE-PROVENANCE)
// ---------------------------------------------------------------------------
// Note: provenance tag merging happens in write.ts (supersedeMemory), not in
// server.ts. The MCP layer forwards explicit tags to supersedeMemory. The merge
// logic is tested in write.test.ts. Here we verify the dead-code SET m.tags
// was removed (MCP-SUPERSEDE-TAG-01) and tags are passed correctly.
describe("MCP add_memories — SUPERSEDE provenance (dead-code removal)", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_PROV_01: supersede path does NOT issue separate SET m.tags runWrite (dead-code removed)", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({
      action: "supersede",
      existingId: "old-prov-id",
    } as any);
    mockSupersedeMemory.mockResolvedValueOnce("new-prov-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: { content: "Updated finding", tags: ["session-17", "session-18"] },
    });

    // supersedeMemory called with tags
    expect(mockSupersedeMemory).toHaveBeenCalledWith(
      "old-prov-id",
      "Updated finding",
      "test-user",
      "test-client",
      ["session-17", "session-18"]
    );

    // No separate SET m.tags runWrite call — dead code removed
    const tagWriteCalls = mockRunWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("SET m.tags")
    );
    expect(tagWriteCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #6 — intra-batch dedup (MCP-BATCH-DEDUP)
// ---------------------------------------------------------------------------
describe("MCP add_memories — intra-batch dedup", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_BATCH_DEDUP_01: exact duplicate within batch is skipped", async () => {
    // Two identical items in the same batch
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("first-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Alice likes coffee", "Alice likes coffee"] },
    });

    const parsed = parseToolResult(result as any) as any;
    // First item stored, second skipped as intra-batch duplicate
    expect(parsed.stored).toBe(1);
    expect(parsed.skipped).toBe(1);
    expect(parsed.ids).toEqual(["first-id"]);
    // checkDeduplication only called once (for the first item)
    expect(mockCheckDeduplication).toHaveBeenCalledTimes(1);
  });

  it("MCP_BATCH_DEDUP_02: case/whitespace-normalized duplicates are caught", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("first-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Alice likes coffee", "  alice   likes   COFFEE  "] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(1);
    expect(parsed.skipped).toBe(1);
  });

  it("MCP_BATCH_DEDUP_03: distinct items in batch are all processed", async () => {
    mockCheckDeduplication
      .mockResolvedValueOnce({ action: "add" } as any)
      .mockResolvedValueOnce({ action: "add" } as any)
      .mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory
      .mockResolvedValueOnce("id-1")
      .mockResolvedValueOnce("id-2")
      .mockResolvedValueOnce("id-3");
    mockProcessEntityExtraction.mockResolvedValue(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Fact one", "Fact two", "Fact three"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(3);
    expect(parsed.ids).toEqual(["id-1", "id-2", "id-3"]);
    expect(mockCheckDeduplication).toHaveBeenCalledTimes(3);
  });

  it("MCP_BATCH_DEDUP_04: intra-batch dedup only applies to STORE intents", async () => {
    // Item 1 is STORE (gets added), item 2 has different intent (INVALIDATE)
    // → should NOT be caught by intra-batch dedup (intent is checked before dedup)
    mockClassifyIntent
      .mockResolvedValueOnce({ type: "STORE" as const })
      .mockResolvedValueOnce({ type: "INVALIDATE" as const, target: "coffee" });
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("stored-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);
    mockInvalidateMemories.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: ["Alice likes coffee", "Forget Alice likes coffee"] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBe(1);
    // INVALIDATE intent is not skipped — it processed independently
    expect(mockInvalidateMemories).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #1 — suppress_auto_categories auto-default
// ---------------------------------------------------------------------------
describe("MCP add_memories — auto-suppress categories when explicit categories provided", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_CAT_AUTO_SUPPRESS_01: categories provided + no suppress flag → auto-suppressed (true)", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("auto-sup-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: { content: "Security audit finding", categories: ["Security", "Architecture"] },
    });

    expect(mockAddMemory).toHaveBeenCalledWith(
      "Security audit finding",
      expect.objectContaining({ suppressAutoCategories: true })
    );
  });

  it("MCP_CAT_AUTO_SUPPRESS_02: categories provided + suppress=false → explicitly NOT suppressed", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("no-sup-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: {
        content: "Security finding with enrichment wanted",
        categories: ["Security"],
        suppress_auto_categories: false,
      },
    });

    expect(mockAddMemory).toHaveBeenCalledWith(
      "Security finding with enrichment wanted",
      expect.objectContaining({ suppressAutoCategories: false })
    );
  });

  it("MCP_CAT_AUTO_SUPPRESS_03: NO categories → suppress stays false (default)", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("default-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: { content: "A plain memory without explicit categories" },
    });

    expect(mockAddMemory).toHaveBeenCalledWith(
      "A plain memory without explicit categories",
      expect.objectContaining({ suppressAutoCategories: false })
    );
  });

  it("MCP_CAT_AUTO_SUPPRESS_04: empty categories array → suppress stays false", async () => {
    mockCheckDeduplication.mockResolvedValueOnce({ action: "add" } as any);
    mockAddMemory.mockResolvedValueOnce("empty-cat-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: { content: "Memory with empty categories", categories: [] },
    });

    expect(mockAddMemory).toHaveBeenCalledWith(
      "Memory with empty categories",
      expect.objectContaining({ suppressAutoCategories: false })
    );
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #3 — TOUCH intent (refresh timestamp)
// ---------------------------------------------------------------------------
describe("MCP add_memories — TOUCH intent", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_TOUCH_01: TOUCH intent calls touchMemoryByDescription and returns touched count + IDs", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "TOUCH" as const,
      target: "CLUSTER-ISOLATION-01 is still unfixed",
    });
    mockTouchMemory.mockResolvedValueOnce({ id: "touched-id", content: "CLUSTER-ISOLATION-01 finding" });

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "Still relevant: CLUSTER-ISOLATION-01" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.touched).toBe(1);
    expect(parsed.touched_ids).toEqual(["touched-id"]);
    // No explicit tags in arguments → explicitTags is undefined
    expect(mockTouchMemory).toHaveBeenCalledWith("CLUSTER-ISOLATION-01 is still unfixed", "test-user", undefined);
  });

  it("MCP_TOUCH_02: TOUCH with no match returns graceful empty response", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "TOUCH" as const,
      target: "nonexistent finding",
    });
    mockTouchMemory.mockResolvedValueOnce(null);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "Still relevant: nonexistent finding" },
    });

    const parsed = parseToolResult(result as any) as any;
    // No touched count when nothing was found
    expect(parsed.touched).toBeUndefined();
    expect(mockTouchMemory).toHaveBeenCalled();
  });

  it("MCP_TOUCH_03: TOUCH does not trigger dedup pipeline or addMemory", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "TOUCH" as const,
      target: "some finding",
    });
    mockTouchMemory.mockResolvedValueOnce({ id: "t-id", content: "some finding" });

    await client.callTool({
      name: "add_memories",
      arguments: { content: "Confirm: some finding still applies" },
    });

    expect(mockCheckDeduplication).not.toHaveBeenCalled();
    expect(mockAddMemory).not.toHaveBeenCalled();
    expect(mockSupersedeMemory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #4 — RESOLVE intent (mark as resolved)
// ---------------------------------------------------------------------------
describe("MCP add_memories — RESOLVE intent", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_RESOLVE_01: RESOLVE intent calls resolveMemoryByDescription and returns resolved count + IDs", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "RESOLVE" as const,
      target: "TTL cache issue in config helpers",
    });
    mockResolveMemory.mockResolvedValueOnce({ id: "resolved-id", content: "CONFIG-NO-TTL-CACHE-01" });

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "Resolved: CONFIG-NO-TTL-CACHE-01" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.resolved).toBe(1);
    expect(parsed.resolved_ids).toEqual(["resolved-id"]);
    expect(mockResolveMemory).toHaveBeenCalledWith("TTL cache issue in config helpers", "test-user");
  });

  it("MCP_RESOLVE_02: RESOLVE with no match returns graceful empty response", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "RESOLVE" as const,
      target: "nonexistent bug",
    });
    mockResolveMemory.mockResolvedValueOnce(null);

    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: "Mark as fixed: nonexistent bug" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.resolved).toBeUndefined();
    expect(mockResolveMemory).toHaveBeenCalled();
  });

  it("MCP_RESOLVE_03: RESOLVE does not trigger dedup pipeline or addMemory", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "RESOLVE" as const,
      target: "some bug",
    });
    mockResolveMemory.mockResolvedValueOnce({ id: "r-id", content: "some bug" });

    await client.callTool({
      name: "add_memories",
      arguments: { content: "This has been fixed: some bug" },
    });

    expect(mockCheckDeduplication).not.toHaveBeenCalled();
    expect(mockAddMemory).not.toHaveBeenCalled();
    expect(mockSupersedeMemory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEW: Improvement #2 — Tag search recall (minimum topK)
// ---------------------------------------------------------------------------
describe("MCP search_memory — tag recall minimum topK", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_TAG_RECALL_MIN_01: tag filter enforces minimum topK of 200 regardless of limit", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search_memory",
      arguments: { query: "security findings", tag: "audit-session-19", limit: 5 },
    });

    // With limit=5, normal tag multiplier would be 5*10=50
    // But minimum topK of 200 should be used instead
    // MCP-TAG-RECALL-03: candidateSize scaled to fetchLimit for tag search recall
    expect(mockHybridSearch).toHaveBeenCalledWith("security findings", {
      userId: "test-user",
      topK: 200,
      mode: "hybrid",
      candidateSize: 200,
    });
  });

  it("MCP_TAG_RECALL_MIN_02: without tag, topK uses normal multiplier (no 200 minimum)", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search_memory",
      arguments: { query: "security findings", limit: 5 },
    });

    // No tag → multiplier is 1, topK = 5*1 = 5
    expect(mockHybridSearch).toHaveBeenCalledWith("security findings", {
      userId: "test-user",
      topK: 5,
      mode: "hybrid",
    });
  });

  it("MCP_TAG_RECALL_MIN_03: tag with high limit uses 10x multiplier when > 200", async () => {
    mockHybridSearch.mockResolvedValueOnce([]);

    await client.callTool({
      name: "search_memory",
      arguments: { query: "findings", tag: "project-x", limit: 50 },
    });

    // limit=50, tag multiplier 10x = 500 > 200, use 500
    // MCP-TAG-RECALL-03: candidateSize scaled to fetchLimit for tag search recall
    expect(mockHybridSearch).toHaveBeenCalledWith("findings", {
      userId: "test-user",
      topK: 500,
      mode: "hybrid",
      candidateSize: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// NEW: Fix 1 — TOUCH tag inheritance
// ---------------------------------------------------------------------------
describe("MCP add_memories — TOUCH tag inheritance", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockReset();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_TOUCH_TAG_01: TOUCH with tags passes them to touchMemoryByDescription", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "TOUCH" as const,
      target: "CLUSTER-ISOLATION-01 finding",
    });
    mockTouchMemory.mockResolvedValueOnce({ id: "t-id", content: "CLUSTER-ISOLATION-01 finding" });

    const result = await client.callTool({
      name: "add_memories",
      arguments: {
        content: "Still relevant: CLUSTER-ISOLATION-01",
        tags: ["audit-session-24", "mem0ai/mem0"],
      },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.touched).toBe(1);
    expect(parsed.touched_ids).toEqual(["t-id"]);
    // Tags should be forwarded to touchMemoryByDescription
    expect(mockTouchMemory).toHaveBeenCalledWith(
      "CLUSTER-ISOLATION-01 finding",
      "test-user",
      ["audit-session-24", "mem0ai/mem0"]
    );
  });

  it("MCP_TOUCH_TAG_02: TOUCH without tags passes undefined", async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      type: "TOUCH" as const,
      target: "some finding",
    });
    mockTouchMemory.mockResolvedValueOnce({ id: "t-id", content: "some finding" });

    await client.callTool({
      name: "add_memories",
      arguments: { content: "Confirm: some finding" },
    });

    expect(mockTouchMemory).toHaveBeenCalledWith("some finding", "test-user", undefined);
  });
});

// ---------------------------------------------------------------------------
// NEW: include_entities default true verification
// ---------------------------------------------------------------------------
describe("MCP search_memory — include_entities default true", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunRead.mockResolvedValue([]);
    mockRunWrite.mockResolvedValue([]);
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_ENTITIES_DEFAULT_01: search without include_entities enriches entities by default", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Alice works at Acme", rrfScore: 0.03, textRank: 1, vectorRank: 1, categories: ["work"], tags: [], createdAt: "2024-01-01", updatedAt: "2024-01-01", appName: "test-client" },
    ]);
    mockRunWrite.mockResolvedValueOnce([]);
    mockSearchEntities.mockResolvedValueOnce([
      { id: "e1", name: "Alice", type: "PERSON", description: "Engineer", metadata: {}, memoryCount: 5, relationships: [] },
    ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "Alice" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].name).toBe("Alice");
    expect(mockSearchEntities).toHaveBeenCalledWith("Alice", "test-user", { limit: 5 });
  });

  it("MCP_ENTITIES_DEFAULT_02: include_entities=false explicitly skips enrichment", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Alice works at Acme", rrfScore: 0.03, textRank: 1, vectorRank: 1, categories: ["work"], tags: [], createdAt: "2024-01-01", updatedAt: "2024-01-01", appName: "test-client" },
    ]);
    mockRunWrite.mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { query: "Alice", include_entities: false },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);
    expect(parsed.entities).toBeUndefined();
    expect(mockSearchEntities).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEW: Explicit replaces parameter tests
// ---------------------------------------------------------------------------
describe("MCP add_memories — explicit replaces parameter", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await setupClientServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockClassifyIntent.mockResolvedValue({ type: "STORE" as const });
    mockSearchEntities.mockResolvedValue([]);
  });

  it("MCP_REPLACES_01: replaces calls supersedeMemory directly and bypasses checkDeduplication", async () => {
    mockSupersedeMemory.mockResolvedValueOnce("new-superseded-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    const result = await client.callTool({
      name: "add_memories",
      arguments: {
        content: "Barcelona trip: now going to Amsterdam instead",
        replaces: "old-itinerary-id",
      },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.stored).toBeUndefined();
    expect(parsed.superseded).toBe(1);
    expect(parsed.ids).toEqual(["new-superseded-id"]);

    // supersedeMemory called with the explicit old ID
    expect(mockSupersedeMemory).toHaveBeenCalledWith(
      "old-itinerary-id",
      "Barcelona trip: now going to Amsterdam instead",
      "test-user",
      "test-client",
      undefined // no tags
    );

    // checkDeduplication should NOT be called — replaces bypasses dedup
    expect(mockCheckDeduplication).not.toHaveBeenCalled();
  });

  it("MCP_REPLACES_02: replaces with tags forwards tags to supersedeMemory", async () => {
    mockSupersedeMemory.mockResolvedValueOnce("new-tagged-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: {
        content: "Updated travel plan",
        replaces: "old-plan-id",
        tags: ["travel", "europe-2026"],
      },
    });

    expect(mockSupersedeMemory).toHaveBeenCalledWith(
      "old-plan-id",
      "Updated travel plan",
      "test-user",
      "test-client",
      ["travel", "europe-2026"]
    );
  });

  it("MCP_REPLACES_03: replaces with categories writes HAS_CATEGORY edges", async () => {
    mockSupersedeMemory.mockResolvedValueOnce("cat-superseded-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);
    mockRunWrite.mockResolvedValueOnce([]); // for category MERGE

    await client.callTool({
      name: "add_memories",
      arguments: {
        content: "New diet plan: high protein",
        replaces: "old-diet-id",
        categories: ["Health", "Nutrition"],
      },
    });

    // Categories written via UNWIND MERGE
    expect(mockRunWrite).toHaveBeenCalledWith(
      expect.stringContaining("UNWIND $categories AS catName"),
      expect.objectContaining({
        userId: "test-user",
        memId: "cat-superseded-id",
        categories: ["Health", "Nutrition"],
      })
    );
  });

  it("MCP_REPLACES_04: replaces fires entity extraction for the new memory", async () => {
    mockSupersedeMemory.mockResolvedValueOnce("entity-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: {
        content: "Alice now works at Google",
        replaces: "old-alice-id",
      },
    });

    expect(mockProcessEntityExtraction).toHaveBeenCalledWith("entity-id");
  });

  it("MCP_REPLACES_05: replaces does not trigger addMemory", async () => {
    mockSupersedeMemory.mockResolvedValueOnce("replaced-id");
    mockProcessEntityExtraction.mockResolvedValueOnce(undefined);

    await client.callTool({
      name: "add_memories",
      arguments: {
        content: "Updated fact",
        replaces: "target-id",
      },
    });

    expect(mockAddMemory).not.toHaveBeenCalled();
  });
});