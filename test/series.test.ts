import { describe, it, expect } from 'vitest';
import { skyportSelectClause } from '../src/db/repo';
import { SKYPORT_COLUMNS } from '../src/skyport/map';

describe('skyportSelectClause', () => {
  const clause = skyportSelectClause();

  it('projects every Skyport column exactly once', () => {
    expect((clause.match(/ AS sp_/g) ?? []).length).toBe(SKYPORT_COLUMNS.length);
  });

  it('averages continuous measurements that need no conversion', () => {
    expect(clause).toMatch(/ROUND\(AVG\(sp_outdoor_power\), 2\) AS sp_outdoor_power/);
    expect(clause).toMatch(/ROUND\(AVG\(sp_compressor_rps\), 2\) AS sp_compressor_rps/);
  });

  it('takes MAX for the cumulative runtime counter', () => {
    // Averaging a monotonic counter across a bucket is meaningless; MAX gives
    // the total as of the bucket end, which a client can difference.
    expect(clause).toContain('MAX(sp_compressor_runtime) AS sp_compressor_runtime');
  });

  it('takes MAX for every fault code, so a fault is never averaged away', () => {
    for (const col of SKYPORT_COLUMNS.filter((c) => c.startsWith('sp_fault_'))) {
      expect(clause).toContain(`MAX(${col}) AS ${col}`);
    }
  });

  it('takes MAX for the discrete reversing-valve state', () => {
    expect(clause).toContain('MAX(sp_reversing_valve) AS sp_reversing_valve');
  });

  describe('unit conversion', () => {
    const tenthsF = [
      'sp_od_air_temp',
      'sp_suction_temp',
      'sp_discharge_temp',
      'sp_od_coil_temp',
      'sp_od_liquid_temp',
      'sp_eev_suction_temp',
      'sp_eev_liquid_temp',
    ];

    it('converts tenths-of-Fahrenheit columns and marks them _f', () => {
      for (const col of tenthsF) {
        expect(clause).toContain(`ROUND(AVG(${col}) / 10.0, 1) AS ${col}_f`);
      }
    });

    it('converts deciamp columns and marks them _a', () => {
      for (const col of ['sp_compressor_current', 'sp_inverter_current', 'sp_od_fan_current']) {
        expect(clause).toContain(`ROUND(AVG(${col}) / 10.0, 2) AS ${col}_a`);
      }
    });

    it('marks uncalibrated columns _raw rather than guessing a scale', () => {
      // Guessing these into a plausible-looking unit is exactly how the 255
      // sentinel and the equipment-status enum went wrong.
      for (const col of ['sp_eev_superheat', 'sp_inverter_fin_temp', 'sp_indoor_power']) {
        expect(clause).toContain(`AS ${col}_raw`);
        expect(clause).not.toContain(`AS ${col}_f`);
      }
    });

    it('never converts a column twice or leaves one unsuffixed by mistake', () => {
      for (const col of tenthsF) {
        // The bare alias must not also appear, which would mean two columns
        // with the same data at different scales.
        expect(clause).not.toMatch(new RegExp(`AS ${col}(?![_a-z])`));
      }
    });
  });
});

describe('getSeries column qualification', () => {
  it('qualifies every readings column that air_quality also has', async () => {
    // air_quality carries its own ts, so once /api/series LEFT JOINs it any
    // bare `ts` is ambiguous and SQLite rejects the whole statement. That broke
    // every /api/series panel at once and typechecking could not see it.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/db/repo.ts', 'utf8'),
    );
    const start = src.indexOf('export async function getSeries');
    const body = src.slice(start, src.indexOf('return res.rows;', start));

    expect(body).toContain('LEFT JOIN air_quality aq ON aq.ts = r.ts');
    // A bare `ts` used as a column reference is the bug. `AS ts` is an output
    // alias, not a reference, so it is excluded.
    const bare = body.match(/(?<!AS )(?<![.\w])ts\s*(?:\/|>=|<=|ASC)/g) ?? [];
    expect(bare).toEqual([]);
    expect(body).toContain("const where = ['r.ts >= ?', 'r.ts <= ?'];");
  });
});
