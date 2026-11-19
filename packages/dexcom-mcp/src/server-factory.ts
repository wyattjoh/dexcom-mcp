import { McpServer } from "@modelcontextprotocol/server";
import deno from "../deno.json" with { type: "json" };
import { getLogger } from "./logging.ts";
import type { DexcomSessions } from "./session.ts";
import { createDexcomTools } from "./tools/dexcom-tools.ts";

/**
 * Creates an MCP server whose tools act for one Dexcom user.
 *
 * @param sessions - Dexcom session manager.
 * @param userId - Dexcom user ID (or "local" in stdio mode).
 * @returns The configured server.
 */
export function createMcpServerWithTools(
  sessions: DexcomSessions,
  userId: string,
): McpServer {
  getLogger(["dexcom-mcp"]).debug("Creating MCP server", { userId });
  const server = new McpServer(
    { name: "dexcom-mcp", version: deno.version },
    {
      capabilities: { tools: {} },
      instructions:
        "Read-only access to the user's Dexcom CGM data. Glucose values are mg/dL. Query windows are UTC and limited to 30 days; call dexcom_get_data_range first to find available data.",
    },
  );
  createDexcomTools(server, sessions, userId);
  return server;
}
