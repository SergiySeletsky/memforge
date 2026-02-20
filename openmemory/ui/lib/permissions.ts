/**
 * Permission checking — port of openmemory/api/app/utils/permissions.py
 */
import { getDb } from "@/lib/db";
import { apps, accessControls, memories } from "@/lib/db/schema";
import type { MemoryState } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * Get the set of memory IDs accessible by an app based on ACL rules.
 * Returns null if ALL memories are accessible (no restrictions).
 * Returns empty Set if none are accessible.
 */
export function getAccessibleMemoryIds(appId: string): Set<string> | null {
  const db = getDb();

  const rules = db
    .select()
    .from(accessControls)
    .where(
      and(
        eq(accessControls.subjectType, "app"),
        eq(accessControls.subjectId, appId),
        eq(accessControls.objectType, "memory")
      )
    )
    .all();

  if (rules.length === 0) return null; // No rules = all accessible

  const allowed = new Set<string>();
  const denied = new Set<string>();

  for (const rule of rules) {
    if (rule.effect === "allow") {
      if (rule.objectId) {
        allowed.add(rule.objectId);
      } else {
        return null; // Global allow = all accessible
      }
    } else if (rule.effect === "deny") {
      if (rule.objectId) {
        denied.add(rule.objectId);
      } else {
        return new Set(); // Global deny = none accessible
      }
    }
  }

  // Remove denied from allowed
  for (const id of denied) {
    allowed.delete(id);
  }

  return allowed;
}

/**
 * Check if a specific memory is accessible by an app.
 */
export function checkMemoryAccessPermissions(
  memoryState: MemoryState,
  memoryId: string,
  appId?: string | null
): boolean {
  // Must be active
  if (memoryState !== "active") return false;

  // No app = only check state
  if (!appId) return true;

  const db = getDb();

  // Check app exists and is active
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) return false;
  if (!app.isActive) return false;

  // Check ACL
  const accessible = getAccessibleMemoryIds(appId);
  if (accessible === null) return true; // No restrictions
  return accessible.has(memoryId);
}
