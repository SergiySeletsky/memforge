/**
 * POST /api/v1/backup/export — export memories as a zip
 *
 * Port of openmemory/api/app/routers/backup.py (POST /export)
 *
 * Produces a zip file containing:
 *   - memories.json  — full relational export (user, apps, memories, categories, access_controls, etc.)
 *   - memories.jsonl.gz — provider-agnostic per-memory gzip JSONL for re-embedding
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  users,
  apps,
  memories,
  categories,
  memoryCategories,
  memoryStatusHistory,
  accessControls,
} from "@/lib/db/schema";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import JSZip from "jszip";
import { gzipSync } from "zlib";

function isoDate(dt: string | null | undefined): string | null {
  if (!dt) return null;
  try {
    return new Date(dt).toISOString();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { user_id, app_id, from_date, to_date } = body;

  if (!user_id) {
    return NextResponse.json({ detail: "user_id is required" }, { status: 400 });
  }

  const db = getDb();
  const user = db.select().from(users).where(eq(users.userId, user_id)).get();
  if (!user) {
    return NextResponse.json({ detail: "User not found" }, { status: 404 });
  }

  // Build memory query conditions
  const conditions: any[] = [eq(memories.userId, user.id)];
  if (app_id) conditions.push(eq(memories.appId, app_id));
  if (from_date) conditions.push(gte(memories.createdAt, new Date(from_date * 1000).toISOString()));
  if (to_date) conditions.push(lte(memories.createdAt, new Date(to_date * 1000).toISOString()));

  const allMemories = db
    .select()
    .from(memories)
    .where(and(...conditions))
    .all();

  const memoryIds = allMemories.map((m) => m.id);
  const appIds = [...new Set(allMemories.map((m) => m.appId).filter(Boolean))] as string[];

  const allApps = appIds.length > 0
    ? db.select().from(apps).where(inArray(apps.id, appIds)).all()
    : [];

  // Get categories for memories
  const mcRows = memoryIds.length > 0
    ? db.select().from(memoryCategories).where(inArray(memoryCategories.memoryId, memoryIds)).all()
    : [];
  const catIds = [...new Set(mcRows.map((r) => r.categoryId))];
  const allCategories = catIds.length > 0
    ? db.select().from(categories).where(inArray(categories.id, catIds)).all()
    : [];

  // Get status history
  const history = memoryIds.length > 0
    ? db.select().from(memoryStatusHistory).where(inArray(memoryStatusHistory.memoryId, memoryIds)).all()
    : [];

  // Get access controls for apps
  const acls = appIds.length > 0
    ? db
        .select()
        .from(accessControls)
        .where(
          and(
            eq(accessControls.subjectType, "app"),
            inArray(accessControls.subjectId, appIds),
          )
        )
        .all()
    : [];

  // Build export payload (memories.json)
  const payload = {
    user: {
      id: user.id,
      user_id: user.userId,
      name: user.name,
      email: user.email,
      metadata: user.metadata,
      created_at: isoDate(user.createdAt),
      updated_at: isoDate(user.updatedAt),
    },
    apps: allApps.map((a) => ({
      id: a.id,
      owner_id: a.ownerId,
      name: a.name,
      description: a.description,
      metadata: a.metadata,
      is_active: a.isActive,
      created_at: isoDate(a.createdAt),
      updated_at: isoDate(a.updatedAt),
    })),
    categories: allCategories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      created_at: isoDate(c.createdAt),
      updated_at: isoDate(c.updatedAt),
    })),
    memories: allMemories.map((m) => {
      const memCats = mcRows.filter((r) => r.memoryId === m.id).map((r) => r.categoryId);
      return {
        id: m.id,
        user_id: m.userId,
        app_id: m.appId,
        content: m.content,
        metadata: m.metadata,
        state: m.state || "active",
        created_at: isoDate(m.createdAt),
        updated_at: isoDate(m.updatedAt),
        archived_at: isoDate(m.archivedAt),
        deleted_at: isoDate(m.deletedAt),
        category_ids: memCats,
      };
    }),
    memory_categories: mcRows.map((r) => ({
      memory_id: r.memoryId,
      category_id: r.categoryId,
    })),
    status_history: history.map((h) => ({
      id: h.id,
      memory_id: h.memoryId,
      changed_by: h.changedBy,
      old_state: h.oldState,
      new_state: h.newState,
      changed_at: isoDate(h.changedAt),
    })),
    access_controls: acls.map((ac) => ({
      id: ac.id,
      subject_type: ac.subjectType,
      subject_id: ac.subjectId,
      object_type: ac.objectType,
      object_id: ac.objectId,
      effect: ac.effect,
      created_at: isoDate(ac.createdAt),
    })),
    export_meta: {
      app_id_filter: app_id || null,
      from_date: from_date || null,
      to_date: to_date || null,
      version: "1",
      generated_at: new Date().toISOString(),
    },
  };

  // Build JSONL for logical memories (provider-agnostic, for re-embedding)
  const jsonlLines = allMemories.map((m) => {
    const app = allApps.find((a) => a.id === m.appId);
    const memCats = mcRows.filter((r) => r.memoryId === m.id);
    const catNames = memCats
      .map((mc) => allCategories.find((c) => c.id === mc.categoryId)?.name)
      .filter(Boolean);
    return JSON.stringify({
      id: m.id,
      content: m.content,
      metadata: m.metadata || {},
      created_at: isoDate(m.createdAt),
      updated_at: isoDate(m.updatedAt),
      state: m.state || "active",
      app: app?.name || null,
      categories: catNames,
    });
  });
  const jsonlContent = jsonlLines.join("\n") + (jsonlLines.length > 0 ? "\n" : "");
  const memoriesGz = gzipSync(Buffer.from(jsonlContent, "utf-8"));

  // Create zip file
  const zip = new JSZip();
  zip.file("memories.json", JSON.stringify(payload, null, 2));
  zip.file("memories.jsonl.gz", memoriesGz);

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return new Response(zipBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="memories_export_${user_id}.zip"`,
    },
  });
}
