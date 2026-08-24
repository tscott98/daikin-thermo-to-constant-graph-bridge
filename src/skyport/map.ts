/**
 * Skyport wire format -> stored columns.
 *
 * Generated from scripts/gen_skyport_fields.py, which is also the source for
 * migrations 0003 and 0004. Keep the two in step by regenerating rather than
 * hand-editing.
 *
 * Every field here was observed populated and non-sentinel on real hardware
 * (a ONETOUCH driving an inverter heat pump). Fields that read as sentinels on
 * that unit -- the whole ctAH* air-handler group, return/supply air temps --
 * are deliberately absent.
 *
 * Units: values marked "unit unverified" are stored exactly as the API sent
 * them. Guessing a conversion and baking it in is how the sentinel bug nearly
 * shipped; better a raw number with a documented question mark.
 */

import type { SkyportDeviceData } from './types';
import { SENTINELS, halfPercent, deciwatts, plain } from './types';

export interface SkyportFields {
  sp_outdoor_power: number | null;
  sp_indoor_power: number | null;
  sp_compressor_current: number | null;
  sp_inverter_current: number | null;
  sp_od_fan_current: number | null;
  sp_compressor_runtime: number | null;
  sp_compressor_rps: number | null;
  sp_target_compressor_rps: number | null;
  sp_frequency_pct: number | null;
  sp_cool_demand_pct: number | null;
  sp_fan_demand_pct: number | null;
  sp_indoor_airflow: number | null;
  sp_od_fan_rpm: number | null;
  sp_od_fan_target: number | null;
  sp_suction_temp: number | null;
  sp_discharge_temp: number | null;
  sp_od_coil_temp: number | null;
  sp_od_liquid_temp: number | null;
  sp_suction_pressure: number | null;
  sp_eev_opening: number | null;
  sp_inverter_fin_temp: number | null;
  sp_eev_superheat: number | null;
  sp_eev_suction_temp: number | null;
  sp_eev_liquid_temp: number | null;
  sp_reversing_valve: number | null;
  sp_od_air_temp: number | null;
  sp_hum_setpoint: number | null;
  sp_dehum_setpoint: number | null;
  sp_overcool_amount: number | null;
  sp_zone1_damper: number | null;
  sp_aq_outdoor_ozone: number | null;
  sp_aq_outdoor_particles: number | null;
  sp_dehum_demand_pct: number | null;
  sp_alg_dehum_demand: number | null;
  sp_alg_overcool_demand: number | null;
  sp_alg_cool_demand: number | null;
  sp_requested_airflow: number | null;
  sp_fan_actual_pct: number | null;
  sp_compressor_reduction: number | null;
  sp_fault_od_critical: number | null;
  sp_fault_od_minor: number | null;
  sp_fault_ifc_critical: number | null;
  sp_fault_ifc_minor: number | null;
  sp_fault_stat_critical: number | null;
  sp_fault_stat_minor: number | null;
}

export const EMPTY_SKYPORT: SkyportFields = {
  sp_outdoor_power: null,
  sp_indoor_power: null,
  sp_compressor_current: null,
  sp_inverter_current: null,
  sp_od_fan_current: null,
  sp_compressor_runtime: null,
  sp_compressor_rps: null,
  sp_target_compressor_rps: null,
  sp_frequency_pct: null,
  sp_cool_demand_pct: null,
  sp_fan_demand_pct: null,
  sp_indoor_airflow: null,
  sp_od_fan_rpm: null,
  sp_od_fan_target: null,
  sp_suction_temp: null,
  sp_discharge_temp: null,
  sp_od_coil_temp: null,
  sp_od_liquid_temp: null,
  sp_suction_pressure: null,
  sp_eev_opening: null,
  sp_inverter_fin_temp: null,
  sp_eev_superheat: null,
  sp_eev_suction_temp: null,
  sp_eev_liquid_temp: null,
  sp_reversing_valve: null,
  sp_od_air_temp: null,
  sp_hum_setpoint: null,
  sp_dehum_setpoint: null,
  sp_overcool_amount: null,
  sp_zone1_damper: null,
  sp_aq_outdoor_ozone: null,
  sp_aq_outdoor_particles: null,
  sp_dehum_demand_pct: null,
  sp_alg_dehum_demand: null,
  sp_alg_overcool_demand: null,
  sp_alg_cool_demand: null,
  sp_requested_airflow: null,
  sp_fan_actual_pct: null,
  sp_compressor_reduction: null,
  sp_fault_od_critical: null,
  sp_fault_od_minor: null,
  sp_fault_ifc_critical: null,
  sp_fault_ifc_minor: null,
  sp_fault_stat_critical: null,
  sp_fault_stat_minor: null,
};

