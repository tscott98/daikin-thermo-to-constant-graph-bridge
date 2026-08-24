import { describe, it, expect } from 'vitest';
import { EMPTY_SKYPORT, SKYPORT_COLUMNS, skyportFields } from '../src/skyport/map';
import { SENTINELS, deciwatts, halfPercent, plain } from '../src/skyport/types';

// Values observed from a real ONETOUCH probe, so these double as a record of
// what the hardware actually reports.
const PROBE = {
  ctOutdoorPower: 263,
  ctIndoorPower: 850,
  ctCompressorCurrent: 94,
  ctOutdoorCompressorRunTime: 9331,
  ctCurrentCompressorRPS: 68,
  ctOutdoorFrequencyInPercent: 192,
  ctOutdoorCoolRequestedDemand: 192,
  ctIFCFanRequestedDemandPercent: 72,
  ctIFCIndoorBlowerAirflow: 633,
  ctOutdoorDischargeTemperature: 1630,
  ctOutdoorSuctionPressure: 105,
  overcoolAmount: 1.1,
  dehumSP: 50,
  ctOutdoorCriticalFault: 0,
  ctOutdoorDeHumidificationRequestedDemand: 0,
  ctControlAlgorithmDehumDemand: 200,
  ctControlAlgorithmOvercoolDemand: 200,
  ctOutdoorRequestedIndoorAirflow: 630,
  ctIFCCurrentFanActualStatus: 72,
  ctOutdoorCompressorReductionMode: 1,
};

describe('sentinel handling', () => {
  it('treats not-applicable markers as null, not as data', () => {
    // 255 through a half-percent conversion would otherwise read as 127.5%.
    for (const s of SENTINELS) {
      expect(plain(s)).toBeNull();
      expect(halfPercent(s)).toBeNull();
      expect(deciwatts(s)).toBeNull();
    }
  });

  it('keeps genuine zeros, which are not sentinels', () => {
    expect(plain(0)).toBe(0);
    expect(halfPercent(0)).toBe(0);
  });

  it('nulls missing and non-numeric input', () => {
    for (const f of [plain, halfPercent, deciwatts]) {
      expect(f(undefined)).toBeNull();
      expect(f(null)).toBeNull();
      expect(f('68')).toBeNull();
      expect(f(Number.NaN)).toBeNull();
    }
  });
});

describe('conversions', () => {
  it('converts half-percent steps', () => {
    expect(halfPercent(192)).toBe(96);
    expect(halfPercent(200)).toBe(100);
    expect(halfPercent(72)).toBe(36);
  });

  it('converts deciwatts to watts', () => {
    expect(deciwatts(263)).toBe(2630);
  });
});

describe('skyportFields', () => {
  it('maps the observed probe response', () => {
    const f = skyportFields(PROBE);
    expect(f.sp_outdoor_power).toBe(2630);
    expect(f.sp_frequency_pct).toBe(96);
    expect(f.sp_cool_demand_pct).toBe(96);
    expect(f.sp_fan_demand_pct).toBe(36);
    expect(f.sp_compressor_rps).toBe(68);
    expect(f.sp_compressor_runtime).toBe(9331);
    expect(f.sp_indoor_airflow).toBe(633);
    expect(f.sp_discharge_temp).toBe(1630);
    expect(f.sp_overcool_amount).toBe(1.1);
    expect(f.sp_fault_od_critical).toBe(0);
  });

  it('nulls a field the hardware reports as unavailable', () => {
    // 65535 airflow means no air-handler sensor, not 65535 CFM.
    expect(skyportFields({ ctIFCIndoorBlowerAirflow: 65535 }).sp_indoor_airflow).toBeNull();
    expect(
      skyportFields({ ctOutdoorCompressorRunTime: 4294967295 }).sp_compressor_runtime,
    ).toBeNull();
  });

  it('nulls everything for an empty response rather than throwing', () => {
    const f = skyportFields({});
    expect(Object.values(f).every((v) => v === null)).toBe(true);
    expect(f).toEqual(EMPTY_SKYPORT);
  });

  it('ignores the other ~1540 fields the API returns', () => {
    const f = skyportFields({ schedMonPart2csp: 25.6, P1P2FloatOnOff: 1, statType: 'production' });
    expect(Object.values(f).every((v) => v === null)).toBe(true);
  });

  it('exports one column name per mapped field', () => {
    expect(SKYPORT_COLUMNS).toHaveLength(Object.keys(EMPTY_SKYPORT).length);
    expect(new Set(SKYPORT_COLUMNS).size).toBe(SKYPORT_COLUMNS.length);
  });
});

describe('dehumidification chain', () => {
  it('maps the fields that answer whether dehum is ever requested', () => {
    const f = skyportFields(PROBE);
    // Zero here is the finding, not a missing value: it means the equipment
    // never asked for dehumidification, which no airflow tuning can fix.
    expect(f.sp_dehum_demand_pct).toBe(0);
    expect(f.sp_alg_dehum_demand).toBe(100);
    expect(f.sp_alg_overcool_demand).toBe(100);
  });

  it('keeps commanded airflow separate from actual', () => {
    const f = skyportFields(PROBE);
    expect(f.sp_requested_airflow).toBe(630);
    expect(f.sp_indoor_airflow).toBe(633);
  });

  it('scales fan output but not the discrete reduction mode', () => {
    const f = skyportFields(PROBE);
    expect(f.sp_fan_actual_pct).toBe(36);
    expect(f.sp_compressor_reduction).toBe(1);
  });
});
