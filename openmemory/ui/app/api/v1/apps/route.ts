/**
 * GET /api/v1/apps — list all apps with memory/access counts
 *
 * Port of openmemory/api/app/routers/apps.py (GET /)
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apps, memories, memoryAccessLogs, type MemoryState } from "@/lib/db/schema";
import { eq, and, inArray, like, count, countDistinct, desc, asc, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const name = sp.get("name");
  const isActive = sp.get("is_active");
  const sortBy = sp.get("sort_by") || "name";
  const sortDirection = sp.get("sort_direction") || "asc";
  const page = Math.max(1, Number(sp.get("page") || "1"));
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("page_size") || "10")));

  const db = getDb();

  // Get all apps with conditions
  const conditions: any[] = [];
  if (name) {
    conditions.push(like(apps.name, `%${name}%`));
  }
  if (isActive !== null && isActive !== undefined) {
    conditions.push(eq(apps.isActive, isActive === "true"));
  }

  const allApps = db
    .select()
    .from(apps)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all();

  // For each app, compute memory count and access count
  const activeStates: MemoryState[] = ["active", "paused", "archived"];
  const items = allApps.map((app) => {
    const memCount = db
      .select({ count: count() })
      .from(memories)
      .where(and(eq(memories.appId, app.id), inArray(memories.state, activeStates)))
      .get();

    const accessCount = db
      .select({ count: countDistinct(memoryAccessLogs.memoryId) })
      .from(memoryAccessLogs)
      .where(eq(memoryAccessLogs.appId, app.id))
      .get();

    return {
      id: app.id,
      name: app.name,
      is_active: app.isActive,
      total_memories_created: memCount?.count || 0,
      total_memories_accessed: accessCount?.count || 0,
    };
  });

  // Sort
  items.sort((a, b) => {
    let cmp = 0;
    if (sortBy === "name") cmp = a.name.localeCompare(b.name);
    else if (sortBy === "memories") cmp = a.total_memories_created - b.total_memories_created;
    else if (sortBy === "memories_accessed") cmp = a.total_memories_accessed - b.total_memories_accessed;
    return sortDirection === "desc" ? -cmp : cmp;
  });

  const total = items.length;
  const paged = items.slice((page - 1) * pageSize, page * pageSize);

  return NextResponse.json({
    total,
    page,
    page_size: pageSize,
    apps: paged,
  });
}
