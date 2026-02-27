/**
 * P1 — lib/memory/write.ts unit tests
 *
 * Covers: addMemory, updateMemory, supersedeMemory, deleteMemory,
 *         archiveMemory, pauseMemory, getMemory
 *
 * All DB + embedding calls are mocked — no running Memgraph needed.
 */
export {};

// ---- Mocks ----
const mockRunWrite = jest.fn();
const mockRunRead = jest.fn();
jest.mock("@/lib/db/memgraph", () => ({
  runWrite: (...args: unknown[]) => mockRunWrite(...args),
  runRead: (...args: unknown[]) => mockRunRead(...args),
}));

const mockEmbed = jest.fn();
jest.mock("@/lib/embeddings/openai", () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}));

const mockCategorize = jest.fn();
jest.mock("@/lib/memory/categorize", () => ({
  categorizeMemory: (...args: unknown[]) => mockCategorize(...args),
}));

jest.mock("@/lib/config/helpers", () => ({
  getContextWindowConfig: jest.fn().mockResolvedValue({ enabled: false, size: 0 }),
}));

jest.mock("@/lib/memory/context", () => ({
  getRecentMemories: jest.fn().mockResolvedValue([]),
  buildContextPrefix: jest.fn().mockReturnValue(""),
}));

import {
  addMemory,
  updateMemory,
  supersedeMemory,
  deleteMemory,
  archiveMemory,
  pauseMemory,
  getMemory,
} from "@/lib/memory/write";

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue(new Array(1024).fill(0));
  mockRunWrite.mockResolvedValue([]);
  mockRunRead.mockResolvedValue([]);
  mockCategorize.mockResolvedValue(undefined);
});

