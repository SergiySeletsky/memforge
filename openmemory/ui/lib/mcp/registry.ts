/**
 * Global MCP transport registry.
 *
 * Stores active SSE transports on `globalThis` so the map survives Next.js
 * hot-module-reloads and is visible to both the SSE route and the messages
 * route even when they are compiled into separate module instances.
 */
import type { NextSSETransport } from "./transport";

declare global {
  // eslint-disable-next-line no-var
  var __mcpTransports: Map<string, NextSSETransport> | undefined;
}

if (!globalThis.__mcpTransports) {
  globalThis.__mcpTransports = new Map<string, NextSSETransport>();
}

export const activeTransports: Map<string, NextSSETransport> =
  globalThis.__mcpTransports;
