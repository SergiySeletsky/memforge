export {};
/**
 * Unit tests — processEntityExtraction worker (lib/entities/worker.ts)
 *
 * WORKER_01: Processes memory → extractionStatus becomes 'done'
 * WORKER_02: Already-done memory → skips (idempotent, extract not called)
 * WORKER_03: LLM failure → status becomes 'failed', error stored
 * WORKER_04: Memory with no entities → status 'done', no MENTIONS edges created
 * WORKER_05: Memory not found → returns silently without error
 * WORKER_06: Tier 1 batch hit → resolveEntity NOT called
 * WORKER_07: Tier 1 batch miss → resolveEntity called as fallback
 * WORKER_08: Relationships extracted → linkEntities called
 * WORKER_09: Description summarization fired for Tier 1 hits
 * WORKER_10: Gleaning produces extra entities → all resolved
 */
import { processEntityExtraction } from "@/lib/entities/worker";

jest.mock("@/lib/db/memgraph", () => ({ runRead: jest.fn(), runWrite: jest.fn() }));
jest.mock("@/lib/entities/extract");
jest.mock("@/lib/entities/resolve");
jest.mock("@/lib/entities/link");
jest.mock("@/lib/entities/relate");
jest.mock("@/lib/entities/summarize-description");

import { runRead, runWrite } from "@/lib/db/memgraph";
import { extractEntitiesAndRelationships } from "@/lib/entities/extract";
import { resolveEntity } from "@/lib/entities/resolve";
import { linkMemoryToEntity } from "@/lib/entities/link";
import { linkEntities } from "@/lib/entities/relate";
import { summarizeEntityDescription } from "@/lib/entities/summarize-description";

const mockRunRead = runRead as jest.MockedFunction<typeof runRead>;
const mockRunWrite = runWrite as jest.MockedFunction<typeof runWrite>;
const mockExtract = extractEntitiesAndRelationships as jest.MockedFunction<typeof extractEntitiesAndRelationships>;
const mockResolve = resolveEntity as jest.MockedFunction<typeof resolveEntity>;
const mockLink = linkMemoryToEntity as jest.MockedFunction<typeof linkMemoryToEntity>;
const mockLinkEntities = linkEntities as jest.MockedFunction<typeof linkEntities>;
const mockSummarizeDesc = summarizeEntityDescription as jest.MockedFunction<typeof summarizeEntityDescription>;

beforeEach(() => jest.clearAllMocks());

