/**
 * lib/clusters/build.ts — Hierarchical Community Detection (GraphRAG-inspired)
 *
 * Builds hierarchical community nodes using Louvain community detection.
 * Communities operate across ALL users intentionally — shared context is a core
 * feature. One user's fix on project X should help another user on the same project.
 *
 * Hierarchy: Level 0 = broadest communities (from global graph),
 *            Level 1 = subcommunities (from within each L0 community).
 * The hierarchy enables multi-level summarization and community-aware search.
 *
 * Pipeline:
 *   1. Count active memories globally (skip if < 5)
 *   2. Run community_detection.get() on ALL active memories (cross-user by design)
 *   3. Group results by community_id → Level 0 communities
 *   4. For large L0 communities (>= 8 members), recurse to build L1 subcommunities
 *   5. Delete existing Community nodes for this user (replace, not accumulate)
 *   6. For each group with >= 2 members: LLM summarize → CREATE Community node + edges
 *
 * Called per-user but builds from the global graph. The user's Community nodes
 * link to their specific memories within each global community.
 */

import { runRead, runWrite } from "@/lib/db/memgraph";
import { summarizeCluster } from "./summarize";
import { v4 as uuidv4 } from "uuid";

interface CommunityMember {
  id: string;
  content: string;
  communityId: number;
}

/** Minimum members for a community to be worth creating */
const MIN_COMMUNITY_SIZE = 2;

/** Minimum members in an L0 community to warrant subcommunity detection */
const SUBCOMMUNITY_THRESHOLD = 8;

/** Maximum hierarchy depth (0-indexed: level 0 and level 1) */
const MAX_LEVELS = 2;

export interface CommunityNode {
  id: string;
  name: string;
  summary: string;
  level: number;
  parentId: string | null;
  memberCount: number;
  memoryIds: string[];
}

/**
 * Rebuild hierarchical community clusters for a user.
 * Detection runs on the global memory graph (cross-user shared context),
 * but Community nodes are linked to the specific user who triggered the rebuild.
 */
export async function rebuildClusters(userId: string): Promise<void> {
  // Step 1: Minimum threshold check (global count)
  const countResult = await runRead(
    `MATCH (m:Memory)
     WHERE m.invalidAt IS NULL
     RETURN count(m) AS total`,
    {}
  );
  const total = ((countResult[0] as { total: number })?.total as number) ?? 0;
  if (total < 5) return;

  // Step 2: Louvain community detection on global Memory graph
  const communityResults = (await runRead(
    `MATCH (m:Memory)
     WHERE m.invalidAt IS NULL
     CALL community_detection.get() YIELD node, community_id
     WHERE node = m
     RETURN node.id AS id, node.content AS content, community_id AS communityId
     ORDER BY community_id`,
    {}
  )) as CommunityMember[];

  // Step 3: Nothing to work with
  if (communityResults.length === 0) return;

  // Step 4: Group by community_id → Level 0
  const groups = new Map<number, CommunityMember[]>();
  for (const row of communityResults) {
    const key = row.communityId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  // Step 5: Delete old Community nodes for this user (idempotent rebuild)
  await runWrite(
    `MATCH (u:User {userId: $userId})-[:HAS_COMMUNITY]->(c:Community)
     DETACH DELETE c`,
    { userId }
  );

  const now = new Date().toISOString();
  const allCommunities: CommunityNode[] = [];

  // Step 6: Build Level 0 communities + Level 1 subcommunities
  for (const [, members] of groups) {
    if (members.length < MIN_COMMUNITY_SIZE) continue;

    // --- Level 0 community ---
    const l0Id = uuidv4();
    const { name: l0Name, summary: l0Summary } = await summarizeCluster(
      members.map((m) => m.content)
    );

    allCommunities.push({
      id: l0Id,
      name: l0Name,
      summary: l0Summary,
      level: 0,
      parentId: null,
      memberCount: members.length,
      memoryIds: members.map((m) => m.id),
    });

    // --- Level 1 subcommunities (for large communities) ---
    if (members.length >= SUBCOMMUNITY_THRESHOLD && MAX_LEVELS > 1) {
      // Simple content-based subclustering: group by first entity mention
      // This is a lightweight heuristic — full Leiden hierarchy would require
      // building a subgraph and re-running community detection
      const subclusters = buildSubclusters(members);
      for (const subMembers of subclusters) {
        if (subMembers.length < MIN_COMMUNITY_SIZE) continue;

        const l1Id = uuidv4();
        const { name: l1Name, summary: l1Summary } = await summarizeCluster(
          subMembers.map((m) => m.content)
        );
        allCommunities.push({
          id: l1Id,
          name: l1Name,
          summary: l1Summary,
          level: 1,
          parentId: l0Id,
          memberCount: subMembers.length,
          memoryIds: subMembers.map((m) => m.id),
        });
      }
    }
  }

  // Step 7: Write all community nodes + edges to DB
  for (const community of allCommunities) {
    await runWrite(
      `MATCH (u:User {userId: $userId})
       CREATE (c:Community {
         id:          $cId,
         name:        $name,
         summary:     $summary,
         level:       $level,
         parentId:    $parentId,
         memberCount: $count,
         createdAt:   $now,
         updatedAt:   $now
       })
       CREATE (u)-[:HAS_COMMUNITY]->(c)
       WITH c
       UNWIND $memIds AS memId
       MATCH (m:Memory {id: memId})
       CREATE (m)-[:IN_COMMUNITY]->(c)`,
      {
        userId,
        cId: community.id,
        name: community.name,
        summary: community.summary,
        level: community.level,
        parentId: community.parentId,
        count: community.memberCount,
        now,
        memIds: community.memoryIds,
      }
    );

    // Link child → parent
    if (community.parentId) {
      await runWrite(
        `MATCH (child:Community {id: $childId})
         MATCH (parent:Community {id: $parentId})
         CREATE (child)-[:SUBCOMMUNITY_OF]->(parent)`,
        { childId: community.id, parentId: community.parentId }
      );
    }
  }
}

/**
 * Simple subclustering heuristic: split a large community into smaller groups
 * based on content similarity (first N words as a hash key).
 * This is a lightweight alternative to running full Leiden on a subgraph.
 */
function buildSubclusters(members: CommunityMember[]): CommunityMember[][] {
  // Use first 3 significant words as a clustering key
  const groups = new Map<string, CommunityMember[]>();
  for (const m of members) {
    const words = m.content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3)
      .sort();
    const key = words.join("|") || "misc";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  // If subclustering produced only 1 group, don't create subcommunities
  if (groups.size <= 1) return [];

  return Array.from(groups.values());
}
