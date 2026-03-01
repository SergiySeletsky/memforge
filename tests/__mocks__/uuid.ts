// Manual mock for uuid (uuid@13 is ESM-only; this provides a CJS-compatible shim)
import { randomUUID } from "crypto";

export const v4 = (): string => randomUUID();
export const v1 = (): string => randomUUID();
export const v3 = (): string => randomUUID();
export const v5 = (): string => randomUUID();
export const validate = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
  /^[0-9A-V]{13}$/i.test(s);
export const version = (_: string): number => 4;
