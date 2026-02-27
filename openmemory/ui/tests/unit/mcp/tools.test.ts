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
import { searchEntities, invalidateMemoriesByDescription, deleteEntityByNameOrId } from "@/lib/mcp/entities";

const mockAddMemory = addMemory as jest.MockedFunction<typeof addMemory>;
const mockSupersedeMemory = supersedeMemory as jest.MockedFunction<typeof supersedeMemory>;
const mockHybridSearch = hybridSearch as jest.MockedFunction<typeof hybridSearch>;
const mockCheckDeduplication = checkDeduplication as jest.MockedFunction<typeof checkDeduplication>;
const mockProcessEntityExtraction = processEntityExtraction as jest.MockedFunction<typeof processEntityExtraction>;
const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
const mockSearchEntities = searchEntities as jest.MockedFunction<typeof searchEntities>;
const mockInvalidateMemories = invalidateMemoriesByDescription as jest.MockedFunction<typeof invalidateMemoriesByDescription>;
const mockDeleteEntity = deleteEntityByNameOrId as jest.MockedFunction<typeof deleteEntityByNameOrId>;

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
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].id).toBe("new-mem-id");
    expect(parsed.results[0].memory).toBe("Alice prefers TypeScript");
    expect(parsed.results[0].event).toBe("ADD");
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
    expect(parsed.results[0].event).toBe("SKIP_DUPLICATE");
    expect(parsed.results[0].id).toBe("existing-id");
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
    expect(parsed.results[0].event).toBe("SUPERSEDE");
    expect(parsed.results[0].id).toBe("superseded-id");
    expect(mockSupersedeMemory).toHaveBeenCalledWith("old-id", "Updated preference", "test-user", "test-client");
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
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results.map((r: any) => r.id)).toEqual(["id-1", "id-2", "id-3"]);
    expect(parsed.results.every((r: any) => r.event === "ADD")).toBe(true);
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
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0].event).toBe("ADD");
    expect(parsed.results[1].event).toBe("ERROR");
    expect(parsed.results[1].error).toBe("DB timeout");
    expect(parsed.results[2].event).toBe("ADD");
  });

  it("MCP_ADD_07: empty array returns { results: [] } immediately", async () => {
    const result = await client.callTool({
      name: "add_memories",
      arguments: { content: [] },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toEqual([]);
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
    expect(parsed.results[0].event).toBe("ADD");
    expect(parsed.results[0].id).toBe("new-id");
    expect(parsed.results[1].event).toBe("SKIP_DUPLICATE");
    expect(parsed.results[1].id).toBe("dup-id");
    expect(parsed.results[2].event).toBe("SUPERSEDE");
    expect(parsed.results[2].id).toBe("supersede-id");
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
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].event).toBe("ADD");
    expect(parsed.results[0].id).toBe("cat-mem-id");

    // runWrite should have been called for each explicit category
    const categoryWriteCalls = mockRunWrite.mock.calls.filter(
      (call) => typeof call[0] === "string" && (call[0] as string).includes("HAS_CATEGORY")
    );
    expect(categoryWriteCalls).toHaveLength(2);
    // Verify category names match what was passed
    const catNames = categoryWriteCalls.map((c) => (c[1] as Record<string, unknown>).name);
    expect(catNames).toContain("Technology");
    expect(catNames).toContain("Work");
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
    expect(parsed.results[0].event).toBe("ADD");

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
        textRank: 1, vectorRank: 2, createdAt: "2026-01-15", categories: ["tech"],
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
    expect(parsed.results[0]).toHaveProperty("raw_score", 0.05);
    expect(parsed.results[0]).toHaveProperty("text_rank", 1);
    expect(parsed.results[0]).toHaveProperty("vector_rank", 2);
    expect(parsed.results[0]).toHaveProperty("categories", ["tech"]);
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
    // Simulate irrelevant query — vector-only results with low RRF scores
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Unrelated A", rrfScore: 0.015, textRank: null, vectorRank: 5, createdAt: "2026-01-15", categories: [] },
      { id: "m2", content: "Unrelated B", rrfScore: 0.012, textRank: null, vectorRank: 8, createdAt: "2026-01-14", categories: [] },
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
    // Vector-only match but with high score (above 0.02 threshold)
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
      .mockResolvedValueOnce([{ total: 3 }])
      .mockResolvedValueOnce([
        { id: "m1", content: "Memory one", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: ["work"] },
        { id: "m2", content: "Memory two", createdAt: "2026-01-02", updatedAt: "2026-01-02", categories: [] },
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
    expect(parsed.results[0]).toHaveProperty("created_at");
    expect(parsed.results[0]).toHaveProperty("updated_at");
    // browse mode must NOT call hybridSearch
    expect(mockHybridSearch).not.toHaveBeenCalled();
  });

  it("MCP_SM_BROWSE_02: offset parameter forwarded to SKIP clause", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ total: 10 }])
      .mockResolvedValueOnce([
        { id: "m6", content: "Memory six", createdAt: "2026-01-06", updatedAt: "2026-01-06", categories: [] },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { offset: 5, limit: 1 },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.offset).toBe(5);
    expect(parsed.limit).toBe(1);

    const paginationCypher = mockRunRead.mock.calls[1][0] as string;
    expect(paginationCypher).toContain("SKIP");
    expect(paginationCypher).toContain("LIMIT");
  });

  it("MCP_SM_BROWSE_03: clamps limit to max 200", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ total: 0 }])
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
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([
        { id: "m1", content: "Test", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: ["architecture", "decisions"] },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: {},
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results[0].categories).toEqual(["architecture", "decisions"]);

    const cypher = mockRunRead.mock.calls[1][0] as string;
    expect(cypher).toContain("HAS_CATEGORY");
    expect(cypher).toContain("Category");
  });

  it("MCP_SM_BROWSE_05: category filter applied in browse mode", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([
        { id: "m1", content: "Test", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: ["security"] },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { category: "security" },
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed.results).toHaveLength(1);

    const countCypher = mockRunRead.mock.calls[0][0] as string;
    expect(countCypher).toContain("toLower(cFilter.name) = toLower($category)");
    const listCypher = mockRunRead.mock.calls[1][0] as string;
    expect(listCypher).toContain("toLower(cFilter.name) = toLower($category)");
  });

  it("MCP_SM_BROWSE_06: empty string query also triggers browse mode", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([
        { id: "m1", content: "A", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: [] },
        { id: "m2", content: "B", createdAt: "2026-01-02", updatedAt: "2026-01-02", categories: [] },
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
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].event).toBe("INVALIDATE");
    expect(parsed.results[0].invalidated).toHaveLength(2);
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
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].event).toBe("DELETE_ENTITY");
    expect(parsed.results[0].deleted).toBeDefined();
    expect(parsed.results[0].deleted.entity).toBe("Alice");
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
    expect(parsed.results).toHaveLength(1);
    // Should fall back to STORE when classifier throws
    expect(parsed.results[0].event).toBe("ADD");
    expect(parsed.results[0].id).toBe("stored-id");
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

  it("MCP_SM_05: search response includes entity profiles when found", async () => {
    mockHybridSearch.mockResolvedValueOnce([
      { id: "m1", content: "Alice works at Acme", rrfScore: 0.03, textRank: 1, vectorRank: 1, categories: ["work"], tags: [], createdAt: "2024-01-01", appName: "test-client" },
    ]);
    mockRunRead.mockResolvedValueOnce([{ appName: "test-client", lastAccessed: "2024-01-01" }]);
    mockSearchEntities.mockResolvedValueOnce([
      {
        id: "e1",
        name: "Alice",
        type: "PERSON",
        description: "Engineer",
        memoryCount: 5,
        relationships: [{ source: "Alice", target: "Acme", type: "WORKS_AT", description: null }],
      },
    ]);

    const result = await client.callTool({
      name: "search_memory",
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
      { id: "m1", content: "Alice works at Acme", rrfScore: 0.03, textRank: 1, vectorRank: 1, categories: ["work"], tags: [], createdAt: "2024-01-01", appName: "test-client" },
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
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].id).toBe("id-1");
    expect(parsed.results[1].id).toBe("id-2");

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
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].id).toBe("id-1");
    expect(parsed.results[1].id).toBe("id-2");
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
    expect(parsed.results[0].event).toBe("ADD");
    expect(parsed.results[0].id).toBe("tag-mem-id");

    // addMemory called with tags in opts
    expect(mockAddMemory).toHaveBeenCalledWith(
      "Alice prefers dark mode",
      expect.objectContaining({ tags: ["audit-17", "ux"] })
    );

    // runWrite called with SET m.tags patch
    const tagWriteCalls = mockRunWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("SET m.tags")
    );
    expect(tagWriteCalls).toHaveLength(1);
    expect((tagWriteCalls[0][1] as Record<string, unknown>).tags).toEqual(["audit-17", "ux"]);
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
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([
        { id: "m1", content: "Test mem", createdAt: "2026-01-01", updatedAt: "2026-01-01", categories: [] },
      ]);

    const result = await client.callTool({
      name: "search_memory",
      arguments: { tag: "session-17" },  // no query → browse mode
    });

    const parsed = parseToolResult(result as any) as any;
    expect(parsed).toHaveProperty("total", 1);
    expect(parsed.results).toHaveLength(1);

    // Count query params must include tag
    const countParams = mockRunRead.mock.calls[0][1] as Record<string, unknown>;
    expect(countParams).toHaveProperty("tag", "session-17");

    // Count query Cypher must filter by tag
    const countCypher = mockRunRead.mock.calls[0][0] as string;
    expect(countCypher).toContain("toLower($tag)");

    // List query params must also include tag
    const listParams = mockRunRead.mock.calls[1][1] as Record<string, unknown>;
    expect(listParams).toHaveProperty("tag", "session-17");
  });

  it("MCP_BROWSE_NO_UNDEF_PARAMS: browse without tag/category — no undefined keys in runRead params", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ total: 0 }])
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
    expect(parsed.results).toHaveLength(5);
    expect(parsed.results.every((r: any) => r.event === "ADD")).toBe(true);
    expect(parsed.results.map((r: any) => r.id)).toEqual([
      "id-1", "id-2", "id-3", "id-4", "id-5",
    ]);

    jest.useRealTimers();
  });
});
