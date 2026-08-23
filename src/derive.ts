/**
 * Unit conversion and derived metrics.
 *
 * Readings are stored in Celsius exactly as the API returned them, so nothing
 * is lost to rounding. Conversion to Fahrenheit happens once, here, on the way
 * out to ConstantGraph.
 */

import { EQUIPMENT_STATUS } from './daikin/types';
import type { Reading } from './db/repo';
import type { MetricKey } from './config';

export function cToF(c: number | null | undefined): number | null {
  if (c === null || c === undefined || !Number.isFinite(c)) return null;
  return round2((c * 9) / 5 + 32);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compressor runtime for one sampling interval.
 *
 * IMPORTANT: equipmentStatus is a point sample, not a meter. This credits the
 * whole interval whenever the system happened to be running at the instant we
 * polled. Over a day it is a fair duty-cycle estimate; for any single interval
 * it is an approximation, and short cycles between samples are invisible.
 */
export function runtimeMinutes(
  equipmentStatus: number | null | undefined,
  intervalMin: number,
): { heat: number; cool: number } {
  if (equipmentStatus === EQUIPMENT_STATUS.heat) return { heat: intervalMin, cool: 0 };
  if (
    equipmentStatus === EQUIPMENT_STATUS.cool ||
    equipmentStatus === EQUIPMENT_STATUS.overcool
  ) {
    return { heat: 0, cool: intervalMin };
  }
  return { heat: 0, cool: 0 };
}

/**
 * Project a stored reading into the metric values ConstantGraph receives.
 * Null entries are omitted by the publisher rather than sent as zero, so a
 * missing outdoor sensor leaves a gap instead of a misleading 32 F line.
 */
export function metricsFor(
  reading: Reading,
  intervalMin: number,
): Partial<Record<MetricKey, number | null>> {
  const indoorF = cToF(reading.temp_indoor_c);
  const outdoorF = cToF(reading.temp_outdoor_c);
  const runtime = runtimeMinutes(reading.equipment_status, intervalMin);

  return {
    tempIndoorF: indoorF,
    humIndoor: reading.hum_indoor,
    tempOutdoorF: outdoorF,
    humOutdoor: reading.hum_outdoor,
    heatSetpointF: cToF(reading.heat_setpoint_c),
    coolSetpointF: cToF(reading.cool_setpoint_c),
    mode: reading.mode,
    equipmentStatus: reading.equipment_status,
    runtimeHeatMin: runtime.heat,
    runtimeCoolMin: runtime.cool,
    deltaF: indoorF !== null && outdoorF !== null ? round2(indoorF - outdoorF) : null,
  };
}
