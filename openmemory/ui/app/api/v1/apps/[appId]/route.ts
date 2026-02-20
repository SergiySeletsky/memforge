/**
 * GET /api/v1/apps/:appId — app details + stats
 * PUT /api/v1/apps/:appId — toggle app active/inactive
 *
 * Port of openmemory/api/app/routers/apps.py (GET /{app_id}, PUT /{app_id})
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apps, memories, memoryAccessLogs, type MemoryState } from "@/lib/db/schema";
import { eq, and, inArray, count, min, max } from "drizzle-orm";

type RouteParams = { params: Promise<{ appId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { appId } = await params;
  const db = getDb();

  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) {
    return NextResponse.json({ detail: "App not found" }, { status: 404 });
  }

  const activeStates: MemoryState[] = ["active", "paused", "archived"];
  const memCount = db
    .select({ count: count() })
    .from(memories)
    .where(and(eq(memories.appId, appId), inArray(memories.state, activeStates)))
    .get();

  const accessStats = db
    .select({
      total: count(),
      first: min(memoryAccessLogs.accessedAt),
      last: max(memoryAccessLogs.accessedAt),
    })
    .from(memoryAccessLogs)
    .where(eq(memoryAccessLogs.appId, appId))
    .get();

  return NextResponse.json({
    is_active: app.isActive,
    total_memories_created: memCount?.count || 0,
    total_memories_accessed: accessStats?.total || 0,
    first_accessed: accessStats?.first || null,
    last_accessed: accessStats?.last || null,
  });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { appId } = await params;
  const db = getDb();

  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) {
    return NextResponse.json({ detail: "App not found" }, { status: 404 });
  }

  const sp = request.nextUrl.searchParams;
  const isActive = sp.get("is_active");
  if (isActive === null) {
    return NextResponse.json({ detail: "is_active is required" }, { status: 400 });
  }

  db.update(apps)
    .set({ isActive: isActive === "true" })
    .where(eq(apps.id, appId))
    .run();

  return NextResponse.json({ status: "success", message: "Updated app details successfully" });
}
