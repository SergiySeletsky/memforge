export {};
/**
 * Unit tests — summarize-description.ts (lib/entities/summarize-description.ts)
 *
 * SUM_01: Empty incoming description → returns immediately (no DB call)
 * SUM_02: No existing description → writes incoming directly (no LLM)
 * SUM_03: Identical descriptions → no-op (no LLM, no write)
 * SUM_04: Different descriptions → calls LLM to consolidate, writes result
 * SUM_05: LLM returns empty → no write
 */
import { summarizeEntityDescription } from "@/lib/entities/summarize-description";

jest.mock("@/lib/db/memgraph", () => ({ runRead: jest.fn(), runWrite: jest.fn() }));
jest.mock("@/lib/ai/client");

import { runRead, runWrite } from "@/lib/db/memgraph";
import { getLLMClient } from "@/lib/ai/client";

const mockRunRead = runRead as jest.MockedFunction<typeof runRead>;
const mockRunWrite = runWrite as jest.MockedFunction<typeof runWrite>;
const mockGetLLMClient = getLLMClient as jest.MockedFunction<typeof getLLMClient>;

const mockCreate = jest.fn();
mockGetLLMClient.mockReturnValue({
  chat: { completions: { create: mockCreate } },
} as unknown as ReturnType<typeof getLLMClient>);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLLMClient.mockReturnValue({
    chat: { completions: { create: mockCreate } },
  } as unknown as ReturnType<typeof getLLMClient>);
});

describe("summarizeEntityDescription", () => {
  it("SUM_01: empty incoming description → no DB calls", async () => {
    await summarizeEntityDescription("ent-1", "Alice", "  ");

    expect(mockRunRead).not.toHaveBeenCalled();
    expect(mockRunWrite).not.toHaveBeenCalled();
  });

  it("SUM_02: no existing description → writes incoming directly, no LLM", async () => {
    mockRunRead.mockResolvedValueOnce([{ description: "" }]);
    mockRunWrite.mockResolvedValue([]);

    await summarizeEntityDescription("ent-1", "Alice", "Senior engineer");

    expect(mockRunWrite).toHaveBeenCalledTimes(1);
    const params = mockRunWrite.mock.calls[0][1] as Record<string, unknown>;
    expect(params.desc).toBe("Senior engineer");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("SUM_03: identical descriptions → no-op", async () => {
    mockRunRead.mockResolvedValueOnce([{ description: "Senior engineer" }]);

    await summarizeEntityDescription("ent-1", "Alice", "senior engineer");

    expect(mockRunWrite).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("SUM_04: different descriptions → LLM consolidation, writes result", async () => {
    mockRunRead.mockResolvedValueOnce([{ description: "Backend developer" }]);
    mockRunWrite.mockResolvedValue([]);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Full-stack developer with backend expertise" } }],
    });

    await summarizeEntityDescription("ent-1", "Alice", "Frontend lead since 2024");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Check prompt contains both descriptions
    const msgs = mockCreate.mock.calls[0][0].messages as Array<{ content: string }>;
    expect(msgs[0].content).toContain("Backend developer");
    expect(msgs[0].content).toContain("Frontend lead since 2024");

    expect(mockRunWrite).toHaveBeenCalledTimes(1);
    const params = mockRunWrite.mock.calls[0][1] as Record<string, unknown>;
    expect(params.desc).toBe("Full-stack developer with backend expertise");
  });

  it("SUM_05: LLM returns empty → no write", async () => {
    mockRunRead.mockResolvedValueOnce([{ description: "Old desc" }]);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "" } }],
    });

    await summarizeEntityDescription("ent-1", "Alice", "New desc");

    // LLM called but result empty → no runWrite
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRunWrite).not.toHaveBeenCalled();
  });
});
