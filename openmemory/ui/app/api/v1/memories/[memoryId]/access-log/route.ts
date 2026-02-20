/**
 * GET /api/v1/memories/:memoryId/access-log — access log for a memory
 *
 * Port of openmemory/api/app/routers/memories.py (GET /{memory_id}/access-log)
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { memoryAccessLogs, memories, apps } from "@/lib/db/schema";
import { eq, desc, count as sqlCount } from "drizzle-orm";

type RouteParams = { params: Promise<{ memoryId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { memoryId } = await params;
  const sp = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("page_size") || "10", 10)));

  const db = getDb();

  const mem = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  if (!mem) {
    return NextResponse.json({ detail: "Memory not found" }, { status: 404 });
  }

  // Total count
  const totalRow = db
    .select({ count: sqlCount() })
    .from(memoryAccessLogs)
    .where(eq(memoryAccessLogs.memoryId, memoryId))
    .get();
  const total = totalRow?.count || 0;

  // Paginated logs
  const logs = db
    .select()
    .from(memoryAccessLogs)
    .where(eq(memoryAccessLogs.memoryId, memoryId))
    .orderBy(desc(memoryAccessLogs.accessedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  const items = logs.map((log) => {
    const app = db.select().from(apps).where(eq(apps.id, log.appId)).get();
    return {
      id: log.id,
      memory_id: log.memoryId,
      app_id: log.appId,
      app_name: app?.name || null,
      accessed_at: log.accessedAt,
      access_type: log.accessType,
    };
  });

  return NextResponse.json({
    total,
    page,
    page_size: pageSize,
    logs: items,
  });
}
