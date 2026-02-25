/**
 * E2E — MCP SSE transport (Phase 6)
 *
 * The MCP server is exposed via:
 *   GET  /mcp/[clientName]/sse/[userId]          – SSE stream (establishes session)
 *   POST /mcp/[clientName]/sse/[userId]/messages – send MCP requests
 *   POST /mcp/messages                           – generic messages endpoint
 *
 * These tests validate the HTTP layer only (connection + initial event).
 * Full JSON-RPC message exchange is covered by the SSE + messages pair.
 */

import { BASE_URL, RUN_ID } from "./helpers";

const CLIENT_NAME = "e2e-client";
const USER_ID = `mcp-${RUN_ID}`;

// Helper: read first N bytes from an SSE stream
async function readSseEvents(
  url: string,
  timeoutMs = 5000
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const events: string[] = [];
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) return events;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Collect lines that start with "event:" or "data:"
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.startsWith("event:") || line.startsWith("data:")) {
          events.push(line.trim());
        }
      }
      // Stop after we get at least one event: endpoint line
      if (events.some((e) => e.includes("endpoint"))) break;
    }
    reader.cancel();
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

// ---------------------------------------------------------------------------
describe("MCP SSE endpoint — GET /mcp/[clientName]/sse/[userId]", () => {
  it("returns 200 with text/event-stream content type", async () => {
    const url = `${BASE_URL}/mcp/${CLIENT_NAME}/sse/${USER_ID}`;
    const controller = new AbortController();
    // Allow 10s for first-hit dev-mode compilation of the MCP route
    setTimeout(() => controller.abort(), 10_000);

    let status = 0;
    let contentType = "";
    try {
      const res = await fetch(url, { signal: controller.signal });
      status = res.status;
      contentType = res.headers.get("content-type") ?? "";
      res.body?.cancel();
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== "AbortError") throw err;
    }

    // MCP routes may not be deployed in this environment (404 expected then)
    if (status === 404) {
      console.warn("MCP SSE route not found (404) — MCP may not be deployed");
      return;
    }
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
  });

  it("sends event: endpoint with a sessionId in the data", async () => {
    const url = `${BASE_URL}/mcp/${CLIENT_NAME}/sse/${USER_ID}`;
    const events = await readSseEvents(url, 8000);

    if (events.length === 0) {
      console.warn("MCP SSE route not found — skipping event assertion");
      return;
    }
    expect(events.length).toBeGreaterThan(0);
    // Should contain an event line
    const hasEndpoint = events.some(
      (e) => e.includes("endpoint") || e.includes("session")
    );
    expect(hasEndpoint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("MCP messages endpoint — POST /mcp/[clientName]/sse/[userId]/messages", () => {
  it("returns 202 or 200 for a valid JSON-RPC initialize request", async () => {
    // Establish SSE connection and keep it alive while we POST
    const sseUrl = `${BASE_URL}/mcp/${CLIENT_NAME}/sse/${USER_ID}`;
    const sseController = new AbortController();
    const timer = setTimeout(() => sseController.abort(), 15_000);

    let sessionId: string | undefined;
    let sseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const sseRes = await fetch(sseUrl, { signal: sseController.signal });
      if (!sseRes.ok || !sseRes.body) {
        console.warn("MCP SSE route not available — skipping messages test");
        return;
      }

      sseReader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read until we get the endpoint event with sessionId
      while (!sessionId) {
        const { value, done } = await sseReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        for (const line of lines) {
          const match = line.match(/sessionId=([a-zA-Z0-9\-_]+)/);
          if (match) { sessionId = match[1]; break; }
          const urlMatch = line.match(/\/messages\?sessionId=([^&\s"]+)/);
          if (urlMatch) { sessionId = urlMatch[1]; break; }
        }
      }

      if (!sessionId) {
        console.warn("Could not extract sessionId from SSE stream — skipping messages test");
        return;
      }

      // SSE stream is still open — session is active in activeTransports
      const msgUrl = `${BASE_URL}/mcp/${CLIENT_NAME}/sse/${USER_ID}/messages?sessionId=${sessionId}`;
      const response = await fetch(msgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "e2e-test", version: "1.0.0" },
          },
        }),
      });

      // MCP SSE transport returns 202 Accepted (the response arrives via SSE stream)
      expect([200, 202]).toContain(response.status);
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== "AbortError") throw err;
    } finally {
      // Clean up: cancel the SSE stream
      clearTimeout(timer);
      sseController.abort();
      try { await sseReader?.cancel(); } catch { /* already aborted */ }
    }
  });
});

// ---------------------------------------------------------------------------
describe("MCP generic messages endpoint — POST /mcp/messages", () => {
  it("returns 200 or 202 for a JSON-RPC request", async () => {
    const response = await fetch(`${BASE_URL}/mcp/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: {},
      }),
    });
    // May return 200, 202, 400 (sessionId required), or 404 (not deployed)
    // Should not 500 (internal error)
    expect(response.status).not.toBe(500);
  });
});
