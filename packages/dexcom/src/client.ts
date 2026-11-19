import type { DexcomConfig } from "./config.ts";
import { toDexcomApiError } from "./errors.ts";
import type {
  AlertEvent,
  Calibration,
  DataRange,
  DateWindow,
  Device,
  DexcomEvent,
  Egv,
  RecordsWrapper,
} from "./types.ts";

/**
 * Credentials for a data request: the config plus a user's access token.
 */
export interface DexcomAuth {
  /**
   * Dexcom configuration.
   */
  readonly config: DexcomConfig;
  /**
   * The user's current access token.
   */
  readonly accessToken: string;
}

const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Normalizes a timestamp to the format Dexcom expects
 * (`YYYY-MM-DDTHH:mm:ss`, UTC, no offset).
 *
 * @param value - Any timestamp Date can parse.
 * @returns The Dexcom-formatted timestamp.
 */
export function toDexcomTimestamp(value: string | Date): string {
  const date = typeof value === "string" ? parseUtc(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return date.toISOString().slice(0, 19);
}

function parseUtc(value: string): Date {
  // Timestamps without an offset are UTC per the Dexcom docs.
  const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Date(hasOffset || isDateOnly ? value : `${value}Z`);
}

/**
 * Validates a query window against Dexcom's rules: start before end and at
 * most 30 days apart.
 *
 * @param window - The requested window.
 * @returns The window with normalized timestamps.
 */
export function validateWindow(window: DateWindow): DateWindow {
  const startDate = toDexcomTimestamp(window.startDate);
  const endDate = toDexcomTimestamp(window.endDate);
  const span = Date.parse(`${endDate}Z`) - Date.parse(`${startDate}Z`);
  if (span <= 0) throw new Error("startDate must be before endDate");
  if (span > MAX_WINDOW_MS) {
    throw new Error(
      "The window between startDate and endDate is limited to 30 days",
    );
  }
  return { startDate, endDate };
}

async function makeRequest<T>(
  auth: DexcomAuth,
  path: string,
  query: Record<string, string> | undefined,
): Promise<T> {
  const url = new URL(`${auth.config.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await auth.config.fetch(url, {
    headers: {
      "Authorization": `Bearer ${auth.accessToken}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(auth.config.timeoutMs),
  });
  if (!response.ok) throw await toDexcomApiError(response, `GET ${path}`);
  return await response.json() as T;
}

function getWindowed<T>(
  auth: DexcomAuth,
  path: string,
  window: DateWindow,
): Promise<RecordsWrapper<T>> {
  return makeRequest(auth, path, { ...validateWindow(window) });
}

/**
 * Lists estimated glucose values (mg/dL) in a window of up to 30 days.
 *
 * @param auth - Config and access token.
 * @param window - Query window.
 * @returns The EGV records.
 */
export function getEgvs(
  auth: DexcomAuth,
  window: DateWindow,
): Promise<RecordsWrapper<Egv>> {
  return getWindowed(auth, "/v3/users/self/egvs", window);
}

/**
 * Lists user-entered events in a window of up to 30 days.
 *
 * @param auth - Config and access token.
 * @param window - Query window.
 * @returns The event records.
 */
export function getEvents(
  auth: DexcomAuth,
  window: DateWindow,
): Promise<RecordsWrapper<DexcomEvent>> {
  return getWindowed(auth, "/v3/users/self/events", window);
}

/**
 * Lists calibrations in a window of up to 30 days.
 *
 * @param auth - Config and access token.
 * @param window - Query window.
 * @returns The calibration records.
 */
export function getCalibrations(
  auth: DexcomAuth,
  window: DateWindow,
): Promise<RecordsWrapper<Calibration>> {
  return getWindowed(auth, "/v3/users/self/calibrations", window);
}

/**
 * Lists alert events in a window of up to 30 days.
 *
 * @param auth - Config and access token.
 * @param window - Query window.
 * @returns The alert records.
 */
export function getAlerts(
  auth: DexcomAuth,
  window: DateWindow,
): Promise<RecordsWrapper<AlertEvent>> {
  return getWindowed(auth, "/v3/users/self/alerts", window);
}

/**
 * Lists the user's devices and their alert settings.
 *
 * @param auth - Config and access token.
 * @returns The device records.
 */
export function getDevices(auth: DexcomAuth): Promise<RecordsWrapper<Device>> {
  return makeRequest(auth, "/v3/users/self/devices", undefined);
}

/**
 * Returns the earliest and latest record times per record type.
 *
 * @param auth - Config and access token.
 * @param lastSyncTime - Optional timestamp to only consider newer uploads.
 * @returns The data range.
 */
export function getDataRange(
  auth: DexcomAuth,
  lastSyncTime: string | undefined,
): Promise<DataRange> {
  return makeRequest(
    auth,
    "/v3/users/self/dataRange",
    lastSyncTime
      ? { lastSyncTime: toDexcomTimestamp(lastSyncTime) }
      : undefined,
  );
}

/**
 * Verifies an access token by fetching the data range.
 *
 * @param auth - Config and access token.
 * @returns Success flag and error message.
 */
export async function testConnection(
  auth: DexcomAuth,
): Promise<{ success: boolean; error?: string }> {
  try {
    await getDataRange(auth, undefined);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
