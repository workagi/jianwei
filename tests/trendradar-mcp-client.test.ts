import { describe, expect, it, vi } from "vitest";
import { parseMcpResponse, parseToolPayload, TrendRadarMcpClient } from "@/connectors/trendradar/mcp-client";

describe("TrendRadarMcpClient", () => {
  it("parses SSE JSON-RPC responses", () => {
    const parsed = parseMcpResponse<{ result: { ok: boolean } }>('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n', "text/event-stream");
    expect(parsed.result).toEqual({ ok: true });
  });

  // Regression: the real TrendRadar MCP emits CRLF line endings and separates
  // events with \r\n\r\n. A strict LF-only split previously failed to match
  // `event: message` (the trailing \r) and surfaced MCP_SSE_NO_MESSAGE_EVENT,
  // blocking all hotlist ingestion.
  it("parses CRLF-delimited SSE responses (real TrendRadar MCP)", () => {
    const crlf = 'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n\r\n';
    const parsed = parseMcpResponse<{ result: { ok: boolean } }>(crlf, "text/event-stream");
    expect(parsed.result).toEqual({ ok: true });
  });

  it("throws MCP_TOOL_ERROR when the tool call returns an error", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\r\n\r\n', {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "s" },
      }))
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(new Response('event: message\r\ndata: {"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Invalid request parameters"}}\r\n\r\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
    const client = new TrendRadarMcpClient("http://x/mcp", fetcher);
    await expect(client.callTool("get_latest_news")).rejects.toThrow(/MCP_TOOL_ERROR_-32602/);
  });

  it("parses JSON embedded in MCP text content", () => {
    expect(parseToolPayload<{ success: boolean }>({ content: [{ type: "text", text: '{"success":true}' }] })).toEqual({ success: true });
  });

  it("initializes once and calls a tool", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
      }))
      .mockResolvedValueOnce(new Response("", { status: 202 }))
      .mockResolvedValueOnce(new Response('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"success\\":true}"}]}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
    const client = new TrendRadarMcpClient("http://trendradar-mcp:3333/mcp", fetcher);
    await expect(client.callTool<{ success: boolean }>("get_system_status")).resolves.toEqual({ success: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2][1]?.headers).toMatchObject({ "Mcp-Session-Id": "session-1" });
  });
});
