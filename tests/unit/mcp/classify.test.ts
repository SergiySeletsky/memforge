export {};
/**
 * Unit tests â€” lib/mcp/classify.ts
 *
 * Tests the intent classifier for the 2-tool MCP architecture.
 *
 * CLASSIFY_FAST_01:  plain fact â€” fast-path returns STORE without calling LLM
 * CLASSIFY_FAST_02:  declarative preference â€” fast-path STORE
 * CLASSIFY_FAST_03:  past-tense observation â€” fast-path STORE
 * CLASSIFY_FAST_04:  forward reference to forgetting â€” fast-path triggered
 *
 * CLASSIFY_LLM_01:   LLM returns INVALIDATE â†’ classified as INVALIDATE with target
 * CLASSIFY_LLM_02:   LLM returns DELETE_ENTITY â†’ classified as DELETE_ENTITY with entityName
 * CLASSIFY_LLM_03:   LLM returns STORE â†’ classified as STORE
 * CLASSIFY_LLM_04:   LLM returns INVALIDATE with missing target â†’ falls back to STORE
 * CLASSIFY_LLM_05:   LLM returns DELETE_ENTITY with missing entityName â†’ falls back to STORE
 * CLASSIFY_LLM_06:   LLM returns unexpected intent string â†’ falls back to STORE
 * CLASSIFY_LLM_07:   LLM returns malformed JSON â†’ fails open to STORE
 * CLASSIFY_LLM_08:   LLM call throws â†’ fails open to STORE
 * CLASSIFY_LLM_09:   LLM returns empty string â†’ fails open to STORE
 *
 * CLASSIFY_REGEX_01: "forget â€¦ about" pattern â†’ triggers LLM path
 * CLASSIFY_REGEX_02: "stop tracking" â†’ triggers LLM path
 * CLASSIFY_REGEX_03: "don't remember" â†’ triggers LLM path
 * CLASSIFY_REGEX_04: "mark as outdated" â†’ triggers LLM path
 * CLASSIFY_REGEX_05: "invalidate" alone â†’ triggers LLM path
 * CLASSIFY_REGEX_06: "remove entity" â†’ triggers LLM path
 * CLASSIFY_REGEX_07: case-insensitive matching
 *
 * CLASSIFY_MISC_01:  temperature=0 and max_tokens=100 passed to LLM (deterministic)
 * CLASSIFY_MISC_02:  env LLM_AZURE_DEPLOYMENT used when set
 * CLASSIFY_MISC_03:  MEMFORGE_CATEGORIZATION_MODEL used as second fallback
 */

const mockCreate = jest.fn();

jest.mock("@/lib/ai/client", () => ({
  getLLMClient: () => ({
    chat: { completions: { create: mockCreate } },
  }),
}));

import { classifyIntent, mightBeCommand } from "@/lib/mcp/classify";

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LLM_AZURE_DEPLOYMENT;
  delete process.env.MEMFORGE_CATEGORIZATION_MODEL;
});

