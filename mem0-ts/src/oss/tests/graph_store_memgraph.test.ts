/**
 * MemgraphGraphStore integration tests — runs against a real Memgraph instance.
 *
 * Tests the full GraphStore interface: node CRUD, edge/relationship CRUD,
 * similarity search, and neighborhood/subgraph traversal.
 *
 * Requires a running Memgraph instance with MAGE module (for vector_search).
 * Tests are skipped when Memgraph is unreachable.
 *
 * Start Memgraph:
 *   cd openmemory && docker-compose up
 */

import neo4j from "neo4j-driver";

const DIM = 16;
const MEMGRAPH_URL = process.env.MEMGRAPH_URL ?? "bolt://localhost:7687";
const MEMGRAPH_USER = process.env.MEMGRAPH_USER ?? "memgraph";
const MEMGRAPH_PASSWORD = process.env.MEMGRAPH_PASSWORD ?? "memgraph";

/** Deterministic non-negative embedding. */
function textToVec(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Array.from({ length: DIM }, (_, i) =>
    Math.abs(Math.sin(hash + i * 0.1)),
  );
}

/** Check if Memgraph is reachable. */
async function isMemgraphAvailable(): Promise<boolean> {
  const driver = neo4j.driver(
    MEMGRAPH_URL,
    neo4j.auth.basic(MEMGRAPH_USER, MEMGRAPH_PASSWORD),
  );
  try {
    const session = driver.session();
    await session.run("RETURN 1");
    await session.close();
    return true;
  } catch {
    return false;
  } finally {
    await driver.close();
  }
}

let memgraphAvailable = false;
let MemgraphGraphStore: typeof import("../src/graph_stores/memgraph").MemgraphGraphStore;

beforeAll(async () => {
  memgraphAvailable = await isMemgraphAvailable();
  if (memgraphAvailable) {
    const mod = await import("../src/graph_stores/memgraph");
    MemgraphGraphStore = mod.MemgraphGraphStore;
  }
});

const describeIfMemgraph = (): jest.Describe =>
  memgraphAvailable ? describe : describe.skip;

