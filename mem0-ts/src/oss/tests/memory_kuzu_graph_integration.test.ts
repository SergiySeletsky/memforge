/// <reference types="jest" />
/**
 * KuzuDB Graph Integration Tests — Memory API with enableGraph: true
 *
 * Exercises the full Memory + KuzuGraphStore pipeline:
 *   upsertRelationship, getAllRelationships, deleteRelationship,
 *   getGraphNode, deleteGraphNode, getNeighborhood, getSubgraph,
 *   deleteAllGraph — all purely on KuzuDB (no Memgraph, no server).
 *
 * Also verifies that the automatic historyStore fallback selects "kuzu"
 * when vectorStore.provider === "kuzu" and no historyStore is configured.
 *
 * LLM + Embedder: MOCKED
 * Vector store:   REAL KuzuDB (in-process, ":memory:")
 * History store:  REAL KuzuDB (auto-selected, ":memory:")
 * Graph store:    REAL KuzuDB (in-process, ":memory:")
 */

// ── Mock OpenAI before any imports ──────────────────────────────────────────
const mockChatCreate = jest.fn();
const mockEmbedCreate = jest.fn();

jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCreate } },
    embeddings: { create: mockEmbedCreate },
  }));
});

import { Memory } from "../src";
import { SearchResult } from "../src/types";
import type { GraphNode, GraphEdge, RelationTriple } from "../src/graph_stores/base";

