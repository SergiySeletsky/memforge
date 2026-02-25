/**
 * GET /mcp/:clientName/sse/:userId — SSE endpoint for MCP connections
 *
 * Port of openmemory/api/app/mcp_server.py (GET /mcp/{client_name}/sse/{user_id})
 *
 * Establishes an SSE connection and serves the MCP protocol using a custom
 * NextSSETransport that bridges Next.js App Router streaming with the MCP SDK.
 */
import { NextRequest } from "next/server";
import { createMcpServer } from "@/lib/mcp/server";
import { NextSSETransport } from "@/lib/mcp/transport";
import { activeTransports } from "@/lib/mcp/registry";
export { activeTransports };

type RouteParams = { params: Promise<{ clientName: string; userId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { clientName, userId } = await params;

  // Build the messages endpoint URL relative to this SSE endpoint
  const messagesUrl = `/mcp/${clientName}/sse/${userId}/messages`;

  let transportRef: NextSSETransport | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Create transport connected to this SSE stream
      const transport = new NextSSETransport(controller, messagesUrl);
      transportRef = transport;

      // Register transport so the POST endpoint can route messages to it
      activeTransports.set(transport.sessionId, transport);

      // Create MCP server with user context
      const mcpServer = createMcpServer(userId, clientName);

      // Keep connection alive with periodic comments
      keepAliveTimer = setInterval(() => {
        transport.sendKeepAlive();
      }, 30_000);

      try {
        // Connect the MCP server to our transport.
        // This sets transport.onmessage and calls transport.start() internally.
        await mcpServer.connect(transport);

        // Flush any messages that arrived before onmessage was set
        transport.flushQueue();
      } catch (e) {
        console.error("MCP server connection error:", e);
        transport.onerror?.(e instanceof Error ? e : new Error(String(e)));
      }
    },
    cancel() {
      // Client disconnected — clean up
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (transportRef) {
        activeTransports.delete(transportRef.sessionId);
        transportRef.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