// eslint-disable-next-line jest/valid-title
describe("MemgraphGraphStore", () => {
  let store: InstanceType<typeof MemgraphGraphStore>;
  let testCounter = 0;

  function freshUserId(): string {
    testCounter++;
    return `gs-mg-${Date.now()}-${testCounter}`;
  }

  beforeAll(async () => {
    if (!memgraphAvailable) return;
    store = new MemgraphGraphStore({
      url: MEMGRAPH_URL,
      username: MEMGRAPH_USER,
      password: MEMGRAPH_PASSWORD,
      dimension: DIM,
      indexName: `entity_test_${Date.now()}`,
    });
    await store.initialize();
  });

  afterAll(async () => {
    if (store) await store.close();
  });

  // Wrap each test so it skips at runtime if Memgraph is unavailable
  function skipIfNoMemgraph() {
    if (!memgraphAvailable) {
      console.log("⏭  Memgraph not reachable — skipping test");
      return true;
    }
    return false;
  }

  // ─── Node CRUD ───────────────────────────────────────────────────────────

  it("should upsert nodes via upsertRelationship", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();
    const edge = await store.upsertRelationship(
      {
        sourceName: "Alice",
        sourceType: "person",
        targetName: "Bob",
        targetType: "person",
        relationship: "KNOWS",
      },
      { source: textToVec("Alice"), target: textToVec("Bob") },
      { userId },
    );

    expect(edge.sourceName).toBe("alice");
    expect(edge.targetName).toBe("bob");
    expect(edge.relationship).toBe("KNOWS");
    expect(edge.id).toBeDefined();
  });

  it("should get a node by ID", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();
    const edge = await store.upsertRelationship(
      {
        sourceName: "Charlie",
        sourceType: "person",
        targetName: "Python",
        targetType: "technology",
        relationship: "USES",
      },
      { source: textToVec("Charlie"), target: textToVec("Python") },
      { userId },
    );

    const node = await store.getNode(edge.sourceId, { userId });
    expect(node).not.toBeNull();
    expect(node!.name).toBe("charlie");
    expect(node!.type).toBe("person");
  });

  it("should return null for nonexistent node", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();
    const node = await store.getNode("nonexistent-id", { userId });
    expect(node).toBeNull();
  });

  it("should delete a node and its edges", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();
    const edge = await store.upsertRelationship(
      {
        sourceName: "ToDelete",
        targetName: "Stays",
        relationship: "TEMP",
      },
      { source: textToVec("ToDelete"), target: textToVec("Stays") },
      { userId },
    );

    await store.deleteNode(edge.sourceId, { userId });

    const node = await store.getNode(edge.sourceId, { userId });
    expect(node).toBeNull();
  });

  // ─── Search nodes ────────────────────────────────────────────────────────

  it("should search nodes by embedding similarity", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();
    await store.upsertRelationship(
      {
        sourceName: "TypeScript",
        sourceType: "technology",
        targetName: "JavaScript",
        targetType: "technology",
        relationship: "EXTENDS",
      },
      { source: textToVec("TypeScript"), target: textToVec("JavaScript") },
      { userId },
    );

    const results = await store.searchNodes(
      textToVec("TypeScript"),
      { userId },
      5,
      0.5,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("typescript");
    expect(results[0].score).toBeGreaterThanOrEqual(0.5);
  });

  it("should isolate search results by userId", async () => {
    if (skipIfNoMemgraph()) return;
    const user1 = freshUserId();
    const user2 = freshUserId();

    await store.upsertRelationship(
      { sourceName: "NodeA", targetName: "NodeB", relationship: "REL" },
      { source: textToVec("NodeA"), target: textToVec("NodeB") },
      { userId: user1 },
    );

    await store.upsertRelationship(
      { sourceName: "NodeC", targetName: "NodeD", relationship: "REL" },
      { source: textToVec("NodeC"), target: textToVec("NodeD") },
      { userId: user2 },
    );

    const results1 = await store.searchNodes(
      textToVec("NodeA"),
      { userId: user1 },
      10,
      0.0,
    );
    const names1 = results1.map((r) => r.name);
    expect(names1).not.toContain("nodec");
    expect(names1).not.toContain("noded");
  });

  // ─── Edge / relationship CRUD ────────────────────────────────────────────

  it("should search edges by embedding similarity", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();
    await store.upsertRelationship(
      {
        sourceName: "Alice",
        sourceType: "person",
        targetName: "Rust",
        targetType: "technology",
        relationship: "PROGRAMS_IN",
      },
      { source: textToVec("Alice"), target: textToVec("Rust") },
      { userId },
    );

    const triples = await store.searchEdges(
      textToVec("Alice"),
      { userId },
      5,
      0.5,
    );

    expect(triples.length).toBeGreaterThan(0);
    const found = triples.find(
      (t) => t.source === "alice" && t.relationship === "PROGRAMS_IN",
    );
    expect(found).toBeDefined();
  });

  it("should delete a relationship", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();
    await store.upsertRelationship(
      {
        sourceName: "X",
        targetName: "Y",
        relationship: "TEMP_REL",
      },
      { source: textToVec("X"), target: textToVec("Y") },
      { userId },
    );

    await store.deleteRelationship("X", "TEMP_REL", "Y", { userId });

    const triples = await store.getAll({ userId });
    const found = triples.find(
      (t) => t.source === "x" && t.relationship === "TEMP_REL" && t.target === "y",
    );
    expect(found).toBeUndefined();
  });

  it("should upsert (update) an existing relationship", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();

    await store.upsertRelationship(
      {
        sourceName: "Dev",
        targetName: "Go",
        relationship: "LIKES",
        properties: { strength: "weak" },
      },
      { source: textToVec("Dev"), target: textToVec("Go") },
      { userId },
    );

    const edge = await store.upsertRelationship(
      {
        sourceName: "Dev",
        targetName: "Go",
        relationship: "LIKES",
        properties: { strength: "strong" },
      },
      { source: textToVec("Dev"), target: textToVec("Go") },
      { userId },
    );

    expect(edge.properties).toEqual({ strength: "strong" });

    const all = await store.getAll({ userId });
    const likes = all.filter(
      (t) => t.source === "dev" && t.relationship === "LIKES" && t.target === "go",
    );
    expect(likes.length).toBe(1);
  });

  // ─── Traversal ───────────────────────────────────────────────────────────

  it("should get the neighborhood of a node", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();

    const ab = await store.upsertRelationship(
      { sourceName: "A", targetName: "B", relationship: "LINK" },
      { source: textToVec("A"), target: textToVec("B") },
      { userId },
    );
    await store.upsertRelationship(
      { sourceName: "B", targetName: "C", relationship: "LINK" },
      { source: textToVec("B"), target: textToVec("C") },
      { userId },
    );

    const sub = await store.getNeighborhood(ab.sourceId, { userId }, { depth: 1 });
    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain("b");
    expect(sub.edges.length).toBeGreaterThan(0);
  });

  it("should get a deeper neighborhood with depth=2", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();

    const ab = await store.upsertRelationship(
      { sourceName: "P", targetName: "Q", relationship: "LINK" },
      { source: textToVec("P"), target: textToVec("Q") },
      { userId },
    );
    await store.upsertRelationship(
      { sourceName: "Q", targetName: "R", relationship: "LINK" },
      { source: textToVec("Q"), target: textToVec("R") },
      { userId },
    );

    const sub = await store.getNeighborhood(ab.sourceId, { userId }, { depth: 2 });
    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain("q");
    expect(names).toContain("r");
  });

  it("should get a subgraph (ego-graph) including inter-neighbor edges", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();

    const ab = await store.upsertRelationship(
      { sourceName: "A1", targetName: "B1", relationship: "LINK" },
      { source: textToVec("A1"), target: textToVec("B1") },
      { userId },
    );
    await store.upsertRelationship(
      { sourceName: "A1", targetName: "C1", relationship: "LINK" },
      { source: textToVec("A1"), target: textToVec("C1") },
      { userId },
    );
    await store.upsertRelationship(
      { sourceName: "B1", targetName: "C1", relationship: "LINK" },
      { source: textToVec("B1"), target: textToVec("C1") },
      { userId },
    );

    const sub = await store.getSubgraph(ab.sourceId, { userId }, { depth: 1 });
    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain("b1");
    expect(names).toContain("c1");

    const b1c1 = sub.edges.find(
      (e) => e.sourceName === "b1" && e.targetName === "c1",
    );
    expect(b1c1).toBeDefined();
  });

  // ─── Bulk operations ─────────────────────────────────────────────────────

  it("should return all relationships for a user", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();

    await store.upsertRelationship(
      { sourceName: "E1", targetName: "E2", relationship: "R1" },
      { source: textToVec("E1"), target: textToVec("E2") },
      { userId },
    );
    await store.upsertRelationship(
      { sourceName: "E2", targetName: "E3", relationship: "R2" },
      { source: textToVec("E2"), target: textToVec("E3") },
      { userId },
    );

    const all = await store.getAll({ userId });
    expect(all.length).toBe(2);
    expect(all.map((t) => t.relationship).sort()).toEqual(["R1", "R2"]);
  });

  it("should delete all graph data for a user", async () => {
    if (skipIfNoMemgraph()) return;
    const userId = freshUserId();

    await store.upsertRelationship(
      { sourceName: "Gone1", targetName: "Gone2", relationship: "BYE" },
      { source: textToVec("Gone1"), target: textToVec("Gone2") },
      { userId },
    );

    await store.deleteAll({ userId });

    const all = await store.getAll({ userId });
    expect(all.length).toBe(0);
  });

  it("should not affect other users when deleting", async () => {
    if (skipIfNoMemgraph()) return;
    const user1 = freshUserId();
    const user2 = freshUserId();

    await store.upsertRelationship(
      { sourceName: "Keep", targetName: "Me", relationship: "SAFE" },
      { source: textToVec("Keep"), target: textToVec("Me") },
      { userId: user1 },
    );
    await store.upsertRelationship(
      { sourceName: "Delete", targetName: "This", relationship: "GONE" },
      { source: textToVec("Delete"), target: textToVec("This") },
      { userId: user2 },
    );

    await store.deleteAll({ userId: user2 });

    const user1Data = await store.getAll({ userId: user1 });
    expect(user1Data.length).toBe(1);
    expect(user1Data[0].source).toBe("keep");

    const user2Data = await store.getAll({ userId: user2 });
    expect(user2Data.length).toBe(0);
  });
});
