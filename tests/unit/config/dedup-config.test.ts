export {};
/**
 * Unit tests â€” getDedupConfig() default threshold
 *
 * DEDUP_CFG_01: Default threshold is 0.75 (lowered from 0.85 for paraphrase catch)
 * DEDUP_CFG_02: Config override from Memgraph is respected
 * DEDUP_CFG_03: Config read failure returns safe defaults (enabled, 0.75)
 */
import { getDedupConfig } from "@/lib/config/helpers";

jest.mock("@/lib/db/memgraph", () => ({
  runRead: jest.fn(),
  runWrite: jest.fn(),
}));
import { runRead } from "@/lib/db/memgraph";

const mockRunRead = runRead as jest.MockedFunction<typeof runRead>;

beforeEach(() => jest.clearAllMocks());

describe("getDedupConfig", () => {
  it("DEDUP_CFG_01: default threshold is 0.75 (Eval v4 Finding 4)", async () => {
    // No dedup config in Memgraph â†’ falls back to defaults
    mockRunRead.mockResolvedValueOnce([]);

    const config = await getDedupConfig();

    expect(config.enabled).toBe(true);
    expect(config.threshold).toBe(0.75);
  });

  it("DEDUP_CFG_02: config override from Memgraph is respected", async () => {
    mockRunRead.mockResolvedValueOnce([
      { key: "memforge", value: JSON.stringify({ dedup: { enabled: true, threshold: 0.90 } }) },
    ]);

    const config = await getDedupConfig();

    expect(config.threshold).toBe(0.90);
  });

  it("DEDUP_CFG_03: config read failure returns safe defaults", async () => {
    mockRunRead.mockRejectedValueOnce(new Error("Connection refused"));

    const config = await getDedupConfig();

    expect(config.enabled).toBe(true);
    expect(config.threshold).toBe(0.75);
  });
});
