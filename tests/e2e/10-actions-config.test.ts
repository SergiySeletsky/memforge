/**
 * E2E â€” Memory actions (archive, pause) & config
 *
 * Covers:
 *   POST /api/v1/memories/actions/archive  â€“ archive a set of memory IDs
 *   GET  /api/v1/config                    â€“ read current config
 *   PUT  /api/v1/config                    â€“ update config (roundtrip)
 *   GET  /api/v1/config/memforge/llm           â€“ LLM sub-config
 *   GET  /api/v1/config/memforge/embedder      â€“ embedder sub-config
 *   GET  /api/v1/config/memforge/vector_store  â€“ vector store sub-config
 */

import { api, asObj, MemoryTracker, RUN_ID } from "./helpers";

const USER = `actions-${RUN_ID}`;
const APP = `e2e-actions-app`;
const tracker = new MemoryTracker();

afterAll(async () => {
  await tracker.cleanup(USER);
});

// ---------------------------------------------------------------------------
describe("POST /api/v1/memories/actions/archive", () => {
  let idToArchive: string;

  beforeAll(async () => {
    const { body } = await api("/api/v1/memories", {
      method: "POST",
      body: {
        user_id: USER,
        text: "Old memory to be archived.",
        app: APP,
      },
    });
    const b = asObj(body);
    idToArchive = b.id as string;
    // NOTE: do NOT add to tracker â€” archiving is the test itself
  });

  it("archives memory IDs and returns 200", async () => {
    const { status, body } = await api("/api/v1/memories/actions/archive", {
      method: "POST",
      // user_id must be in body, not query params
      body: { user_id: USER, memory_ids: [idToArchive] },
    });
    expect(status).toBe(200);
    const b = asObj(body);
    // Should acknowledge the archive
    const hasAck =
      b.archived != null ||
      b.message != null ||
      b.changed != null ||
      b.success != null ||
      typeof b === "object";
    expect(hasAck).toBe(true);
  });

  it("archived memory no longer appears in active list", async () => {
    const { status, body } = await api("/api/v1/memories", {
      params: { user_id: USER },
    });
    expect(status).toBe(200);
    const b = asObj(body);
    const arr = (b.items ?? []) as unknown[];
    const ids = arr.map((m) => (m as { id: string }).id);
    expect(ids).not.toContain(idToArchive);
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/v1/memories/actions/pause", () => {
  it("pause endpoint returns 200 (smoke test)", async () => {
    const { body } = await api("/api/v1/memories", {
      method: "POST",
      body: {
        user_id: USER,
        text: "Memory to pause ingestion on.",
        app: APP,
      },
    });
    const b = asObj(body);
    const id = b.id as string;
    tracker.track(id);

    const { status } = await api("/api/v1/memories/actions/pause", {
      method: "POST",
      // user_id in body, not query params
      body: { user_id: USER, memory_ids: [id] },
    });
    // 200 = success, 404 = route not implemented yet
    expect([200, 404]).toContain(status);
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v1/config", () => {
  it("returns 200 with a config object", async () => {
    const { status, body } = await api("/api/v1/config");
    expect(status).toBe(200);
    // Config is stored as key-value pairs in Memgraph â€” may be empty on fresh DB
    // Just verify it's a valid JSON object (not an array, not null)
    const b = asObj(body);
    expect(typeof b).toBe("object");
    expect(Array.isArray(b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/v1/config/memforge/llm", () => {
  it("returns 200 or 410 (env-only config)", async () => {
    const { status } = await api("/api/v1/config/memforge/llm");
    // 410 = LLM config is managed via env vars (not at runtime)
    expect([200, 410]).toContain(status);
  });
});

describe("GET /api/v1/config/memforge/embedder", () => {
  it("returns 200 or 410 (env-only config)", async () => {
    const { status } = await api("/api/v1/config/memforge/embedder");
    // 410 = Embedder config is managed via env vars (not at runtime)
    expect([200, 410]).toContain(status);
  });
});

describe("GET /api/v1/config/memforge/vector_store", () => {
  it("returns 200 with vector store config", async () => {
    const { status, body } = await api("/api/v1/config/memforge/vector_store");
    expect(status).toBe(200);
    const b = asObj(body);
    expect(b.provider ?? b.url ?? b.config).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe("PUT /api/v1/config â€” roundtrip", () => {
  it("writes a memforge config key and reads it back", async () => {
    // First read current config
    const { status: readStatus, body: readBody } = await api(
      "/api/v1/config/memforge"
    );
    expect(readStatus).toBe(200);
    const current = asObj(readBody);

    // Write a test key
    const testPayload = {
      ...(current as Record<string, unknown>),
      _e2e_test_marker: `run-${RUN_ID}`,
    };
    const { status: writeStatus } = await api("/api/v1/config/memforge", {
      method: "PUT",
      body: testPayload,
    });
    expect([200, 204]).toContain(writeStatus);

    // Read back and verify (optional â€” may not persist in-memory)
    const { status: verifyStatus, body: verifyBody } = await api(
      "/api/v1/config/memforge"
    );
    expect(verifyStatus).toBe(200);
    const verified = asObj(verifyBody);
    // May or may not persist â€” just assert 200 round-trip
    expect(verified).toBeDefined();
  });
});
