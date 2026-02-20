/**
 * Custom MCP Transport for Next.js App Router SSE endpoints.
 *
 * The official SSEServerTransport requires Node.js IncomingMessage/ServerResponse
 * which aren't available in Next.js App Router route handlers.
 *
 * This implements the Transport interface from @modelcontextprotocol/sdk,
 * bridging SSE streaming (server→client) and POST messages (client→server).
 */
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";

/**
 * A Transport implementation that sends JSON-RPC messages as SSE events
 * via a ReadableStreamDefaultController, and receives messages from an
 * in-memory queue (fed by the POST endpoint).
 */
export class NextSSETransport implements Transport {
  readonly sessionId: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private _controller: ReadableStreamDefaultController<Uint8Array>;
  private _encoder = new TextEncoder();
  private _messageQueue: JSONRPCMessage[] = [];
  private _closed = false;

  constructor(
    controller: ReadableStreamDefaultController<Uint8Array>,
    private _messagesEndpoint: string,
  ) {
    this.sessionId = uuidv4();
    this._controller = controller;
  }

  /**
   * Send the initial SSE endpoint event so the MCP client knows where to POST.
   */
  async start(): Promise<void> {
    this._sendSSE(
      "endpoint",
      `${this._messagesEndpoint}?sessionId=${this.sessionId}`,
    );
  }

  /**
   * Send a JSON-RPC message from the server to the client via SSE.
   */
  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this._closed) return;
    this._sendSSE("message", JSON.stringify(message));
  }

  /**
   * Close the SSE stream.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try {
      this._controller.close();
    } catch {
      // Already closed
    }
    this.onclose?.();
  }

  /**
   * Called by the POST endpoint when a JSON-RPC message arrives from the client.
   * Invokes the onmessage callback set by the MCP Server during connect().
   */
  handlePostMessage(message: JSONRPCMessage): void {
    if (this._closed) return;
    if (this.onmessage) {
      this.onmessage(message);
    } else {
      // Buffer until onmessage is set (shouldn't normally happen after connect)
      this._messageQueue.push(message);
    }
  }

  /**
   * Flush any buffered messages (called after onmessage is set).
   */
  flushQueue(): void {
    while (this._messageQueue.length > 0 && this.onmessage) {
      this.onmessage(this._messageQueue.shift()!);
    }
  }

  /**
   * Send a keep-alive comment to prevent connection timeout.
   */
  sendKeepAlive(): void {
    if (this._closed) return;
    try {
      this._controller.enqueue(this._encoder.encode(`: keepalive\n\n`));
    } catch {
      // Stream closed
    }
  }

  get isClosed(): boolean {
    return this._closed;
  }

  // --- Private helpers ---

  private _sendSSE(event: string, data: string): void {
    if (this._closed) return;
    try {
      this._controller.enqueue(
        this._encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
      );
    } catch {
      // Stream closed
    }
  }
}
