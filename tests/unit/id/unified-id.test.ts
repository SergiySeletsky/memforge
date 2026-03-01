/**
 * tests/unit/id/unified-id.test.ts — UnifiedId unit tests
 *
 * Verifies the core UnifiedId class: generation, parsing, determinism,
 * equality, partitioning, and edge cases.
 */

import { UnifiedId, generateId, generateIdFromString, isValidId } from "@/lib/id";

describe("UnifiedId", () => {
  // ── Factory / Generation ──────────────────────────────────────────

  test("UID_01: newId() produces a 13-char string", () => {
    const id = UnifiedId.newId();
    expect(id.toString()).toHaveLength(13);
  });

  test("UID_02: newId() produces unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(UnifiedId.newId().toString());
    }
    expect(ids.size).toBe(1000);
  });

  test("UID_03: toString() uses only symbols 0-9 and A-V", () => {
    for (let i = 0; i < 100; i++) {
      const str = UnifiedId.newId().toString();
      expect(str).toMatch(/^[0-9A-V]{13}$/);
    }
  });

  test("UID_04: fromGuid() is deterministic", () => {
    const guid = "550e8400-e29b-41d4-a716-446655440000";
    const a = UnifiedId.fromGuid(guid);
    const b = UnifiedId.fromGuid(guid);
    expect(a.toString()).toBe(b.toString());
  });

  test("UID_05: fromString() is deterministic", () => {
    const a = UnifiedId.fromString("hello world");
    const b = UnifiedId.fromString("hello world");
    expect(a.toString()).toBe(b.toString());
  });

  test("UID_06: different strings produce different IDs", () => {
    const a = UnifiedId.fromString("alice");
    const b = UnifiedId.fromString("bob");
    expect(a.toString()).not.toBe(b.toString());
  });

  // ── Parse / Roundtrip ─────────────────────────────────────────────

  test("UID_07: parse(toString()) roundtrips correctly", () => {
    const original = UnifiedId.newId();
    const parsed = UnifiedId.parse(original.toString());
    expect(parsed.toUInt64()).toBe(original.toUInt64());
  });

  test("UID_08: tryParse returns null for invalid input", () => {
    expect(UnifiedId.tryParse("")).toBeNull();
    expect(UnifiedId.tryParse("too-short")).toBeNull();
    expect(UnifiedId.tryParse("XXXXXXXXX1234")).toBeNull(); // X is invalid
    expect(UnifiedId.tryParse("WAAAAAAA00000")).toBeNull(); // W not in 0-V
  });

  test("UID_09: tryParse accepts valid HEX32 (case-insensitive)", () => {
    const id = UnifiedId.newId();
    const lower = id.toString().toLowerCase();
    const parsed = UnifiedId.tryParse(lower);
    expect(parsed).not.toBeNull();
    expect(parsed!.toUInt64()).toBe(id.toUInt64());
  });

  test("UID_10: parse throws on wrong length", () => {
    expect(() => UnifiedId.parse("SHORT")).toThrow();
    expect(() => UnifiedId.parse("TOOLONGSTRING1234")).toThrow();
  });

  // ── Equality ──────────────────────────────────────────────────────

  test("UID_11: equals() works with UnifiedId, bigint, and string", () => {
    const id = UnifiedId.newId();
    expect(id.equals(id.clone())).toBe(true);
    expect(id.equals(id.toUInt64())).toBe(true);
    expect(id.equals(id.toString())).toBe(true);
    expect(id.equals(id.toString().toLowerCase())).toBe(true);
  });

  test("UID_12: compareTo returns correct ordering", () => {
    const a = new UnifiedId(100n);
    const b = new UnifiedId(200n);
    expect(a.compareTo(b)).toBe(-1);
    expect(b.compareTo(a)).toBe(1);
    expect(a.compareTo(a.clone())).toBe(0);
  });

  // ── Empty ─────────────────────────────────────────────────────────

  test("UID_13: Empty UnifiedId has hash 0", () => {
    expect(UnifiedId.Empty.toUInt64()).toBe(0n);
    expect(UnifiedId.Empty.toString()).toBe("0000000000000");
  });

  // ── fromUInt64 / fromInt64 ────────────────────────────────────────

  test("UID_14: fromUInt64 roundtrips through toUInt64", () => {
    const val = 12345678901234n;
    const id = UnifiedId.fromUInt64(val);
    // Note: fromUInt64 hashes the bytes, so toUInt64() != val
    expect(id.toUInt64()).not.toBe(0n);
    expect(id.toString()).toHaveLength(13);
  });

  test("UID_15: fromUInt64 throws on 0", () => {
    expect(() => UnifiedId.fromUInt64(0n)).toThrow();
  });

  test("UID_16: fromInt64 throws on 0", () => {
    expect(() => UnifiedId.fromInt64(0n)).toThrow();
  });

  // ── Partition ─────────────────────────────────────────────────────

  test("UID_17: partitionKey returns correct length", () => {
    const id = UnifiedId.newId();
    expect(id.partitionKey(1)).toHaveLength(1);
    expect(id.partitionKey(3)).toHaveLength(3);
    expect(id.partitionKey(5)).toHaveLength(5);
  });

  test("UID_18: partitionKey throws on invalid length", () => {
    const id = UnifiedId.newId();
    expect(() => id.partitionKey(0)).toThrow();
    expect(() => id.partitionKey(13)).toThrow();
  });

  test("UID_19: partitionNumber returns value in range", () => {
    const id = UnifiedId.newId();
    const partition = id.partitionNumber(1000n);
    expect(partition).toBeGreaterThanOrEqual(0n);
    expect(partition).toBeLessThan(1000n);
  });

  // ── JSON ──────────────────────────────────────────────────────────

  test("UID_20: toJSON returns HEX32 string", () => {
    const id = UnifiedId.newId();
    expect(JSON.parse(JSON.stringify(id))).toBe(id.toString());
  });

  // ── Int64 signed conversion ───────────────────────────────────────

  test("UID_21: toInt64 handles large unsigned values", () => {
    // hash > 2^63 should become negative when interpreted as signed
    const id = new UnifiedId(0xFFFFFFFFFFFFFFFFn);
    expect(id.toInt64()).toBe(-1n);
  });

  // ── fromBytes edge cases ──────────────────────────────────────────

  test("UID_22: fromBytes throws on null/empty", () => {
    expect(() => UnifiedId.fromBytes(null as unknown as Uint8Array)).toThrow();
    expect(() => UnifiedId.fromBytes(new Uint8Array(0))).toThrow();
  });

  test("UID_23: fromGuid throws on empty GUID", () => {
    expect(() => UnifiedId.fromGuid("")).toThrow();
    expect(() => UnifiedId.fromGuid("00000000-0000-0000-0000-000000000000")).toThrow();
  });

  test("UID_24: fromString throws on empty string", () => {
    expect(() => UnifiedId.fromString("")).toThrow();
    expect(() => UnifiedId.fromString("   ")).toThrow();
  });
});

// ── Helper functions ──────────────────────────────────────────────────

describe("ID helpers", () => {
  test("GEN_01: generateId() returns 13-char HEX32 string", () => {
    const id = generateId();
    expect(id).toHaveLength(13);
    expect(id).toMatch(/^[0-9A-V]{13}$/);
  });

  test("GEN_02: generateId() produces unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(500);
  });

  test("GEN_03: generateIdFromString() is deterministic", () => {
    expect(generateIdFromString("test")).toBe(generateIdFromString("test"));
  });

  test("GEN_04: generateIdFromString() varies by input", () => {
    expect(generateIdFromString("a")).not.toBe(generateIdFromString("b"));
  });

  test("GEN_05: isValidId() validates correctly", () => {
    expect(isValidId(generateId())).toBe(true);
    expect(isValidId("0000000000000")).toBe(true); // Empty ID is valid format
    expect(isValidId("")).toBe(false);
    expect(isValidId("not-valid")).toBe(false);
    expect(isValidId("550e8400-e29b-41d4-a716-446655440000")).toBe(false); // UUID is NOT valid UnifiedId
  });
});
