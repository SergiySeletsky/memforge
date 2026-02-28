/**
 * lib/graph/types.ts — GraphStore interface & types (migrated from memforge-ts/oss)
 *
 * Backend-agnostic interface for graph-native memory operations.
 * While Memory nodes handle flat "fact" vectors, GraphStore exposes the
 * relationships between entities that graph databases natively support:
 *
 *   (Entity)--[:RELATIONSHIP]-->(Entity)
 *
 * Enables Graphiti-style patterns:
 * - Search *nodes* (entities) by embedding similarity
 * - Search *edges* (relationships / facts) by text or type
 * - Traverse the *neighborhood* around an entity
 * - Return a *subgraph* centered on a given node
 * - CRUD on individual nodes, edges, and relationships
 *
 * All operations scoped by userId for namespace isolation (Spec 09).
 */

// ─── Data types ──────────────────────────────────────────────────────────────

/** A single entity node in the knowledge graph. */
export interface GraphNode {
  /** Unique node identifier (UUID). */
  id: string;
  /** Human-readable name / label of this entity. */
  name: string;
  /** Optional entity type (e.g. "PERSON", "TECHNOLOGY", "LOCATION"). */
  type?: string;
  /** Embedding vector stored on the node (may be omitted in list results). */
  embedding?: number[];
  /** Arbitrary properties attached to the node. */
  properties: Record<string, unknown>;
  /** Similarity score when returned from a search. */
  score?: number;
}

/** A directed relationship (edge) between two nodes. */
export interface GraphEdge {
  /** Unique edge identifier. */
  id: string;
  /** Source node id. */
  sourceId: string;
  /** Source node name (convenience — avoids extra lookup). */
  sourceName: string;
  /** Relationship type / label (e.g. "KNOWS", "USES", "LIVES_IN"). */
  relationship: string;
  /** Target node id. */
  targetId: string;
  /** Target node name. */
  targetName: string;
  /** Arbitrary properties stored on the edge. */
  properties: Record<string, unknown>;
}

/** A subgraph — a set of nodes + the edges that connect them. */
export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A relationship triple — the user-friendly search result shape. */
export interface RelationTriple {
  source: string;
  relationship: string;
  target: string;
  score?: number;
}

// ─── Input types ─────────────────────────────────────────────────────────────

/** Options for upserting a relationship. */
export interface UpsertRelationshipInput {
  /** Source entity name (will be created if missing). */
  sourceName: string;
  /** Source entity type (used when creating). */
  sourceType?: string;
  /** Target entity name (will be created if missing). */
  targetName: string;
  /** Target entity type (used when creating). */
  targetType?: string;
  /** Relationship type / label. */
  relationship: string;
  /** Extra properties on both nodes and/or the edge. */
  properties?: Record<string, unknown>;
}

/** Options for neighborhood / subgraph queries. */
export interface TraversalOptions {
  /** Max traversal depth (default 1 = direct neighbors). */
  depth?: number;
  /** Max number of nodes to return. */
  limit?: number;
  /** Filter to specific relationship types. */
  relationshipTypes?: string[];
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface GraphStore {
  /** One-time initialization (create indexes / tables). */
  initialize(): Promise<void>;

  // ── Node CRUD ────────────────────────────────────────────────────────────

  /**
   * Search entity *nodes* by embedding similarity.
   * Returns nodes sorted by descending similarity.
   */
  searchNodes(
    queryEmbedding: number[],
    userId: string,
    limit?: number,
    threshold?: number,
  ): Promise<GraphNode[]>;

  /** Get a single node by id. */
  getNode(nodeId: string, userId: string): Promise<GraphNode | null>;

  /** Delete a single node (and its incident edges) by id. */
  deleteNode(nodeId: string, userId: string): Promise<void>;

  // ── Edge / Relationship CRUD ─────────────────────────────────────────────

  /**
   * Search *edges* (facts / relationships).
   * Searches by embedding similarity on the source **or** destination node,
   * returning matching relationship triples.
   */
  searchEdges(
    queryEmbedding: number[],
    userId: string,
    limit?: number,
    threshold?: number,
  ): Promise<RelationTriple[]>;

  /** Upsert (MERGE) a relationship between two entities. */
  upsertRelationship(
    input: UpsertRelationshipInput,
    embedding: { source: number[]; target: number[] },
    userId: string,
  ): Promise<GraphEdge>;

  /** Delete a specific relationship by source name + relationship type + target name. */
  deleteRelationship(
    sourceName: string,
    relationship: string,
    targetName: string,
    userId: string,
  ): Promise<void>;

  // ── Traversal ────────────────────────────────────────────────────────────

  /**
   * Return the direct neighborhood of a node — all nodes and edges within
   * `depth` hops.
   */
  getNeighborhood(
    nodeId: string,
    userId: string,
    options?: TraversalOptions,
  ): Promise<Subgraph>;

  /**
   * Return a subgraph centered on a node (ego-graph).
   * Similar to getNeighborhood but may include edges *between* neighbors.
   */
  getSubgraph(
    nodeId: string,
    userId: string,
    options?: TraversalOptions,
  ): Promise<Subgraph>;

  // ── Bulk ─────────────────────────────────────────────────────────────────

  /** Return all relationship triples for a user. */
  getAll(userId: string, limit?: number): Promise<RelationTriple[]>;

  /** Delete all graph entity nodes + edges for a user. */
  deleteAll(userId: string): Promise<void>;
}
