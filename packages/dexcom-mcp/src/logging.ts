import {
  configure,
  getConsoleSink,
  getLogger as getLogTapeLogger,
  getStreamSink,
  type Logger,
} from "@logtape/logtape";

/**
 * Options for {@link configureLogging}.
 */
export interface LoggingOptions {
  /**
   * Enables debug-level output.
   */
  debug: boolean;
  /**
   * Writes to stderr, required when stdout carries MCP stdio traffic.
   */
  useStdio: boolean;
}

let isConfigured = false;

/**
 * Configures LogTape sinks once per process.
 *
 * @param options - Log level and sink selection.
 */
export async function configureLogging(options: LoggingOptions): Promise<void> {
  if (isConfigured) return;
  const lowestLevel = options.debug ? "debug" : "info";
  const sink = options.useStdio
    ? getStreamSink(Deno.stderr.writable)
    : getConsoleSink();

  await configure({
    sinks: { main: sink },
    loggers: [
      { category: ["dexcom-mcp"], lowestLevel, sinks: ["main"] },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: ["main"],
      },
    ],
  });
  isConfigured = true;
}

/**
 * Returns a logger under the `dexcom-mcp` category tree.
 *
 * @param category - Category path; defaults to the root.
 * @returns The logger.
 */
export function getLogger(category: string[] = ["dexcom-mcp"]): Logger {
  return getLogTapeLogger(category);
}