// ---------------------------------------------------------------------------
// mightBeCommand â€” regex pre-filter
// ---------------------------------------------------------------------------
describe("mightBeCommand â€” regex pre-filter", () => {
  it("CLASSIFY_REGEX_01: 'forget everything about Alice' triggers command path", () => {
    expect(mightBeCommand("Please forget everything about Alice")).toBe(true);
  });

  it("CLASSIFY_REGEX_02: 'stop tracking' pattern triggers command path", () => {
    expect(mightBeCommand("stop tracking Bob from now on")).toBe(true);
  });

  it("CLASSIFY_REGEX_03: \"don't remember\" triggers command path", () => {
    expect(mightBeCommand("don't remember my old phone number")).toBe(true);
  });

  it("CLASSIFY_REGEX_04: 'mark as outdated' triggers command path", () => {
    expect(mightBeCommand("mark as outdated my salary info")).toBe(true);
  });

  it("CLASSIFY_REGEX_05: 'invalidate' alone triggers command path", () => {
    expect(mightBeCommand("invalidate the policy entry")).toBe(true);
  });

  it("CLASSIFY_REGEX_06: 'remove entity' triggers command path", () => {
    expect(mightBeCommand("remove entity Carol from the graph")).toBe(true);
  });

  it("CLASSIFY_REGEX_07: case-insensitive â€” FORGET triggers command path", () => {
    expect(mightBeCommand("FORGET ABOUT my old address")).toBe(true);
  });

  it("CLASSIFY_REGEX_08: plain factual statement does NOT trigger command path", () => {
    expect(mightBeCommand("I work at Acme Corp as a software engineer")).toBe(false);
  });

  it("CLASSIFY_REGEX_09: preference statement does NOT trigger command path", () => {
    expect(mightBeCommand("I prefer dark mode in my IDE")).toBe(false);
  });

  it("CLASSIFY_REGEX_10: past observation without command verbs is not a command", () => {
    expect(mightBeCommand("My previous employer was Globex")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyIntent â€” fast path (no LLM call)
// ---------------------------------------------------------------------------
describe("classifyIntent â€” fast path (STORE without LLM)", () => {
  it("CLASSIFY_FAST_01: plain fact returns STORE without calling LLM", async () => {
    const result = await classifyIntent("Alice is a senior engineer at Acme");
    expect(result).toEqual({ type: "STORE" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("CLASSIFY_FAST_02: preference statement returns STORE without calling LLM", async () => {
    const result = await classifyIntent("I prefer TypeScript over JavaScript");
    expect(result).toEqual({ type: "STORE" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("CLASSIFY_FAST_03: past-tense observation returns STORE without calling LLM", async () => {
    const result = await classifyIntent("My previous phone number was 555-1234");
    expect(result).toEqual({ type: "STORE" });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// classifyIntent â€” LLM path (command-like text)
// ---------------------------------------------------------------------------
describe("classifyIntent â€” LLM path", () => {
  it("CLASSIFY_LLM_01: LLM returns INVALIDATE with target â†’ INVALIDATE intent", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"INVALIDATE","target":"Alice phone number"}' } }],
    });

    const result = await classifyIntent("forget about Alice's phone number");
    expect(result).toEqual({ type: "INVALIDATE", target: "Alice phone number" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("CLASSIFY_LLM_02: LLM returns DELETE_ENTITY with entityName â†’ DELETE_ENTITY intent", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"DELETE_ENTITY","entityName":"Bob"}' } }],
    });

    const result = await classifyIntent("stop tracking Bob");
    expect(result).toEqual({ type: "DELETE_ENTITY", entityName: "Bob" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("CLASSIFY_LLM_03: LLM returns STORE â†’ STORE intent", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"STORE"}' } }],
    });

    const result = await classifyIntent("invalidate my old project ideas");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_LLM_04: LLM returns INVALIDATE without target â†’ falls back to STORE", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"INVALIDATE"}' } }],
    });

    const result = await classifyIntent("forget about that meeting");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_LLM_05: LLM returns DELETE_ENTITY without entityName â†’ falls back to STORE", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"DELETE_ENTITY"}' } }],
    });

    const result = await classifyIntent("stop tracking that person");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_LLM_06: LLM returns unknown intent string â†’ falls back to STORE", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"UPDATE","content":"something"}' } }],
    });

    const result = await classifyIntent("invalidate the record");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_LLM_07: LLM returns malformed JSON â†’ fails open to STORE", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not json at all" } }],
    });

    const result = await classifyIntent("forget my old email");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_LLM_08: LLM call throws â†’ fails open to STORE", async () => {
    mockCreate.mockRejectedValueOnce(new Error("network timeout"));

    const result = await classifyIntent("stop remembering my address");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_LLM_09: LLM returns empty string â†’ fails open to STORE", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "" } }],
    });

    const result = await classifyIntent("erase that memory about the meeting");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_LLM_10: LLM returns null content â†’ fails open to STORE", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
    });

    const result = await classifyIntent("remove entity Alice");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_MISC_01: LLM called with temperature=0 and max_tokens=100", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"STORE"}' } }],
    });

    await classifyIntent("forget about something");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0, max_tokens: 100 })
    );
  });

  it("CLASSIFY_MISC_02: uses LLM_AZURE_DEPLOYMENT model when env var is set", async () => {
    process.env.LLM_AZURE_DEPLOYMENT = "gpt-4-azure";
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"STORE"}' } }],
    });

    await classifyIntent("forget about that");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4-azure" })
    );
  });

  it("CLASSIFY_MISC_03: uses MEMFORGE_CATEGORIZATION_MODEL as second fallback", async () => {
    process.env.MEMFORGE_CATEGORIZATION_MODEL = "gpt-3.5-turbo";
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"STORE"}' } }],
    });

    await classifyIntent("forget about that");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-3.5-turbo" })
    );
  });

  it("CLASSIFY_MISC_04: defaults to gpt-4o-mini when no env vars set", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"STORE"}' } }],
    });

    await classifyIntent("remove entity Alice");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" })
    );
  });

  it("CLASSIFY_MISC_05: INVALIDATE target is a string (non-empty)", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"INVALIDATE","target":42}' } }],
    });

    // target must be a string â€” numeric target is rejected, falls back to STORE
    const result = await classifyIntent("forget that number");
    expect(result).toEqual({ type: "STORE" });
  });

  it("CLASSIFY_MISC_06: DELETE_ENTITY entityName must be a string", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"intent":"DELETE_ENTITY","entityName":true}' } }],
    });

    const result = await classifyIntent("stop tracking someone");
    expect(result).toEqual({ type: "STORE" });
  });
});
