/**
 * Unit tests — GET /api/v1/memories (API-01: N+1 category batch fix)
 *
 * Verifies that categories for a page of memories are fetched with a single
 * UNWIND batch query rather than one runRead call per memory.
 *
 * Coverage:
 *   ROUTE_CAT_01: list path — N memories → ONE UNWIND + HAS_CATEGORY query
 *   ROUTE_CAT_02: search path — N search results → ONE UNWIND + HAS_CATEGORY query
 *   ROUTE_CAT_03: category filter in list path — only memories matching the filter are returned
 *   ROUTE_CAT_04: empty memory list → no category round-trip at all
 */
export {};

// ---------------------------------------------------------------------------
// Mocks — must precede any imports that trigger the mocked modules
// ---------------------------------------------------------------------------
const mockRunRead = jest.fn();
const mockRunWrite = jest.fn();
jest.mock("@/lib/db/memgraph", () => ({
  runRead: (...args: unknown[]) => mockRunRead(...args),
  runWrite: (...args: unknown[]) => mockRunWrite(...args),
}));

const mockListMemories = jest.fn();
jest.mock("@/lib/memory/search", () => ({
  listMemories: (...args: unknown[]) => mockListMemories(...args),
}));

const mockHybridSearch = jest.fn();
jest.mock("@/lib/search/hybrid", () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

jest.mock("@/lib/dedup", () => ({ checkDeduplication: jest.fn() }));
jest.mock("@/lib/memory/write", () => ({
  addMemory: jest.fn(),
  deleteMemory: jest.fn(),
  supersedeMemory: jest.fn(),
}));
jest.mock("@/lib/entities/worker", () => ({ processEntityExtraction: jest.fn() }));
jest.mock("@/lib/config/helpers", () => ({
  getContextWindowConfig: jest.fn().mockResolvedValue({ enabled: false, size: 0 }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/memories/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRequest(params: Record<string, string>): NextRequest {
  const qs = new URLSearchParams(params).toString();
  return new NextRequest(`http://localhost/api/v1/memories?${qs}`);
}

const BASE_MEMORY = {
  state: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  appName: null,
  metadata: null,
  validAt: "2026-01-01T00:00:00.000Z",
  invalidAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRunWrite.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GET /api/v1/memories — category batch fetch (API-01)", () => {
  it("ROUTE_CAT_01: list path — 3 memories produce ONE UNWIND category query containing all ids", async () => {
    mockListMemories.mockResolvedValue({
      memories: [
        { ...BASE_MEMORY, id: "m1", content: "Alpha" },
        { ...BASE_MEMORY, id: "m2", content: "Beta" },
        { ...BASE_MEMORY, id: "m3", content: "Gamma" },
      ],
      total: 3,
    });

    // Batch category query — returns categories for m1 only
    mockRunRead.mockResolvedValueOnce([
      { id: "m1", name: "Work" },
      { id: "m1", name: "Technology" },
    ]);

    const res = await GET(makeRequest({ user_id: "user" }));
    const body = await res.json();

    // Exactly ONE runRead call hits the category batch (UNWIND + HAS_CATEGORY)
    const catBatchCalls = mockRunRead.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("UNWIND") &&
        c[0].includes("HAS_CATEGORY")
    );
    expect(catBatchCalls).toHaveLength(1);

    // The single batch call includes all 3 ids
    const batchParams = catBatchCalls[0][1] as { ids: string[] };
    expect(batchParams.ids).toEqual(expect.arrayContaining(["m1", "m2", "m3"]));
    expect(batchParams.ids).toHaveLength(3);

    // Categories correctly populated from the batch result
    const results = body.items as Array<{ id: string; categories: string[] }>;
    const m1 = results.find((r) => r.id === "m1");
    const m2 = results.find((r) => r.id === "m2");
    expect(m1?.categories).toEqual(expect.arrayContaining(["Work", "Technology"]));
    expect(m2?.categories).toEqual([]);
  });

  it("ROUTE_CAT_02: search path (search_query) — N results produce ONE UNWIND category query", async () => {
    mockHybridSearch.mockResolvedValue([
      { id: "s1", content: "SearchA", rrfScore: 0.05, textRank: 1, vectorRank: 1, categories: [], tags: [], createdAt: "2026-01-01", appName: null },
      { id: "s2", content: "SearchB", rrfScore: 0.04, textRank: 2, vectorRank: 2, categories: [], tags: [], createdAt: "2026-01-01", appName: null },
    ]);

    // Category batch returns one category for s1
    mockRunRead.mockResolvedValueOnce([{ id: "s1", name: "Finance" }]);

    const res = await GET(makeRequest({ user_id: "user", search_query: "test" }));
    const body = await res.json();

    const catBatchCalls = mockRunRead.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("UNWIND") &&
        c[0].includes("HAS_CATEGORY")
    );
    expect(catBatchCalls).toHaveLength(1);

    const batchParams = catBatchCalls[0][1] as { ids: string[] };
    expect(batchParams.ids).toEqual(expect.arrayContaining(["s1", "s2"]));

    const results = body.items as Array<{ id: string; categories: string[] }>;
    expect(results.find((r) => r.id === "s1")?.categories).toContain("Finance");
    expect(results.find((r) => r.id === "s2")?.categories).toEqual([]);
  });

  it("ROUTE_CAT_03: category filter — only memories in the requested category are returned", async () => {
    mockListMemories.mockResolvedValue({
      memories: [
        { ...BASE_MEMORY, id: "m1", content: "Work related" },
        { ...BASE_MEMORY, id: "m2", content: "Personal stuff" },
      ],
      total: 2,
    });

    // m1 has Work, m2 has Personal
    mockRunRead.mockResolvedValueOnce([
      { id: "m1", name: "Work" },
      { id: "m2", name: "Personal" },
    ]);

    const res = await GET(makeRequest({ user_id: "user", categories: "Work" }));
    const body = await res.json();

    // Only m1 passes the filter
    const results = body.items as Array<{ id: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("m1");
  });

  it("ROUTE_CAT_04: empty memory list — no category UNWIND query issued", async () => {
    mockListMemories.mockResolvedValue({ memories: [], total: 0 });

    await GET(makeRequest({ user_id: "user" }));

    const catBatchCalls = mockRunRead.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("UNWIND") &&
        c[0].includes("HAS_CATEGORY")
    );
    // No memories → no batch query needed
    expect(catBatchCalls).toHaveLength(0);
  });
});
