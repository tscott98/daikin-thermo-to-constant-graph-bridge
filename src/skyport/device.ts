/**
 * Static per-install config, written to the devices table.
 * Generated alongside SKYPORT_COLUMNS; see scripts/gen_skyport_fields.py.
 */

import type { SkyportDeviceData } from './types';
import { plain } from './types';

export function skyportDeviceFields(
  d: SkyportDeviceData,
): Record<string, number | string | null> {
  return {
    // outdoor unit size code
    sp_tonnage: plain(d.ctOutdoorTonnage),
    // rated cooling power
    sp_cooling_rated_power: plain(d.ctCoolingRatedPower),
    // rated heating power
    sp_heating_rated_power: plain(d.ctHeatingRatedPower),
    // outdoor unit type code
    sp_od_unit_type: plain(d.ctOutdoorUnitType),
    // indoor unit type code
    sp_ifc_unit_type: plain(d.ctIFCUnitType),
    // thermostat model string
    sp_stat_model: typeof d.statModel === 'string' ? d.statModel : null,
    // minimum compressor on time, ms
    sp_compressor_min_on: plain(d.compressorMinOn),
    // minimum compressor off time, ms
    sp_compressor_min_off: plain(d.compressorMinOff),
  };
}