describe("processEntityExtraction", () => {
  it("WORKER_01: processes memory, calls extract+resolve+link, sets status done", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Alice works at Acme Corp" }])
      .mockResolvedValueOnce([{ userId: "user-1" }])
      .mockResolvedValueOnce([]); // Tier 1 batch — no existing entities
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue({
      entities: [
        { name: "Alice", type: "PERSON", description: "A person" },
        { name: "Acme Corp", type: "ORGANIZATION", description: "A company" },
      ],
      relationships: [
        { source: "Alice", target: "Acme Corp", type: "WORKS_AT", description: "Alice works at Acme Corp" },
      ],
    });
    mockResolve.mockResolvedValueOnce("entity-alice").mockResolvedValueOnce("entity-acme");
    mockLink.mockResolvedValue(undefined);
    mockLinkEntities.mockResolvedValue(undefined);
    mockSummarizeDesc.mockResolvedValue(undefined);

    await processEntityExtraction("mem-123");

    expect(mockExtract).toHaveBeenCalledWith("Alice works at Acme Corp");
    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(mockLink).toHaveBeenCalledTimes(2);

    // Relationship extraction: linkEntities called with resolved IDs
    expect(mockLinkEntities).toHaveBeenCalledWith(
      "entity-alice", "entity-acme", "WORKS_AT", "Alice works at Acme Corp"
    );

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
    mockExtract.mockResolvedValue({ entities: [], relationships: [] });

    await processEntityExtraction("mem-no-entities");

    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockLinkEntities).not.toHaveBeenCalled();
    const writeCalls = mockRunWrite.mock.calls.map(c => c[0] as string);
    expect(writeCalls.some(q => q.includes("'done'"))).toBe(true);
  });

  it("WORKER_05: memory not found → returns silently", async () => {
    mockRunRead.mockResolvedValueOnce([]); // no rows

    await expect(processEntityExtraction("mem-missing")).resolves.toBeUndefined();
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("WORKER_06 (ENTITY-01): Tier 1 batch hit → resolveEntity NOT called for matched entity", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Alice joined the team" }])
      .mockResolvedValueOnce([{ userId: "user-1" }])
      // Tier 1 UNWIND batch: Alice already exists
      .mockResolvedValueOnce([{ normName: "alice", entityId: "entity-alice-cached" }]);
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue({
      entities: [{ name: "Alice", type: "PERSON", description: "Team member" }],
      relationships: [],
    });
    mockLink.mockResolvedValue(undefined);
    mockSummarizeDesc.mockResolvedValue(undefined);

    await processEntityExtraction("mem-200");

    // resolveEntity must NOT be called — Tier 1 cache handled it
    expect(mockResolve).not.toHaveBeenCalled();
    // link must be called with the cached entity id
    expect(mockLink).toHaveBeenCalledWith("mem-200", "entity-alice-cached");
  });

  it("WORKER_07 (ENTITY-01): Tier 1 batch miss → resolveEntity called as fallback", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Bob at NewCo" }])
      .mockResolvedValueOnce([{ userId: "user-1" }])
      // Tier 1 UNWIND batch: no match for 'bob'
      .mockResolvedValueOnce([]);
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue({
      entities: [{ name: "Bob", type: "PERSON", description: "New hire" }],
      relationships: [],
    });
    mockResolve.mockResolvedValueOnce("entity-bob-new");
    mockLink.mockResolvedValue(undefined);
    mockSummarizeDesc.mockResolvedValue(undefined);

    await processEntityExtraction("mem-201");

    // resolveEntity MUST be called for the miss
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockLink).toHaveBeenCalledWith("mem-201", "entity-bob-new");
  });

  it("WORKER_08: relationships extracted → linkEntities called for valid pairs", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Postgres stores user data for AuthService" }])
      .mockResolvedValueOnce([{ userId: "user-1" }])
      .mockResolvedValueOnce([]); // Tier 1 — all new
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue({
      entities: [
        { name: "Postgres", type: "DATABASE", description: "Relational DB" },
        { name: "AuthService", type: "SERVICE", description: "Auth service" },
      ],
      relationships: [
        { source: "Postgres", target: "AuthService", type: "STORES_DATA_FOR", description: "Postgres holds user data for AuthService" },
        // This relationship references an entity not extracted — should be skipped
        { source: "Postgres", target: "Unknown", type: "USES", description: "Dangling ref" },
      ],
    });
    mockResolve.mockResolvedValueOnce("ent-pg").mockResolvedValueOnce("ent-auth");
    mockLink.mockResolvedValue(undefined);
    mockLinkEntities.mockResolvedValue(undefined);
    mockSummarizeDesc.mockResolvedValue(undefined);

    await processEntityExtraction("mem-rel-01");

    // Only valid pair → 1 linkEntities call
    expect(mockLinkEntities).toHaveBeenCalledTimes(1);
    expect(mockLinkEntities).toHaveBeenCalledWith(
      "ent-pg", "ent-auth", "STORES_DATA_FOR", "Postgres holds user data for AuthService"
    );
  });

  it("WORKER_09: description summarization fired for Tier 1 hits with descriptions", async () => {
    mockRunRead
      .mockResolvedValueOnce([{ status: null, content: "Alice leads the frontend team now" }])
      .mockResolvedValueOnce([{ userId: "user-1" }])
      // Tier 1: Alice exists
      .mockResolvedValueOnce([{ normName: "alice", entityId: "ent-alice" }]);
    mockRunWrite.mockResolvedValue([]);
    mockExtract.mockResolvedValue({
      entities: [{ name: "Alice", type: "PERSON", description: "Frontend team lead" }],
      relationships: [],
    });
    mockLink.mockResolvedValue(undefined);
    mockSummarizeDesc.mockResolvedValue(undefined);

    await processEntityExtraction("mem-sum-01");

    // summarizeEntityDescription should be called for Alice (Tier 1 hit with description)
    expect(mockSummarizeDesc).toHaveBeenCalledWith(
      "ent-alice", "Alice", "Frontend team lead"
    );
  });
});
