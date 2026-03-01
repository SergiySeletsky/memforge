/**
 * lib/id/index.ts — ID generation utilities
 *
 * Central module for all identifier generation in MemForge.
 * Uses UnifiedId (13-char HEX32 strings) instead of UUIDs (36 chars).
 *
 * Token savings: ~64% fewer tokens per ID in LLM context windows.
 * Example: "550e8400-e29b-41d4-a716-446655440000" (36 chars)
 *       -> "8HDUDEHIKLB09" (13 chars)
 *
 * IDs are case-insensitive, use symbols 0-9 and A-V.
 */

import { UnifiedId } from "./unified-id";

/**
 * Generate a new 13-character UnifiedId string.
 * Drop-in replacement for `randomUUID()` / `uuidv4()` across the codebase.
 *
 * @returns A 13-char uppercase HEX32 string (e.g. "8HDUDEHIKLB09")
 */
export function generateId(): string {
  return UnifiedId.newId().toString();
}

/**
 * Generate a UnifiedId from a deterministic string input.
 * Same input always produces the same ID (FNV-1a hash).
 *
 * Useful for idempotent operations where the same content
 * should always map to the same identifier.
 */
export function generateIdFromString(text: string): string {
  return UnifiedId.fromString(text).toString();
}

/**
 * Validate whether a string is a valid UnifiedId (13-char HEX32).
 */
export function isValidId(id: string): boolean {
  return UnifiedId.tryParse(id) !== null;
}

export { UnifiedId };
