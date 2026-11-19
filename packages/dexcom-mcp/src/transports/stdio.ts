import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { getLogger } from "../logging.ts";
import { createMcpServerWithTools } from "../server-factory.ts";
import type { DexcomSessions } from "../session.ts";

/**
 * Grant key used for the single local user in stdio mode.
 */
export const LOCAL_USER_ID = "local";

/**
 * Serves MCP over stdio using the grant stored by `dexcom-mcp login`.
 *
 * @param sessions - Dexcom session manager.
 * @returns A close function.
 */
export function createStdioServer(
  sessions: DexcomSessions,
): { close: () => Promise<void> } {
  const logger = getLogger(["dexcom-mcp", "transport", "stdio"]);
  const server = serveStdio(
    () => createMcpServerWithTools(sessions, LOCAL_USER_ID),
    {
      onerror: (error) =>
        logger.error("Stdio server error", { error: error.message }),
    },
  );
  logger.info("Dexcom MCP server running on stdio");
  return {
    close: async () => {
      await server.close();
    },
  };
}
