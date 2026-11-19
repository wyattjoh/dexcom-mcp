import type { Egv } from "@wyattjoh/dexcom";

/**
 * Converts mg/dL to mmol/L, rounded to one decimal.
 *
 * @param mgdl - Value in mg/dL.
 * @returns Value in mmol/L.
 */
export function mgdlToMmol(mgdl: number): number {
  return Math.round((mgdl / 18.0182) * 10) / 10;
}

/**
 * Aggregate glucose statistics over a set of EGVs.
 */
export interface GlucoseSummary {
  /**
   * Readings with a numeric value.
   */
  readings: number;
  /**
   * Readings reported only as "high" or "low" (outside sensor range).
   */
  outOfSensorRange: { high: number; low: number };
  /**
   * Mean glucose (mg/dL).
   */
  meanMgdl: number | null;
  /**
   * Standard deviation (mg/dL).
   */
  standardDeviationMgdl: number | null;
  /**
   * Coefficient of variation in percent; under 36% is considered stable.
   */
  coefficientOfVariationPercent: number | null;
  /**
   * Glucose management indicator (estimated A1c), percent.
   */
  gmiPercent: number | null;
  /**
   * Minimum and maximum readings (mg/dL).
   */
  minMgdl: number | null;
  /**
   * Maximum reading (mg/dL).
   */
  maxMgdl: number | null;
  /**
   * Percent of readings in each international consensus range.
   */
  timeInRangesPercent: {
    veryLow: number;
    low: number;
    inRange: number;
    high: number;
    veryHigh: number;
  };
  /**
   * Earliest and latest reading system times.
   */
  firstReading: string | null;
  /**
   * Latest reading system time.
   */
  lastReading: string | null;
}

const round = (value: number, digits = 1) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Computes a glucose summary using the international consensus ranges
 * (<54, 54-69, 70-180, 181-250, >250 mg/dL). "high"/"low" sensor-limit
 * readings count toward the very high/very low buckets.
 *
 * @param egvs - EGV records.
 * @returns The summary.
 */
export function summarizeGlucose(egvs: Egv[]): GlucoseSummary {
  const values: number[] = [];
  let sensorHigh = 0;
  let sensorLow = 0;
  for (const egv of egvs) {
    if (typeof egv.value === "number") values.push(egv.value);
    else if (egv.status === "high") sensorHigh++;
    else if (egv.status === "low") sensorLow++;
  }

  const buckets = {
    veryLow: sensorLow,
    low: 0,
    inRange: 0,
    high: 0,
    veryHigh: sensorHigh,
  };
  for (const value of values) {
    if (value < 54) buckets.veryLow++;
    else if (value < 70) buckets.low++;
    else if (value <= 180) buckets.inRange++;
    else if (value <= 250) buckets.high++;
    else buckets.veryHigh++;
  }
  const total = values.length + sensorHigh + sensorLow;
  const percent = (count: number) => total ? round((count / total) * 100) : 0;

  const times = egvs.map((egv) => egv.systemTime).sort();
  const mean = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
  const sd = mean !== null && values.length > 1
    ? Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (values.length - 1),
    )
    : null;

  return {
    readings: values.length,
    outOfSensorRange: { high: sensorHigh, low: sensorLow },
    meanMgdl: mean === null ? null : round(mean),
    standardDeviationMgdl: sd === null ? null : round(sd),
    coefficientOfVariationPercent: mean && sd !== null
      ? round((sd / mean) * 100)
      : null,
    gmiPercent: mean === null ? null : round(3.31 + 0.02392 * mean),
    minMgdl: values.length ? Math.min(...values) : null,
    maxMgdl: values.length ? Math.max(...values) : null,
    timeInRangesPercent: {
      veryLow: percent(buckets.veryLow),
      low: percent(buckets.low),
      inRange: percent(buckets.inRange),
      high: percent(buckets.high),
      veryHigh: percent(buckets.veryHigh),
    },
    firstReading: times[0] ?? null,
    lastReading: times.at(-1) ?? null,
  };
}