jest.setTimeout(60_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

const DIM = 64;

function textToVec(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Array.from({ length: DIM }, (_, i) => Math.abs(Math.sin(hash + i * 0.1)));
}

function mockEmbedding(): void {
  mockEmbedCreate.mockImplementation((args: { input: string | string[] }) => {
    const inputs = Array.isArray(args.input) ? args.input : [args.input];
    return Promise.resolve({
      data: inputs.map((text) => ({ embedding: textToVec(text) })),
    });
  });
}

function mockLLMForAdd(facts: string[]): void {
  mockChatCreate
    .mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: JSON.stringify({ facts }) } }],
    })
    .mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              memory: facts.map((f) => ({ id: "new", event: "ADD", text: f, old_memory: "", new_memory: f })),
            }),
          },
        },
      ],
    });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("KuzuDB Graph Integration — Memory API with enableGraph: true", () => {
  let memory: Memory;
  let testCounter = 0;

  function freshUserId(): string {
    testCounter++;
    return `gs-integ-${Date.now()}-${testCounter}`;
  }

  beforeAll(async () => {
    mockEmbedding();

    // Single Memory instance for the entire suite — KuzuDB 0.9 native addon
    // crashes (STATUS_HEAP_CORRUPTION) when multiple Database objects are
    // created and GC'd in the same process.
    memory = new Memory({
      version: "v1.1",
      embedder: {
        provider: "openai",
        config: { apiKey: "test-key", model: "text-embedding-3-small", embeddingDims: DIM },
      },
      vectorStore: {
        provider: "kuzu",
        config: {
          collectionName: "graph_integ_test",
          dimension: DIM,
          dbPath: ":memory:",
        },
      },
      llm: {
        provider: "openai",
        config: { apiKey: "test-key", model: "gpt-4o-mini" },
      },
      // historyStore intentionally OMITTED — should auto-select kuzu because
      // vectorStore.provider === "kuzu". This is the default-fallback test.
      enableGraph: true,
      graphStore: {
        provider: "kuzu",
        config: { dbPath: ":memory:" },
      },
    });
  });

  beforeEach(() => {
    mockChatCreate.mockReset();
    mockEmbedding();
  });

  // ── Default historyStore auto-selection ─────────────────────────────────

  it("auto-selects KuzuDB as historyStore when vectorStore is kuzu and historyStore is omitted", async () => {
    // Verify by checking that add() + history() round-trips without any
    // Memgraph connection error (if kuzu fallback is wrong, this throws).
    const userId = freshUserId();
    mockLLMForAdd(["Auto-history-select test"]);

    const result = (await memory.add("Auto-history test", { userId })) as SearchResult;
    expect(result.results.length).toBe(1);

    const memoryId = result.results[0].id;
    const history = await memory.history(memoryId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history.some((h: any) => h.action === "ADD" || h.action === "add")).toBe(true);
  });

  // ── upsertRelationship ───────────────────────────────────────────────────

  it("upsertRelationship: creates nodes and an edge", async () => {
    const userId = freshUserId();

    const edge: GraphEdge = await memory.upsertRelationship(
      { sourceName: "Alice", sourceType: "person", targetName: "TypeScript", targetType: "technology", relationship: "USES" },
      { userId },
    );

    expect(edge.sourceName).toBe("alice");
    expect(edge.targetName).toBe("typescript");
    expect(edge.relationship).toBe("USES");
    expect(edge.id).toBeDefined();
    expect(edge.sourceId).toBeDefined();
    expect(edge.targetId).toBeDefined();
  });

  it("upsertRelationship: second call merges instead of duplicating", async () => {
    const userId = freshUserId();

    await memory.upsertRelationship(
      { sourceName: "Bob", targetName: "Python", relationship: "WRITES_IN", properties: { level: "beginner" } },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "Bob", targetName: "Python", relationship: "WRITES_IN", properties: { level: "expert" } },
      { userId },
    );

    const triples = await memory.getAllRelationships({ userId });
    const writes = triples.filter((t) => t.source === "bob" && t.relationship === "WRITES_IN" && t.target === "python");
    expect(writes.length).toBe(1);
  });

  it("upsertRelationship: is scoped by userId (namespace isolation)", async () => {
    const user1 = freshUserId();
    const user2 = freshUserId();

    await memory.upsertRelationship(
      { sourceName: "User1Node", targetName: "User1Target", relationship: "OWNS" },
      { userId: user1 },
    );
    await memory.upsertRelationship(
      { sourceName: "User2Node", targetName: "User2Target", relationship: "OWNS" },
      { userId: user2 },
    );

    const u1triples = await memory.getAllRelationships({ userId: user1 });
    const u2triples = await memory.getAllRelationships({ userId: user2 });

    expect(u1triples.every((t) => t.source === "user1node" || t.target === "user1target")).toBe(true);
    expect(u2triples.every((t) => t.source === "user2node" || t.target === "user2target")).toBe(true);
  });

  // ── getAllRelationships ──────────────────────────────────────────────────

  it("getAllRelationships: returns all triples for a user", async () => {
    const userId = freshUserId();

    await memory.upsertRelationship(
      { sourceName: "Carol", targetName: "Rust", relationship: "LOVES" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "Carol", targetName: "Go", relationship: "DISLIKES" },
      { userId },
    );

    const triples = await memory.getAllRelationships({ userId });
    expect(triples.length).toBe(2);
    const rels = triples.map((t) => t.relationship).sort();
    expect(rels).toEqual(["DISLIKES", "LOVES"]);
  });

  it("getAllRelationships: returns empty for user with no graph data", async () => {
    const triples = await memory.getAllRelationships({ userId: `nobody-${Date.now()}` });
    expect(triples).toEqual([]);
  });

  // ── deleteRelationship ───────────────────────────────────────────────────

  it("deleteRelationship: removes a specific triple", async () => {
    const userId = freshUserId();

    await memory.upsertRelationship(
      { sourceName: "Dave", targetName: "Java", relationship: "USED_TO_LIKE" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "Dave", targetName: "Kotlin", relationship: "NOW_LIKES" },
      { userId },
    );

    await memory.deleteRelationship("Dave", "USED_TO_LIKE", "Java", { userId });

    const triples = await memory.getAllRelationships({ userId });
    expect(triples.find((t) => t.relationship === "USED_TO_LIKE")).toBeUndefined();
    expect(triples.find((t) => t.relationship === "NOW_LIKES")).toBeDefined();
  });

  // ── getGraphNode / deleteGraphNode ───────────────────────────────────────

  it("getGraphNode: returns the node by ID", async () => {
    const userId = freshUserId();

    const edge = await memory.upsertRelationship(
      { sourceName: "Eve", sourceType: "person", targetName: "Redis", targetType: "technology", relationship: "OPERATES" },
      { userId },
    );

    const node: GraphNode | null = await memory.getGraphNode(edge.sourceId, { userId });
    expect(node).not.toBeNull();
    expect(node!.name).toBe("eve");
    expect(node!.type).toBe("person");
  });

  it("getGraphNode: returns null for unknown id", async () => {
    const node = await memory.getGraphNode("no-such-id", { userId: freshUserId() });
    expect(node).toBeNull();
  });

  it("deleteGraphNode: removes node and its edges", async () => {
    const userId = freshUserId();

    const edge = await memory.upsertRelationship(
      { sourceName: "TempNode", targetName: "Stays", relationship: "LINKED_TO" },
      { userId },
    );

    await memory.deleteGraphNode(edge.sourceId, { userId });

    const node = await memory.getGraphNode(edge.sourceId, { userId });
    expect(node).toBeNull();

    // Orphaned edge should be gone
    const triples = await memory.getAllRelationships({ userId });
    expect(triples.find((t) => t.source === "tempnode")).toBeUndefined();
  });

  // ── getNeighborhood ──────────────────────────────────────────────────────

  it("getNeighborhood: returns direct neighbors at depth=1", async () => {
    const userId = freshUserId();

    // Build A→B→C
    const ab = await memory.upsertRelationship(
      { sourceName: "NhA", targetName: "NhB", relationship: "LINK" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "NhB", targetName: "NhC", relationship: "LINK" },
      { userId },
    );

    const sub = await memory.getNeighborhood(ab.sourceId, { userId, depth: 1 });

    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain("nhb");
    // At depth=1 C should NOT be included
    expect(names).not.toContain("nhc");
    expect(sub.edges.length).toBeGreaterThan(0);
  });

  it("getNeighborhood: reaches depth=2 nodes", async () => {
    const userId = freshUserId();

    const ab = await memory.upsertRelationship(
      { sourceName: "D2A", targetName: "D2B", relationship: "HOP" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "D2B", targetName: "D2C", relationship: "HOP" },
      { userId },
    );

    const sub = await memory.getNeighborhood(ab.sourceId, { userId, depth: 2 });

    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain("d2b");
    expect(names).toContain("d2c");
  });

  // ── getSubgraph ──────────────────────────────────────────────────────────

  it("getSubgraph: includes inter-neighbor edges (triangle closure)", async () => {
    const userId = freshUserId();

    // Triangle: SgA→SgB, SgA→SgC, SgB→SgC
    const ab = await memory.upsertRelationship(
      { sourceName: "SgA", targetName: "SgB", relationship: "LINK" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "SgA", targetName: "SgC", relationship: "LINK" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "SgB", targetName: "SgC", relationship: "LINK" },
      { userId },
    );

    const sub = await memory.getSubgraph(ab.sourceId, { userId, depth: 1 });

    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain("sgb");
    expect(names).toContain("sgc");

    // The SgB→SgC inter-neighbor edge should be present
    const bc = sub.edges.find((e) => e.sourceName === "sgb" && e.targetName === "sgc");
    expect(bc).toBeDefined();
  });

  // ── deleteAllGraph ───────────────────────────────────────────────────────

  it("deleteAllGraph: removes all graph data for a user", async () => {
    const userId = freshUserId();

    await memory.upsertRelationship(
      { sourceName: "WillGo1", targetName: "WillGo2", relationship: "TEMP" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "WillGo3", targetName: "WillGo4", relationship: "TEMP" },
      { userId },
    );

    await memory.deleteAllGraph({ userId });

    const triples = await memory.getAllRelationships({ userId });
    expect(triples).toEqual([]);
  });

  it("deleteAllGraph: does not affect other users", async () => {
    const user1 = freshUserId();
    const user2 = freshUserId();

    await memory.upsertRelationship(
      { sourceName: "SafeNode", targetName: "SafeTarget", relationship: "KEEP" },
      { userId: user1 },
    );
    await memory.upsertRelationship(
      { sourceName: "GoneNode", targetName: "GoneTarget", relationship: "DELETE" },
      { userId: user2 },
    );

    await memory.deleteAllGraph({ userId: user2 });

    const u1triples = await memory.getAllRelationships({ userId: user1 });
    expect(u1triples.length).toBe(1);
    expect(u1triples[0].source).toBe("safenode");

    const u2triples = await memory.getAllRelationships({ userId: user2 });
    expect(u2triples).toEqual([]);
  });

  // ── Memory.add() + graph store co-exist ─────────────────────────────────

  it("vector memories and graph store operate independently on same user", async () => {
    const userId = freshUserId();

    // Add vector memory
    mockLLMForAdd(["Frances likes Elixir"]);
    const addResult = (await memory.add("Frances likes Elixir", { userId })) as SearchResult;
    expect(addResult.results.length).toBe(1);

    // Write graph data for same user
    const edge = await memory.upsertRelationship(
      { sourceName: "Frances", targetName: "Elixir", relationship: "LIKES" },
      { userId },
    );
    expect(edge).toBeDefined();

    // Both retrievable
    const allMems = (await memory.getAll({ userId })) as SearchResult;
    expect(allMems.results.length).toBeGreaterThanOrEqual(1);

    const triples = await memory.getAllRelationships({ userId });
    expect(triples.length).toBe(1);
    expect(triples[0].source).toBe("frances");
    expect(triples[0].relationship).toBe("LIKES");
  });

  // ── Batch add (multiple memories per user) ───────────────────────────────

  it("sequential batch add with kuzu stores all facts correctly", async () => {
    const userId = freshUserId();
    const facts = [
      ["Grace uses Haskell"],
      ["Grace lives in Edinburgh"],
      ["Grace works at Acme"],
    ];

    for (const [fact] of facts) {
      mockLLMForAdd([fact]);
      await memory.add(fact, { userId });
    }

    const all = (await memory.getAll({ userId })) as SearchResult;
    expect(all.results.length).toBe(3);
    const texts = all.results.map((r) => r.memory);
    expect(texts).toContain("Grace uses Haskell");
    expect(texts).toContain("Grace lives in Edinburgh");
    expect(texts).toContain("Grace works at Acme");
  });

  // ── agentId / runId graph scoping ────────────────────────────────────────

  it("upsertRelationship scoped by agentId, not userId", async () => {
    const agentId = `agent-graph-${Date.now()}`;

    const edge = await memory.upsertRelationship(
      { sourceName: "AgentNode", targetName: "AgentTarget", relationship: "MONITORED_BY" },
      { agentId },
    );
    expect(edge).toBeDefined();

    const triples = await memory.getAllRelationships({ agentId });
    expect(triples.length).toBe(1);
    expect(triples[0].relationship).toBe("MONITORED_BY");

    // Different agentId should not see these
    const otherTriples = await memory.getAllRelationships({ agentId: `other-agent-${Date.now()}` });
    expect(otherTriples.every((t) => t.relationship !== "MONITORED_BY")).toBe(true);
  });

  // ── Multiple relationship types on same entity pair ──────────────────────

  it("multiple distinct relationships between same entity pair are all stored", async () => {
    const userId = freshUserId();

    await memory.upsertRelationship(
      { sourceName: "Henry", targetName: "Linux", relationship: "USES" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "Henry", targetName: "Linux", relationship: "CONTRIBUTES_TO" },
      { userId },
    );
    await memory.upsertRelationship(
      { sourceName: "Henry", targetName: "Linux", relationship: "DEPLOYS_ON" },
      { userId },
    );

    const triples = await memory.getAllRelationships({ userId });
    const henryTriples = triples.filter((t) => t.source === "henry" && t.target === "linux");
    expect(henryTriples.length).toBe(3);
    const rels = henryTriples.map((t) => t.relationship).sort();
    expect(rels).toEqual(["CONTRIBUTES_TO", "DEPLOYS_ON", "USES"]);
  });
});

