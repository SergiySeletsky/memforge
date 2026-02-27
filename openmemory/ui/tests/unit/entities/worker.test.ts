export {};
/**
 * Unit tests — processEntityExtraction worker (lib/entities/worker.ts)
 *
 * WORKER_01: Processes memory → extractionStatus becomes 'done'
 * WORKER_02: Already-done memory → skips (idempotent, extract not called)
 * WORKER_03: LLM failure → status becomes 'failed', error stored
 * WORKER_04: Memory with no entities → status 'done', no MENTIONS edges created
 * WORKER_05: Memory not found → returns silently without error
 */
import { processEntityExtraction } from "@/lib/entities/worker";

jest.mock("@/lib/db/memgraph", () => ({ runRead: jest.fn(), runWrite: jest.fn() }));
jest.mock("@/lib/entities/extract");
jest.mock("@/lib/entities/resolve");
jest.mock("@/lib/entities/link");

import { runRead, runWrite } from "@/lib/db/memgraph";
import { extractEntitiesFromMemory } from "@/lib/entities/extract";
import { resolveEntity } from "@/lib/entities/resolve";
import { linkMemoryToEntity } from "@/lib/entities/link";

const mockRunRead = runRead as jest.MockedFunction<typeof runRead>;
const mockRunWrite = runWrite as jest.MockedFunction<typeof runWrite>;
const mockExtract = extractEntitiesFromMemory as jest.MockedFunction<typeof extractEntitiesFromMemory>;
const mockResolve = resolveEntity as jest.MockedFunction<typeof resolveEntity>;
const mockLink = linkMemoryToEntity as jest.MockedFunction<typeof linkMemoryToEntity>;

beforeEach(() => jest.clearAllMocks());

describe("processEntityExtraction", () => {
  it("WORKER_01: processes memory, calls extract+resolve+link, sets status done", async () => {
    // First runRead: status check
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Alice works at Acme Corp" }])
      // Second runRead: get userId
      .mockResolvedValueOnce([{ userId: "user-1" }])
      // Third runRead: Tier 1 batch normalizedName lookup (ENTITY-01) — no existing entities
      .mockResolvedValueOnce([]);
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue([
      { name: "Alice", type: "PERSON", description: "A person" },
      { name: "Acme Corp", type: "ORGANIZATION", description: "A company" },
    ]);
    mockResolve.mockResolvedValueOnce("entity-alice").mockResolvedValueOnce("entity-acme");
    mockLink.mockResolvedValue(undefined);

    await processEntityExtraction("mem-123");

    expect(mockExtract).toHaveBeenCalledWith("Alice works at Acme Corp");
    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(mockLink).toHaveBeenCalledTimes(2);

    // Final SET extractionStatus = 'done'
    const writeCalls = mockRunWrite.mock.calls.map(c => c[0] as string);
    expect(writeCalls.some(q => q.includes("'done'"))).toBe(true);
  });

  it("WORKER_02: already-done memory → extract not called (idempotent)", async () => {
    mockRunRead.mockResolvedValueOnce([{ status: "done", content: "anything" }]);

    await processEntityExtraction("mem-already-done");

    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockRunWrite).not.toHaveBeenCalled();
  });

  it("WORKER_03: LLM failure → extractionStatus set to failed, error stored", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Alice at work" }])
      .mockResolvedValueOnce([{ userId: "user-1" }]);
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockRejectedValue(new Error("OpenAI timeout"));

    await processEntityExtraction("mem-fail");

    const writeCalls = mockRunWrite.mock.calls.map(c => c[0] as string);
    expect(writeCalls.some(q => q.includes("'failed'"))).toBe(true);
  });

  it("WORKER_04: memory with no entities → status done, no MENTIONS edges", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "I prefer dark mode" }])
      .mockResolvedValueOnce([{ userId: "user-1" }]);
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue([]);

    await processEntityExtraction("mem-no-entities");

    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    const writeCalls = mockRunWrite.mock.calls.map(c => c[0] as string);
    expect(writeCalls.some(q => q.includes("'done'"))).toBe(true);
  });

  it("WORKER_05: memory not found → returns silently", async () => {
    mockRunRead.mockResolvedValueOnce([]); // no rows

    await expect(processEntityExtraction("mem-missing")).resolves.toBeUndefined();
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("WORKER_06 (ENTITY-01): Tier 1 batch hit → resolveEntity NOT called for matched entity", async () => {
    // Tier 1 returns a cached entity for 'alice'
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Alice joined the team" }])
      .mockResolvedValueOnce([{ userId: "user-1" }])
      // Tier 1 UNWIND batch: Alice already exists
      .mockResolvedValueOnce([{ normName: "alice", entityId: "entity-alice-cached" }]);
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue([
      { name: "Alice", type: "PERSON", description: "Team member" },
    ]);
    mockLink.mockResolvedValue(undefined);

    await processEntityExtraction("mem-200");

    // resolveEntity must NOT be called — Tier 1 cache handled it
    expect(mockResolve).not.toHaveBeenCalled();
    // link must be called with the cached entity id
    expect(mockLink).toHaveBeenCalledWith("mem-200", "entity-alice-cached");
  });

  it("WORKER_07 (ENTITY-01): Tier 1 batch miss → resolveEntity called as fallback", async () => {
    // Tier 1 returns nothing (entity not yet in DB)
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Bob at NewCo" }])
      .mockResolvedValueOnce([{ userId: "user-1" }])
      // Tier 1 UNWIND batch: no match for 'bob'
      .mockResolvedValueOnce([]);
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue([
      { name: "Bob", type: "PERSON", description: "New hire" },
    ]);
    mockResolve.mockResolvedValueOnce("entity-bob-new");
    mockLink.mockResolvedValue(undefined);

    await processEntityExtraction("mem-201");

    // resolveEntity MUST be called for the miss
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockLink).toHaveBeenCalledWith("mem-201", "entity-bob-new");
  });
});
