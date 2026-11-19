import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  type DateWindow,
  type DexcomAuth,
  type Egv,
  getAlerts,
  getCalibrations,
  getDataRange,
  getDevices,
  getEgvs,
  getEvents,
  validateWindow,
} from "@wyattjoh/dexcom";
import { z } from "zod";
import type { DexcomSessions } from "../session.ts";
import { mgdlToMmol, summarizeGlucose } from "./glucose-summary.ts";
import { withStrictInputSchemas, wrapToolHandler } from "./tool-wrapper.ts";

const DATA_DELAY_NOTE =
  "Dexcom delays mobile-app data by 1 hour in the US and 3 hours elsewhere.";

const timestamp = z.string().min(1).describe(
  "ISO 8601 timestamp in UTC, e.g. 2026-11-18T00:00:00 (an offset or Z is also accepted)",
);

const windowShape = {
  startDate: timestamp.describe("Inclusive window start (UTC, ISO 8601)"),
  endDate: timestamp.describe(
    "Exclusive window end (UTC, ISO 8601). At most 30 days after startDate.",
  ),
};

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function toWindow(args: DateWindow): DateWindow {
  // Validate locally so the model gets a clear error instead of a Dexcom 400.
  return validateWindow(args);
}

function withMmol(egvs: Egv[]): Array<Egv & { valueMmol: number | null }> {
  return egvs.map((egv) => ({
    ...egv,
    valueMmol: typeof egv.value === "number" ? mgdlToMmol(egv.value) : null,
  }));
}

/**
 * Registers the read-only Dexcom tools for one user.
 *
 * @param server - MCP server.
 * @param sessions - Dexcom session manager.
 * @param userId - Dexcom user the tools act for.
 */
export function createDexcomTools(
  server: McpServer,
  sessions: DexcomSessions,
  userId: string,
): void {
  const strict = withStrictInputSchemas(server);
  const run = <T>(fn: (auth: DexcomAuth) => Promise<T>): Promise<T> =>
    sessions.withAuth(userId, fn);

  strict.registerTool(
    "dexcom_get_egvs",
    {
      title: "Get glucose readings",
      description:
        `Estimated glucose values (CGM readings, mg/dL, roughly every 5 minutes) with trend arrows for a window of up to 30 days. ${DATA_DELAY_NOTE}`,
      inputSchema: {
        ...windowShape,
        unit: z.enum(["mg/dL", "mmol/L"]).optional().describe(
          "Add mmol/L conversions when set to mmol/L (Dexcom always reports mg/dL)",
        ),
      },
      annotations: readOnly,
    },
    wrapToolHandler("dexcom_get_egvs", async (args) => {
      const window = toWindow(args);
      const result = await run((auth) => getEgvs(auth, window));
      return jsonResult(
        args.unit === "mmol/L"
          ? { ...result, records: withMmol(result.records) }
          : result,
      );
    }),
  );

  strict.registerTool(
    "dexcom_glucose_summary",
    {
      title: "Summarize glucose",
      description:
        `Mean glucose, GMI (estimated A1c), variability, and time in consensus ranges (<54, 54-69, 70-180, 181-250, >250 mg/dL) for a window of up to 30 days. ${DATA_DELAY_NOTE}`,
      inputSchema: windowShape,
      annotations: readOnly,
    },
    wrapToolHandler("dexcom_glucose_summary", async (args) => {
      const window = toWindow(args);
      const result = await run((auth) => getEgvs(auth, window));
      return jsonResult({ window, ...summarizeGlucose(result.records) });
    }),
  );

  strict.registerTool(
    "dexcom_get_events",
    {
      title: "Get user events",
      description:
        "User-entered events (carbs, insulin, exercise, health, blood glucose) for a window of up to 30 days.",
      inputSchema: windowShape,
      annotations: readOnly,
    },
    wrapToolHandler("dexcom_get_events", async (args) => {
      const window = toWindow(args);
      return jsonResult(await run((auth) => getEvents(auth, window)));
    }),
  );

  strict.registerTool(
    "dexcom_get_calibrations",
    {
      title: "Get calibrations",
      description:
        "Fingerstick calibration entries for a window of up to 30 days.",
      inputSchema: windowShape,
      annotations: readOnly,
    },
    wrapToolHandler("dexcom_get_calibrations", async (args) => {
      const window = toWindow(args);
      return jsonResult(await run((auth) => getCalibrations(auth, window)));
    }),
  );

  strict.registerTool(
    "dexcom_get_alerts",
    {
      title: "Get alerts",
      description:
        "Alert events (high, low, urgent low, rise, fall, no readings) raised by the display device for a window of up to 30 days.",
      inputSchema: windowShape,
      annotations: readOnly,
    },
    wrapToolHandler("dexcom_get_alerts", async (args) => {
      const window = toWindow(args);
      return jsonResult(await run((auth) => getAlerts(auth, window)));
    }),
  );

  strict.registerTool(
    "dexcom_get_devices",
    {
      title: "Get devices",
      description:
        "Display devices and transmitters with their alert schedules and thresholds as of the last upload.",
      inputSchema: {},
      annotations: readOnly,
    },
    wrapToolHandler("dexcom_get_devices", async () => {
      return jsonResult(await run((auth) => getDevices(auth)));
    }),
  );

  strict.registerTool(
    "dexcom_get_data_range",
    {
      title: "Get data range",
      description:
        "Earliest and latest available EGV, event, and calibration times. Call this first to choose valid windows for other tools.",
      inputSchema: {
        lastSyncTime: timestamp.optional().describe(
          "Only consider data uploaded after this time",
        ),
      },
      annotations: readOnly,
    },
    wrapToolHandler("dexcom_get_data_range", async (args) => {
      return jsonResult(
        await run((auth) => getDataRange(auth, args.lastSyncTime)),
      );
    }),
  );
}
