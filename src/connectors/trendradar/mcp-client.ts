/**
 * Minimal Streamable-HTTP MCP client for TrendRadar.
 *
 * TrendRadar ships an official MCP image that exposes hotlist/RSS results over
 * JSON-RPC 2.0 on an SSE (`text/event-stream`) endpoint. We implement only the
 * handshake and `tools/call` flow this project needs rather than pulling the
 * full SDK, so the transport stays explicit and testable with a plain `fetch`.
 */

export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolResult {
  content?: McpContentBlock[];
}

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/**
 * Parse an MCP transport response body into a JSON-RPC message.
 * Supports both raw JSON and `text/event-stream` (SSE) payloads.
 *
 * Note: real TrendRadar MCP uses CRLF (`\r\n`) line endings and separates
 * events with `\r\n\r\n`. We normalize to LF and trim each line so the
 * `event: message` marker and `data:` payload are matched regardless of
 * transport quirks — a strict LF-only comparison previously failed on the
 * trailing `\r` and surfaced as MCP_SSE_NO_MESSAGE_EVENT.
 */
export function parseMcpResponse<T = unknown>(raw: string, contentType: string): T {
  if (contentType.includes("text/event-stream")) {
    const normalized = raw.replace(/\r\n/g, "\n");
    for (const block of normalized.split("\n\n")) {
      const lines = block.split("\n");
      if (!lines.some((line) => line.trim() === "event: message")) continue;
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) return JSON.parse(data) as T;
    }
    throw new Error("MCP_SSE_NO_MESSAGE_EVENT");
  }
  return JSON.parse(raw) as T;
}

/**
 * Extract structured JSON from the text content block of an MCP tool result.
 */
export function parseToolPayload<T>(result: McpToolResult): T {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error("MCP_TOOL_NO_TEXT_CONTENT");
  return JSON.parse(text) as T;
}

export class TrendRadarMcpClient {
  private sessionId?: string;
  private initialized = false;
  private requestId = 1;

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const initResponse = await this.fetcher(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.requestId++,
        method: "initialize",
        params: {
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "signaldeck", version: "0.1.0" },
        } satisfies McpInitializeParams,
      }),
    });
    if (!initResponse.ok) throw new Error(`MCP_INIT_FAILED_${initResponse.status}`);

    const sessionId = initResponse.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    parseMcpResponse(await initResponse.text(), initResponse.headers.get("content-type") ?? "text/event-stream");

    // Acknowledge the initialized notification; the server may respond 202.
    await this.fetcher(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    this.initialized = true;
  }

  /** Call an MCP tool and return the parsed JSON payload from its text content. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ensureInitialized();

    const response = await this.fetcher(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.requestId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (!response.ok) throw new Error(`MCP_TOOL_FAILED_${response.status}`);

    const message = parseMcpResponse<{
      result?: McpToolResult;
      error?: { code: number; message: string };
    }>(await response.text(), response.headers.get("content-type") ?? "text/event-stream");
    if (message.error) {
      throw new Error(`MCP_TOOL_ERROR_${message.error.code}: ${message.error.message}`);
    }
    return parseToolPayload<T>(message.result ?? { content: [] });
  }
}
