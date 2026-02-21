/**
 * POST /api/mcp/:clientName/sse/:userId/messages — receive MCP messages
 *
 * Port of openmemory/api/app/mcp_server.py (POST /mcp/messages/)
 *
 * The MCP client POSTs JSON-RPC messages here; they are forwarded to the
 * active NextSSETransport for the session, which invokes the MCP server's
 * onmessage callback to process them.
 */
import { NextRequest, NextResponse } from "next/server";
import { activeTransports } from "@/lib/mcp/registry";

type RouteParams = { params: Promise<{ clientName: string; userId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const transport = activeTransports.get(sessionId);
  if (!transport) {
    return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
  }

  try {
    const body = await request.json();
    transport.handlePostMessage(body);
    return new NextResponse(null, { status: 202 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
