import { assertEquals } from "@std/assert";
import type { Egv } from "@wyattjoh/dexcom";
import { summarizeGlucose } from "../src/tools/glucose-summary.ts";

const egv = (value: number | null, status: "high" | "low" | null = null) =>
  ({ value, status, systemTime: "2026-11-17T00:00:00" }) as Egv;

Deno.test("summary buckets readings into consensus ranges", () => {
  const summary = summarizeGlucose([
    egv(50),
    egv(65),
    egv(100),
    egv(200),
    egv(300),
    egv(null, "low"),
    egv(null, "high"),
  ]);
  assertEquals(summary.readings, 5);
  assertEquals(summary.outOfSensorRange, { high: 1, low: 1 });
  assertEquals(summary.timeInRangesPercent.veryLow, 28.6);
  assertEquals(summary.timeInRangesPercent.inRange, 14.3);
  assertEquals(summary.meanMgdl, 143);
});

Deno.test("sensor-limit sentinels count as out of range and stay in the statistics", () => {
  const summary = summarizeGlucose([
    egv(39, "low"),
    egv(100),
    egv(401, "high"),
  ]);
  assertEquals(summary.outOfSensorRange, { high: 1, low: 1 });
  assertEquals(summary.readings, 3);
  assertEquals(summary.minMgdl, 39);
  assertEquals(summary.timeInRangesPercent.veryLow, 33.3);
  assertEquals(summary.timeInRangesPercent.veryHigh, 33.3);
});
