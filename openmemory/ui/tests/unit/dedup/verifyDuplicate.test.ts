export {};
/**
 * Unit tests — verifyDuplicate (Stage 2 LLM verification) + cache
 *
 * VERIFY_01: Identical meaning → DUPLICATE
 * VERIFY_02: Update/contradiction → SUPERSEDES
 * VERIFY_03: Distinct facts → DIFFERENT
 * VERIFY_04: Cache hit — second call for same pair uses cache (LLM called only once)
 */

const mockCreate = jest.fn();

// Mock the LLM client factory so we never check Azure credentials
jest.mock("@/lib/ai/client", () => ({
  getLLMClient: () => ({
    chat: { completions: { create: mockCreate } },
  }),
  resetLLMClient: jest.fn(),
}));

import { verifyDuplicate } from "@/lib/dedup/verifyDuplicate";
import { pairHash, getCached, setCached } from "@/lib/dedup/cache";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("verifyDuplicate", () => {
  it("VERIFY_01: same meaning returns DUPLICATE", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "DUPLICATE" } }],
    });

    const result = await verifyDuplicate("I prefer dark mode", "dark theme is my preference");
    expect(result).toBe("DUPLICATE");
  });

  it("VERIFY_02: update/contradiction returns SUPERSEDES", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "SUPERSEDES" } }],
    });

    const result = await verifyDuplicate("I moved to London", "I live in NYC");
    expect(result).toBe("SUPERSEDES");
  });

  it("VERIFY_03: distinct facts returns DIFFERENT", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "DIFFERENT" } }],
    });

    const result = await verifyDuplicate("I like dogs", "I like cats");
    expect(result).toBe("DIFFERENT");
  });

  it("VERIFY_04: unknown LLM output defaults to DIFFERENT", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "UNRELATED_RESPONSE" } }],
    });

    const result = await verifyDuplicate("some text", "other text");
    expect(result).toBe("DIFFERENT");
  });
});

describe("cache", () => {
  it("CACHE_01: stores and retrieves results by pair hash", () => {
    const h = pairHash("memory A", "memory B");
    expect(getCached(h)).toBeNull();

    setCached(h, "DUPLICATE");
    expect(getCached(h)).toBe("DUPLICATE");
  });

  it("CACHE_02: pair hash is order-independent (canonical)", () => {
    const h1 = pairHash("alpha", "beta");
    const h2 = pairHash("beta", "alpha");
    expect(h1).toBe(h2);
  });
});
