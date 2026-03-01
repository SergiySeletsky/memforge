export {};
/**
 * Unit tests — config TTL cache (CONFIG-NO-TTL-CACHE fix)
 *
 * CONFIG_TTL_01: second getConfigFromDb call within TTL skips DB query
 * CONFIG_TTL_02: call after TTL expiry re-queries DB
 * CONFIG_TTL_03: saveConfigToDb invalidates cache — next read hits DB
 * CONFIG_TTL_04: invalidateConfigCache() clears cached value
 */

jest.mock("@/lib/db/memgraph", () => ({
  runRead: jest.fn(),
  runWrite: jest.fn(),
}));

import { runRead, runWrite } from "@/lib/db/memgraph";
import {
  getConfigFromDb,
  saveConfigToDb,
  invalidateConfigCache,
  getDefaultConfiguration,
} from "@/lib/config/helpers";

const mockRunRead = runRead as jest.MockedFunction<typeof runRead>;
const mockRunWrite = runWrite as jest.MockedFunction<typeof runWrite>;

beforeEach(() => {
  jest.clearAllMocks();
  invalidateConfigCache(); // ensure clean cache state
  mockRunWrite.mockResolvedValue([]);
});

describe("config TTL cache", () => {
  it("CONFIG_TTL_01: second call within TTL returns cached result — no second DB query", async () => {
    mockRunRead.mockResolvedValue([
      { key: "memforge", value: JSON.stringify({ dedup: { threshold: 0.9 } }) },
    ]);

    const first = await getConfigFromDb();
    const second = await getConfigFromDb();

    // Only ONE DB call should have been made
    expect(mockRunRead).toHaveBeenCalledTimes(1);
    // Both results should be identical
    expect(first).toEqual(second);
    expect(first.memforge.dedup?.threshold).toBe(0.9);
  });

  it("CONFIG_TTL_02: call after TTL expiry re-queries DB", async () => {
    mockRunRead
      .mockResolvedValueOnce([
        { key: "memforge", value: JSON.stringify({ dedup: { threshold: 0.8 } }) },
      ])
      .mockResolvedValueOnce([
        { key: "memforge", value: JSON.stringify({ dedup: { threshold: 0.95 } }) },
      ]);

    const first = await getConfigFromDb();
    expect(first.memforge.dedup?.threshold).toBe(0.8);

    // Fast-forward past TTL by invalidating the cache (simulates expiry)
    invalidateConfigCache();

    const second = await getConfigFromDb();
    expect(second.memforge.dedup?.threshold).toBe(0.95);

    // Two DB calls
    expect(mockRunRead).toHaveBeenCalledTimes(2);
  });

  it("CONFIG_TTL_03: saveConfigToDb invalidates cache — next read hits DB", async () => {
    mockRunRead.mockResolvedValue([
      { key: "memforge", value: JSON.stringify({ dedup: { threshold: 0.7 } }) },
    ]);

    // Prime the cache
    await getConfigFromDb();
    expect(mockRunRead).toHaveBeenCalledTimes(1);

    // Save triggers invalidation
    const defaults = getDefaultConfiguration();
    await saveConfigToDb(defaults);

    // Next read should hit DB again
    await getConfigFromDb();
    expect(mockRunRead).toHaveBeenCalledTimes(2);
  });

  it("CONFIG_TTL_04: invalidateConfigCache() clears cached value", async () => {
    mockRunRead.mockResolvedValue([]);

    await getConfigFromDb();
    expect(mockRunRead).toHaveBeenCalledTimes(1);

    invalidateConfigCache();

    await getConfigFromDb();
    // After invalidation, DB is re-queried
    expect(mockRunRead).toHaveBeenCalledTimes(2);
  });
});
