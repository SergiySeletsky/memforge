export {};
/**
 * Unit tests — Memory history audit trail (lib/memory/history.ts)
 *
 * HIST_01: addHistory() calls runWrite with correct params
 * HIST_02: addHistory() uses default createdAt when not provided
 * HIST_03: getHistory() returns records sorted by createdAt DESC
 * HIST_04: getHistory() uses toInteger for LIMIT (Memgraph compat)
 * HIST_05: resetHistory() calls DETACH DELETE
 * HIST_06: addHistory() handles null previous/new values correctly
 * HIST_07: getHistory() returns empty array when no records
 */
jest.mock("@/lib/db/memgraph", () => ({
  runRead: jest.fn(),
  runWrite: jest.fn(),
}));

import { runRead, runWrite } from "@/lib/db/memgraph";
import { addHistory, getHistory, resetHistory } from "@/lib/memory/history";

const mockRunRead = runRead as jest.MockedFunction<typeof runRead>;
const mockRunWrite = runWrite as jest.MockedFunction<typeof runWrite>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("addHistory", () => {
  it("HIST_01: calls runWrite with correct params", async () => {
    mockRunWrite.mockResolvedValueOnce([]);

    await addHistory("mem-1", "old content", "new content", "SUPERSEDE", "2024-01-01T00:00:00Z");

    expect(mockRunWrite).toHaveBeenCalledTimes(1);
    const [query, params] = mockRunWrite.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("MemoryHistory");
    expect(query).toContain("$historyId");
    expect(params).toMatchObject({
      memoryId: "mem-1",
      previousValue: "old content",
      newValue: "new content",
      action: "SUPERSEDE",
      createdAt: "2024-01-01T00:00:00Z",
      isDeleted: 0,
    });
    expect(typeof params.historyId).toBe("string");
    expect((params.historyId as string).length).toBe(13);
  });

  it("HIST_02: uses default createdAt when not provided", async () => {
    mockRunWrite.mockResolvedValueOnce([]);

    const before = new Date().toISOString();
    await addHistory("mem-2", null, "content", "ADD");
    const after = new Date().toISOString();

    const params = mockRunWrite.mock.calls[0]?.[1] as Record<string, string> | undefined;
    // createdAt should be between before and after
    expect(params?.createdAt! >= before).toBe(true);
    expect(params?.createdAt! <= after).toBe(true);
  });

  it("HIST_06: handles null previous/new values", async () => {
    mockRunWrite.mockResolvedValueOnce([]);

    await addHistory("mem-3", null, null, "DELETE");

    const params = mockRunWrite.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(params?.previousValue).toBeNull();
    expect(params?.newValue).toBeNull();
  });
});

describe("getHistory", () => {
  it("HIST_03: returns records (mocked as sorted by createdAt DESC)", async () => {
    mockRunRead.mockResolvedValueOnce([
      {
        id: "h2",
        memoryId: "mem-1",
        previousValue: "old",
        newValue: "new",
        action: "SUPERSEDE",
        createdAt: "2024-01-02T00:00:00Z",
        updatedAt: null,
        isDeleted: 0,
      },
      {
        id: "h1",
        memoryId: "mem-1",
        previousValue: null,
        newValue: "old",
        action: "ADD",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: null,
        isDeleted: 0,
      },
    ]);

    const records = await getHistory("mem-1");

    expect(records).toHaveLength(2);
    expect(records[0].action).toBe("SUPERSEDE");
    expect(records[1].action).toBe("ADD");
  });

  it("HIST_04: query uses toInteger for LIMIT (Memgraph compat)", async () => {
    mockRunRead.mockResolvedValueOnce([]);

    await getHistory("mem-1", 50);

    const [query, params] = mockRunRead.mock.calls[0];
    expect(query).toContain("toInteger($limit)");
    expect(params).toMatchObject({ memoryId: "mem-1", limit: 50 });
  });

  it("HIST_07: returns empty array when no records", async () => {
    mockRunRead.mockResolvedValueOnce([]);

    const records = await getHistory("mem-no-history");
    expect(records).toEqual([]);
  });
});

describe("resetHistory", () => {
  it("HIST_05: calls MATCH-DELETE on all MemoryHistory nodes", async () => {
    mockRunWrite.mockResolvedValueOnce([]);

    await resetHistory();

    expect(mockRunWrite).toHaveBeenCalledTimes(1);
    const [query] = mockRunWrite.mock.calls[0];
    expect(query).toContain("MemoryHistory");
    expect(query).toContain("DETACH DELETE");
  });
});
