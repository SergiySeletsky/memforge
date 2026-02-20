/**
 * GET /api/v1/stats — user profile stats
 *
 * Port of openmemory/api/app/routers/stats.py
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { memories, apps, type MemoryState } from "@/lib/db/schema";
import { eq, and, ne, count } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/db/helpers";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId) {
    return NextResponse.json({ detail: "user_id is required" }, { status: 400 });
  }

  const db = getDb();
  const user = getOrCreateUser(userId);

  const totalMemories = db
    .select({ count: count() })
    .from(memories)
    .where(and(eq(memories.userId, user.id), ne(memories.state, "deleted" as MemoryState)))
    .get();

  const userApps = db
    .select()
    .from(apps)
    .where(eq(apps.ownerId, user.id))
    .all();

  return NextResponse.json({
    total_memories: totalMemories?.count || 0,
    total_apps: userApps.length,
    apps: userApps,
  });
}
