/**
 * POST /api/mcp/messages — generic MCP messages endpoint
 *
 * Port of openmemory/api/app/mcp_server.py: @mcp_router.post("/messages/")
 *
 * Some MCP clients use this generic path instead of the parameterized
 * /:clientName/sse/:userId/messages path, but still pass sessionId as
 * a query parameter.
 */
import { NextRequest, NextResponse } from "next/server";
import { activeTransports } from "../[clientName]/sse/[userId]/route";

export async function POST(request: NextRequest) {
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
