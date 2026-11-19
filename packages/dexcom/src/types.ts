/**
 * Transmitter generations reported by Dexcom.
 */
export type TransmitterGeneration = "unknown" | "g6" | "g6+" | "g6Pro" | "g7";

/**
 * Alert names shared by alert events and device alert settings.
 */
export type AlertName =
  | "unknown"
  | "high"
  | "low"
  | "rise"
  | "fall"
  | "outOfRange"
  | "urgentLow"
  | "urgentLowSoon"
  | "noReadings";

/**
 * EGV trend arrows.
 */
export type Trend =
  | "none"
  | "unknown"
  | "doubleUp"
  | "singleUp"
  | "fortyFiveUp"
  | "flat"
  | "fortyFiveDown"
  | "singleDown"
  | "doubleDown"
  | "notComputable"
  | "rateOutOfRange";

/**
 * Envelope shared by every record-list response.
 */
export interface RecordsWrapper<T> {
  /**
   * Record type, e.g. "egv".
   */
  recordType: string;
  /**
   * Record schema version, e.g. "3.0".
   */
  recordVersion: string;
  /**
   * Per-account, per-client stable user identifier.
   */
  userId: string;
  /**
   * Records in the requested window.
   */
  records: T[];
}

/**
 * Fields common to timestamped records.
 */
export interface TimedRecord {
  /**
   * Unique record ID.
   */
  recordId: string;
  /**
   * Device UTC time (subject to drift).
   */
  systemTime: string;
  /**
   * Time shown on the display device.
   */
  displayTime: string;
  /**
   * Display device type: unknown, receiver, iOS, android.
   */
  displayDevice: string;
  /**
   * Transmitter generation.
   */
  transmitterGeneration: TransmitterGeneration;
  /**
   * Transmitter generation variant, e.g. "g715d".
   */
  transmitterGenerationVariant: string;
}

/**
 * An estimated glucose value. Values are always mg/dL.
 */
export interface Egv extends TimedRecord {
  /**
   * Hashed transmitter ID.
   */
  transmitterId: string | null;
  /**
   * Seconds since transmitter start.
   */
  transmitterTicks: number;
  /**
   * Glucose value in mg/dL. Readings outside the sensor's range carry the
   * sentinels 39 (low) or 401 (high) together with `status`; null when no
   * value was calculated.
   */
  value: number | null;
  /**
   * "high" or "low" when the reading is outside the sensor's range.
   */
  status: "high" | "low" | null;
  /**
   * Trend arrow.
   */
  trend: Trend | null;
  /**
   * Trend rate in mg/dL/min.
   */
  trendRate: number | null;
  /**
   * Unit of value.
   */
  unit: string;
  /**
   * Unit of trendRate.
   */
  rateUnit: string;
  /**
   * Display app, e.g. "G7".
   */
  displayApp: string | null;
}

/**
 * A user-entered event (carbs, insulin, exercise, health, blood glucose).
 */
export interface DexcomEvent extends TimedRecord {
  /**
   * Whether the record was created, updated, or deleted.
   */
  eventStatus: "created" | "updated" | "deleted";
  /**
   * Event category.
   */
  eventType:
    | "bloodGlucose"
    | "carbs"
    | "exercise"
    | "health"
    | "insulin"
    | "unknown";
  /**
   * Event sub-category, such as "fastActing" for insulin.
   */
  eventSubType: string | null;
  /**
   * Event value as entered.
   */
  value: string;
  /**
   * Unit of value.
   */
  unit: string | null;
  /**
   * Hashed transmitter ID.
   */
  transmitterId: string;
}

/**
 * A fingerstick calibration entry.
 */
export interface Calibration extends TimedRecord {
  /**
   * Calibration value.
   */
  value: number;
  /**
   * Unit of value.
   */
  unit: string | null;
  /**
   * Hashed transmitter ID.
   */
  transmitterId: string;
  /**
   * Seconds since transmitter start.
   */
  transmitterTicks: number;
}

/**
 * An alert raised by the display device.
 */
export interface AlertEvent extends TimedRecord {
  /**
   * Alert name.
   */
  alertName: AlertName;
  /**
   * Alert state.
   */
  alertState: "unknown" | "inactive" | "activeSnoozed" | "activeAlarming";
  /**
   * Hashed transmitter ID.
   */
  transmitterId: string;
  /**
   * Display app.
   */
  displayApp: string;
}

/**
 * A device alert setting.
 */
export interface DeviceAlertSetting {
  /**
   * Alert name.
   */
  alertName: AlertName;
  /**
   * Threshold value.
   */
  value: number | null;
  /**
   * Unit of value.
   */
  unit: string | null;
  /**
   * Snooze minutes.
   */
  snooze: number | null;
  /**
   * Whether the alert is enabled.
   */
  enabled: boolean;
  /**
   * Remaining fields as returned by Dexcom.
   */
  [key: string]: unknown;
}

/**
 * A device alert schedule.
 */
export interface DeviceAlertSchedule {
  /**
   * Schedule settings (name, days, times, override).
   */
  alertScheduleSettings: Record<string, unknown>;
  /**
   * Alert settings for the schedule.
   */
  alertSettings: DeviceAlertSetting[];
}

/**
 * A display device and its alert configuration.
 */
export interface Device {
  /**
   * Last upload time (UTC).
   */
  lastUploadDate: string;
  /**
   * Hashed transmitter ID.
   */
  transmitterId: string | null;
  /**
   * Transmitter generation.
   */
  transmitterGeneration: TransmitterGeneration;
  /**
   * Transmitter generation variant.
   */
  transmitterGenerationVariant: string;
  /**
   * Display device type.
   */
  displayDevice: string;
  /**
   * Display app.
   */
  displayApp: string | null;
  /**
   * Alert schedules as of lastUploadDate.
   */
  alertSchedules: DeviceAlertSchedule[];
}

/**
 * A moment in a data range (local date-times without offsets).
 */
export interface DataRangeMoment {
  /**
   * Device system time.
   */
  systemTime: string;
  /**
   * Display time.
   */
  displayTime: string;
}

/**
 * Earliest and latest record times for one record type.
 */
export interface DataRangeStartAndEnd {
  /**
   * Earliest record.
   */
  start: DataRangeMoment;
  /**
   * Latest record.
   */
  end: DataRangeMoment;
}

/**
 * Response of /v3/users/self/dataRange.
 */
export interface DataRange {
  /**
   * Record type ("dataRange").
   */
  recordType: string;
  /**
   * Record version.
   */
  recordVersion: string;
  /**
   * Per-account, per-client stable user identifier.
   */
  userId: string;
  /**
   * Calibration range, when any exist.
   */
  calibrations: DataRangeStartAndEnd | null;
  /**
   * EGV range, when any exist.
   */
  egvs: DataRangeStartAndEnd | null;
  /**
   * Event range, when any exist.
   */
  events: DataRangeStartAndEnd | null;
}

/**
 * Response of POST /v3/oauth2/token.
 */
export interface TokenResponse {
  /**
   * Bearer token for data requests.
   */
  access_token: string;
  /**
   * Access token lifetime in seconds.
   */
  expires_in: number;
  /**
   * Always "Bearer".
   */
  token_type: string;
  /**
   * Single-use refresh token; replaces the previous one.
   */
  refresh_token: string;
}

/**
 * A time window for record queries. Both values are ISO 8601 UTC
 * timestamps; the window is inclusive of start, exclusive of end, and at most
 * 30 days long.
 */
export interface DateWindow {
  /**
   * Inclusive start.
   */
  startDate: string;
  /**
   * Exclusive end.
   */
  endDate: string;
}