export function skyportFields(d: SkyportDeviceData): SkyportFields {
  return {
    // outdoor unit power, W
    sp_outdoor_power: deciwatts(d.ctOutdoorPower),
    // indoor unit power, unit unverified
    sp_indoor_power: plain(d.ctIndoorPower),
    // compressor current, likely deciamps
    sp_compressor_current: plain(d.ctCompressorCurrent),
    // inverter current, likely deciamps
    sp_inverter_current: plain(d.ctInverterCurrent),
    // outdoor fan motor current
    sp_od_fan_current: plain(d.ctODFanMotorCurrent),
    // CUMULATIVE counter; difference it for true runtime
    sp_compressor_runtime: plain(d.ctOutdoorCompressorRunTime),
    // compressor speed, rev/sec
    sp_compressor_rps: plain(d.ctCurrentCompressorRPS),
    // commanded compressor speed
    sp_target_compressor_rps: plain(d.ctTargetCompressorspeed),
    // inverter frequency, %
    sp_frequency_pct: halfPercent(d.ctOutdoorFrequencyInPercent),
    // outdoor cool demand, %
    sp_cool_demand_pct: halfPercent(d.ctOutdoorCoolRequestedDemand),
    // indoor fan demand, %
    sp_fan_demand_pct: halfPercent(d.ctIFCFanRequestedDemandPercent),
    // blower airflow, CFM
    sp_indoor_airflow: plain(d.ctIFCIndoorBlowerAirflow),
    // outdoor fan speed, RPM
    sp_od_fan_rpm: plain(d.ctOutdoorFanRPM),
    // commanded outdoor fan, unit unverified
    sp_od_fan_target: plain(d.ctTargetODFanRPM),
    // suction line temp, likely tenths F
    sp_suction_temp: plain(d.ctOutdoorSuctionTemperature),
    // discharge temp, likely tenths F
    sp_discharge_temp: plain(d.ctOutdoorDischargeTemperature),
    // outdoor coil temp, likely tenths F
    sp_od_coil_temp: plain(d.ctOutdoorCoilTemperature),
    // outdoor liquid line temp, likely tenths F
    sp_od_liquid_temp: plain(d.ctOutdoorLiquidTemperature),
    // suction pressure, likely psi
    sp_suction_pressure: plain(d.ctOutdoorSuctionPressure),
    // expansion valve opening
    sp_eev_opening: plain(d.ctOutdoorEEVOpening),
    // inverter heatsink temp, C
    sp_inverter_fin_temp: plain(d.ctInverterFinTemp),
    // superheat; trend it to spot charge loss
    sp_eev_superheat: plain(d.ctEEVCoilSuperHeatValue),
    // indoor coil suction temp
    sp_eev_suction_temp: plain(d.ctEEVCoilSuctionTemperature),
    // indoor coil liquid temp
    sp_eev_liquid_temp: plain(d.ctEEVCoilLiquidTemperature),
    // heat/cool direction
    sp_reversing_valve: plain(d.ctReversingValve),
    // outdoor unit's own air sensor, tenths F
    sp_od_air_temp: plain(d.ctOutdoorAirTemperature),
    // humidification setpoint, %
    sp_hum_setpoint: plain(d.humSP),
    // dehumidification setpoint, %
    sp_dehum_setpoint: plain(d.dehumSP),
    // permitted overcool for dehum, C
    sp_overcool_amount: plain(d.overcoolAmount),
    // zone 1 damper position, %
    sp_zone1_damper: plain(d.Zone1DamperPosition),
    // outdoor ozone, ppb
    sp_aq_outdoor_ozone: plain(d.aqOutdoorOzone),
    // outdoor particulates, ug/m3
    sp_aq_outdoor_particles: plain(d.aqOutdoorParticles),
    // outdoor dehum demand, %
    sp_dehum_demand_pct: halfPercent(d.ctOutdoorDeHumidificationRequestedDemand),
    // control algorithm dehum demand, %
    sp_alg_dehum_demand: halfPercent(d.ctControlAlgorithmDehumDemand),
    // overcool-to-dehumidify demand, %
    sp_alg_overcool_demand: halfPercent(d.ctControlAlgorithmOvercoolDemand),
    // control algorithm cool demand, %; context for the dehum figures
    sp_alg_cool_demand: halfPercent(d.ctControlAlgorithmCoolDemand),
    // commanded indoor CFM; compare against sp_indoor_airflow
    sp_requested_airflow: plain(d.ctOutdoorRequestedIndoorAirflow),
    // actual indoor fan output, %
    sp_fan_actual_pct: halfPercent(d.ctIFCCurrentFanActualStatus),
    // compressor reduction mode, enum
    sp_compressor_reduction: plain(d.ctOutdoorCompressorReductionMode),
    // 0 = none
    sp_fault_od_critical: plain(d.ctOutdoorCriticalFault),
    // 0 = none
    sp_fault_od_minor: plain(d.ctOutdoorMinorFault),
    // 0 = none
    sp_fault_ifc_critical: plain(d.ctIFCCriticalFault),
    // 0 = none
    sp_fault_ifc_minor: plain(d.ctIFCMinorFault),
    // 0 = none
    sp_fault_stat_critical: plain(d.ctStatCriticalFault),
    // 0 = none
    sp_fault_stat_minor: plain(d.ctStatMinorFault),
  };
}

