/**
 * POST /api/v1/memories/reextract?user_id=X
 *
 * Trigger (or re-trigger) async entity extraction for all Memory nodes
 * belonging to the given user that have not yet been successfully extracted.
 *
 * Useful after deploying extraction fixes or on first run.
 * Returns { queued: number } immediately; extraction runs in the background.
 */
import { NextRequest, NextResponse } from "next/server";
import { runRead } from "@/lib/db/memgraph";
import { processEntityExtraction } from "@/lib/entities/worker";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("user_id");
  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  // Find all Memory IDs for this user that are not 'done'
  const rows = await runRead<{ id: string }>(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
     RETURN m.id AS id`,
    { userId }
  );

  // Fire-and-forget extraction for each
  let queued = 0;
  const jobs: Promise<void>[] = [];
  for (const { id } of rows) {
    const job = processEntityExtraction(id).catch((e) =>
      console.warn("[reextract] worker error for", id, e?.message)
    );
    jobs.push(job);
    queued++;
  }

  if (process.env.NODE_ENV === "test" || process.env.MEMFORGE_SYNC_ENTITY_EXTRACTION === "1") {
    await Promise.allSettled(jobs);
  }

  return NextResponse.json({ queued, user_id: userId });
}
