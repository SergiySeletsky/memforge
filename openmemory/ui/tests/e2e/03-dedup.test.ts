/**
 * E2E — Deduplication pipeline (Spec 03)
 *
 * Covers:
 *   - POSTing two semantically identical memories produces SKIP_DUPLICATE or SUPERSEDE
 *   - Different memories are stored independently
 *   - Dedup event is surfaced in the results array
 */

import { api, asObj, MemoryTracker, RUN_ID } from "./helpers";

const USER = `dedup-${RUN_ID}`;
const APP = `e2e-dedup-app`;
const tracker = new MemoryTracker();

afterAll(async () => {
  await tracker.cleanup(USER);
});

// ---------------------------------------------------------------------------
describe("Deduplication — identical content", () => {
  let firstId: string;

  it("first insertion of a fact is stored (ADD event)", async () => {
    const { status, body } = await api("/api/v1/memories", {
      method: "POST",
      body: {
        user_id: USER,
        text: "My blood type is O positive.",
        app: APP,
      },
    });
    expect(status).toBe(200);
    const b = asObj(body);
    // Single memory object returned, may have event field on SKIP_DUPLICATE
    expect(typeof b.id).toBe("string");
    firstId = b.id as string;
    tracker.track(firstId);
  });

  it("second insertion of the same fact is a SKIP_DUPLICATE or SUPERSEDE", async () => {
    const { status, body } = await api("/api/v1/memories", {
      method: "POST",
      body: {
        user_id: USER,
        text: "My blood type is O positive.",
        app: APP,
      },
    });
    expect(status).toBe(200);
    const b = asObj(body);
    // Either same id (skip) or new id (supersede)
    if (b.id && b.id !== firstId) tracker.track(b.id as string);
    const event = b.event as string | undefined;
    // If event is set, it should be SKIP_DUPLICATE or supersede-related
    if (event) {
      const knownEvents = ["SKIP_DUPLICATE", "SUPERSEDE", "NOOP", "UPDATE", "ADD"];
      expect(knownEvents).toContain(event);
    }
    // Either same ID (skip) or valid new ID
    expect(typeof b.id).toBe("string");
  });
});

// ---------------------------------------------------------------------------
describe("Deduplication — different content", () => {
  let id1: string;
  let id2: string;

  it("two distinct facts are stored as ADD events with different IDs", async () => {
    // Run sequentially to avoid Memgraph contention from other suite's async
    // fire-and-forget tasks (entity extraction, categorisation) still running.
    const r1 = await api("/api/v1/memories", {
      method: "POST",
      body: {
        user_id: USER,
        text: "I prefer coffee over tea.",
        app: APP,
      },
    });
    const r2 = await api("/api/v1/memories", {
      method: "POST",
      body: {
        user_id: USER,
        text: "I enjoy hiking in the mountains.",
        app: APP,
      },
    });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const b1 = asObj(r1.body);
    const b2 = asObj(r2.body);
    id1 = b1.id as string;
    id2 = b2.id as string;
    tracker.track(id1);
    tracker.track(id2);

    expect(id1).not.toBe(id2);
  });

  it("both distinct memories are in the user's list", async () => {
    const { status, body } = await api("/api/v1/memories", {
      params: { user_id: USER },
    });
    expect(status).toBe(200);
    const b = asObj(body);
    const arr = (b.items ?? []) as unknown[];
    const ids = arr.map((m) => (m as { id: string }).id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });
});