export const SKYPORT_COLUMNS: readonly (keyof SkyportFields)[] = [
  'sp_outdoor_power',
  'sp_indoor_power',
  'sp_compressor_current',
  'sp_inverter_current',
  'sp_od_fan_current',
  'sp_compressor_runtime',
  'sp_compressor_rps',
  'sp_target_compressor_rps',
  'sp_frequency_pct',
  'sp_cool_demand_pct',
  'sp_fan_demand_pct',
  'sp_indoor_airflow',
  'sp_od_fan_rpm',
  'sp_od_fan_target',
  'sp_suction_temp',
  'sp_discharge_temp',
  'sp_od_coil_temp',
  'sp_od_liquid_temp',
  'sp_suction_pressure',
  'sp_eev_opening',
  'sp_inverter_fin_temp',
  'sp_eev_superheat',
  'sp_eev_suction_temp',
  'sp_eev_liquid_temp',
  'sp_reversing_valve',
  'sp_od_air_temp',
  'sp_hum_setpoint',
  'sp_dehum_setpoint',
  'sp_overcool_amount',
  'sp_zone1_damper',
  'sp_aq_outdoor_ozone',
  'sp_aq_outdoor_particles',
  'sp_dehum_demand_pct',
  'sp_alg_dehum_demand',
  'sp_alg_overcool_demand',
  'sp_alg_cool_demand',
  'sp_requested_airflow',
  'sp_fan_actual_pct',
  'sp_compressor_reduction',
  'sp_fault_od_critical',
  'sp_fault_od_minor',
  'sp_fault_ifc_critical',
  'sp_fault_ifc_minor',
  'sp_fault_stat_critical',
  'sp_fault_stat_minor',
] as const;

export { SENTINELS };