// ==========================================================================
// addMemory
// ==========================================================================
describe("addMemory", () => {
  test("WR_01: returns a UUID string", async () => {
    mockRunWrite.mockResolvedValue([{ id: "returned-id" }]);
    const id = await addMemory("hello world", { userId: "u1" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("WR_02: calls embed() with the text", async () => {
    await addMemory("test memory", { userId: "u1" });
    expect(mockEmbed).toHaveBeenCalledWith("test memory");
  });

  test("WR_03: MERGEs User node before creating Memory", async () => {
    await addMemory("test", { userId: "u1" });
    const firstCall = mockRunWrite.mock.calls[0][0] as string;
    expect(firstCall.toUpperCase()).toContain("MERGE");
    expect(firstCall).toContain(":User");
  });

  test("WR_04: CREATE Memory node with embedding + content", async () => {
    await addMemory("my memory", { userId: "u1" });
    // Second runWrite call creates the Memory node
    const createCall = mockRunWrite.mock.calls[1][0] as string;
    expect(createCall.toUpperCase()).toContain("CREATE");
    expect(createCall).toContain(":Memory");
    const params = mockRunWrite.mock.calls[1][1] as Record<string, unknown>;
    expect(params.content).toBe("my memory");
    expect(Array.isArray(params.embedding)).toBe(true);
  });

  test("WR_05: anchors to User node (namespace isolation)", async () => {
    await addMemory("test", { userId: "user-42" });
    const createCall = mockRunWrite.mock.calls[1][0] as string;
    expect(createCall).toContain("User {userId: $userId}");
  });

  test("WR_06: attaches App node when appName provided — inline in the same CREATE call", async () => {
    await addMemory("test", { userId: "u1", appName: "cursor" });
    // 2 calls: MERGE User (call[0]) + inline CREATE Memory+App (call[1])
    expect(mockRunWrite.mock.calls.length).toBe(2);
    const createCall = mockRunWrite.mock.calls[1][0] as string;
    expect(createCall).toContain(":App");
    expect(createCall).toContain("CREATED_BY");
  });

  test("WR_07: does NOT create App node when appName omitted", async () => {
    await addMemory("test", { userId: "u1" });
    // Only 2 calls: MERGE User + CREATE Memory
    expect(mockRunWrite.mock.calls.length).toBe(2);
  });

  test("WR_08: categorizeMemory fires async (fire-and-forget)", async () => {
    await addMemory("test", { userId: "u1" });
    expect(mockCategorize).toHaveBeenCalledWith(
      expect.any(String),
      "test"
    );
  });

  test("WR_09: categorize error does not reject addMemory", async () => {
    mockCategorize.mockRejectedValue(new Error("LLM down"));
    const id = await addMemory("test", { userId: "u1" });
    expect(typeof id).toBe("string");
  });

  test("WR_10: serializes metadata to JSON string", async () => {
    await addMemory("test", { userId: "u1", metadata: { key: "val" } });
    const params = mockRunWrite.mock.calls[1][1] as Record<string, unknown>;
    expect(params.metadata).toBe('{"key":"val"}');
  });

  test("WR_11: defaults metadata to empty JSON object", async () => {
    await addMemory("test", { userId: "u1" });
    const params = mockRunWrite.mock.calls[1][1] as Record<string, unknown>;
    expect(params.metadata).toBe("{}");
  });

  test("WR_12: passes tags array to the Memory CREATE params", async () => {
    await addMemory("test", { userId: "u1", tags: ["audit-session-17", "prod"] });
    const params = mockRunWrite.mock.calls[1][1] as Record<string, unknown>;
    expect(params.tags).toEqual(["audit-session-17", "prod"]);
  });

  test("WR_13: defaults tags to empty array when not provided", async () => {
    await addMemory("test", { userId: "u1" });
    const params = mockRunWrite.mock.calls[1][1] as Record<string, unknown>;
    expect(params.tags).toEqual([]);
  });
});

// ==========================================================================
// updateMemory
// ==========================================================================
describe("updateMemory", () => {
  test("WR_20: re-embeds and updates Memory in-place", async () => {
    mockRunWrite.mockResolvedValue([{ id: "mem-1" }]);
    const ok = await updateMemory("mem-1", "new text", { userId: "u1" });
    expect(ok).toBe(true);
    expect(mockEmbed).toHaveBeenCalledWith("new text");
    const cypher = mockRunWrite.mock.calls[0][0] as string;
    expect(cypher).toContain("SET m.content = $content");
  });

  test("WR_21: returns false when memory not found", async () => {
    mockRunWrite.mockResolvedValue([]);
    const ok = await updateMemory("no-exist", "text", { userId: "u1" });
    expect(ok).toBe(false);
  });

  test("WR_22: anchors to User for namespace isolation", async () => {
    mockRunWrite.mockResolvedValue([{ id: "x" }]);
    await updateMemory("mem-1", "text", { userId: "u1" });
    const cypher = mockRunWrite.mock.calls[0][0] as string;
    expect(cypher).toContain("User {userId: $userId}");
    expect(cypher).toContain("[:HAS_MEMORY]->");
  });
});

// ==========================================================================
// supersedeMemory (Spec 01)
// ==========================================================================
describe("supersedeMemory", () => {
  test("WR_30: invalidates old node, creates new node and SUPERSEDES edge — all atomic in one call", async () => {
    const newId = await supersedeMemory("old-id", "new content", "u1");
    expect(typeof newId).toBe("string");
    // Exactly 1 runWrite call: all steps combined atomically
    expect(mockRunWrite.mock.calls.length).toBe(1);

    const atomicCall = mockRunWrite.mock.calls[0][0] as string;
    // Must invalidate old
    expect(atomicCall).toContain("invalidAt");
    // Must create new Memory
    expect(atomicCall.toUpperCase()).toContain("CREATE");
    expect(atomicCall).toContain(":Memory");
    // Must create SUPERSEDES edge
    expect(atomicCall).toContain("SUPERSEDES");
    // Must be User-anchored (namespace isolation)
    expect(atomicCall).toContain("User {userId: $userId}");
  });

  test("WR_31: attaches new Memory to App when provided (second call)", async () => {
    await supersedeMemory("old-id", "new", "u1", "vscode");
    // 2 calls: atomic (steps 1-3) + App attachment
    expect(mockRunWrite.mock.calls.length).toBe(2);
    const appCall = mockRunWrite.mock.calls[1][0] as string;
    expect(appCall).toContain(":App");
    expect(appCall).toContain("CREATED_BY");
  });

  test("WR_32: fires categorize on new memory", async () => {
    await supersedeMemory("old-id", "new text", "u1");
    expect(mockCategorize).toHaveBeenCalledWith(
      expect.any(String),
      "new text"
    );
  });

  test("WR_33: categorize failure does not break supersede", async () => {
    mockCategorize.mockRejectedValue(new Error("boom"));
    const id = await supersedeMemory("old-id", "new", "u1");
    expect(typeof id).toBe("string");
  });
});

// ==========================================================================
// deleteMemory
// ==========================================================================
describe("deleteMemory", () => {
  test("WR_40: soft-deletes by setting state=deleted + invalidAt", async () => {
    mockRunWrite.mockResolvedValue([{ id: "mem-1" }]);
    const ok = await deleteMemory("mem-1", "u1");
    expect(ok).toBe(true);
    const cypher = mockRunWrite.mock.calls[0][0] as string;
    expect(cypher).toContain("state = 'deleted'");
    expect(cypher).toContain("invalidAt");
  });

  test("WR_41: returns false when not found", async () => {
    mockRunWrite.mockResolvedValue([]);
    const ok = await deleteMemory("nope", "u1");
    expect(ok).toBe(false);
  });
});

// ==========================================================================
// archiveMemory / pauseMemory
// ==========================================================================
describe("archiveMemory", () => {
  test("WR_50: sets state=archived on active memory", async () => {
    mockRunWrite.mockResolvedValue([{ id: "mem-1" }]);
    const ok = await archiveMemory("mem-1", "u1");
    expect(ok).toBe(true);
    const cypher = mockRunWrite.mock.calls[0][0] as string;
    expect(cypher).toContain("state = 'archived'");
    expect(cypher).toContain("state = 'active'");
  });

  test("WR_51: returns false when not found or not active", async () => {
    mockRunWrite.mockResolvedValue([]);
    expect(await archiveMemory("x", "u1")).toBe(false);
  });
});

describe("pauseMemory", () => {
  test("WR_52: sets state=paused", async () => {
    mockRunWrite.mockResolvedValue([{ id: "mem-1" }]);
    const ok = await pauseMemory("mem-1", "u1");
    expect(ok).toBe(true);
    const cypher = mockRunWrite.mock.calls[0][0] as string;
    expect(cypher).toContain("state = 'paused'");
  });
});

// ==========================================================================
// getMemory
// ==========================================================================
describe("getMemory", () => {
  test("WR_70: returns memory object when found", async () => {
    mockRunRead.mockResolvedValue([{
      id: "mem-1", content: "hello", state: "active",
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
      userId: "u1", appName: "test",
    }]);
    const m = await getMemory("mem-1", "u1");
    expect(m).not.toBeNull();
    expect(m!.id).toBe("mem-1");
    expect(m!.content).toBe("hello");
  });

  test("WR_71: returns null when not found", async () => {
    mockRunRead.mockResolvedValue([]);
    const m = await getMemory("nope", "u1");
    expect(m).toBeNull();
  });

  test("WR_72: anchors to User node", async () => {
    mockRunRead.mockResolvedValue([]);
    await getMemory("mem-1", "u1");
    const cypher = mockRunRead.mock.calls[0][0] as string;
    expect(cypher).toContain("User {userId: $userId}");
    expect(cypher).toContain("[:HAS_MEMORY]->");
  });
});
