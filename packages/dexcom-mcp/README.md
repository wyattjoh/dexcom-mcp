# @wyattjoh/dexcom-mcp

MCP server for the Dexcom API with an OAuth bridge. See the
[repository README](https://github.com/wyattjoh/dexcom-mcp#readme) for setup.

| Tool                      | Description                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `dexcom_get_data_range`   | Earliest/latest available EGV, event, and calibration times       |
| `dexcom_get_egvs`         | CGM readings (mg/dL, optional mmol/L) with trends, ≤30-day window |
| `dexcom_glucose_summary`  | Mean, GMI, SD/CV, time in consensus ranges, ≤30-day window        |
| `dexcom_get_events`       | User-entered carbs, insulin, exercise, health events              |
| `dexcom_get_calibrations` | Fingerstick calibrations                                          |
| `dexcom_get_alerts`       | High/low/urgent-low/rise/fall/no-reading alerts                   |
| `dexcom_get_devices`      | Devices, transmitters, alert schedules and thresholds             |
