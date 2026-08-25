import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { aliasOf, buildAirSelects, buildSelects, skyportSelectClause } from '../src/db/repo';
import { toFields } from '../src/api/query';
import { SKYPORT_COLUMNS } from '../src/skyport/map';

describe('skyportSelectClause', () => {
  // The builders return one expression per element so getSeries can drop the
  // ones a caller did not ask for; these assertions read the joined form.
  const clause = skyportSelectClause().join(',\n');

  it('projects every Skyport column, and the spiky ones twice', () => {
    // Outdoor ozone and particulates get a _max alongside the mean, so a
    // short excursion is not averaged out of existence at wide zoom.
    const spiky = ['sp_aq_outdoor_ozone', 'sp_aq_outdoor_particles'];
    const aliases = skyportSelectClause().map(aliasOf);
    for (const c of SKYPORT_COLUMNS) {
      const hit = aliases.filter((a) => a === c || a === `${c}_f`
        || a === `${c}_a` || a === `${c}_raw`);
      expect(hit.length, c).toBe(1);
    }
    for (const c of spiky) expect(aliases, c).toContain(`${c}_max`);
    expect((clause.match(/ AS sp_/g) ?? []).length)
      .toBe(SKYPORT_COLUMNS.length + spiky.length);
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

describe('field selection', () => {
  const all = buildSelects();

  it('every select expression carries a parseable alias', () => {
    // getSeries filters on these, so an expression whose alias cannot be read
    // would silently vanish whenever a caller named its columns.
    for (const e of all) expect(aliasOf(e), e.slice(0, 60)).not.toBeNull();
  });

  it('aliases are unique, so a name selects exactly one column', () => {
    const names = all.map(aliasOf);
    expect(new Set(names).size).toBe(names.length);
  });

  it('holds no bind placeholders, so filtering cannot shift arguments', () => {
    // Positional parameters bind by their order in the statement text. If the
    // select list contained any, dropping a column would move every later
    // argument onto the wrong slot -- which is exactly how the bucket
    // interpolation earned its place.
    for (const e of all) expect(e).not.toContain('?');
  });

  it('covers every column the generated dashboards ask for', () => {
    const emitted = new Set([...all.map(aliasOf), 'ts', 'samples', 'device_id']);
    for (const f of readdirSync('grafana')) {
      if (!f.startsWith('dashboard-') || !f.endsWith('.json')) continue;
      const dash = JSON.parse(readFileSync(`grafana/${f}`, 'utf-8')) as {
        panels?: Array<{ targets?: Array<{ url?: string; columns?: Array<{ selector: string }> }> }>;
      };
      for (const p of dash.panels ?? []) {
        const t = p.targets?.[0];
        if (!t?.url?.includes('/api/series')) continue;
        for (const c of t.columns ?? []) {
          if (c.selector === 'time' || c.selector === 'ts_ms') continue;
          expect(emitted.has(c.selector), `${f}: ${c.selector}`).toBe(true);
        }
      }
    }
  });
});

describe('toFields', () => {
  it('returns undefined when absent or empty, meaning all columns', () => {
    expect(toFields(null)).toBeUndefined();
    expect(toFields('')).toBeUndefined();
    expect(toFields('  ')).toBeUndefined();
  });

  it('parses and trims a comma list', () => {
    expect(toFields('indoor_f, outdoor_f')).toEqual(new Set(['indoor_f', 'outdoor_f']));
  });

  it('drops anything not identifier-shaped', () => {
    // The value is matched against SQL aliases, so nothing that could be SQL
    // is allowed to survive parsing.
    expect(toFields('indoor_f, 1;DROP TABLE readings, a-b')).toEqual(new Set(['indoor_f']));
  });

  it('falls back to all columns rather than none when wholly junk', () => {
    expect(toFields(';;;')).toBeUndefined();
  });
});

describe('air series selection', () => {
  const all = buildAirSelects();

  it('every expression has a unique, parseable alias', () => {
    const names = all.map(aliasOf);
    for (const [i, n] of names.entries()) expect(n, all[i]).not.toBeNull();
    expect(new Set(names).size).toBe(names.length);
  });

  it('holds no bind placeholders', () => {
    for (const e of all) expect(e).not.toContain('?');
  });

  it('buckets by the requested interval rather than the raw timestamp', () => {
    // Regression: while the bucket was a bound parameter, /api/air grouped by
    // raw ts and returned every 5-minute sample whatever interval Grafana
    // asked for -- which is what made it the most CPU-hungry route.
    const body = readFileSync('src/db/repo.ts', 'utf-8');
    const fn = body.slice(body.indexOf('export async function getAirSeries'));
    const sql = fn.slice(0, fn.indexOf('\n}'));
    expect(sql).toContain('GROUP BY (ts / ${bucket})');
    expect(sql).not.toContain('GROUP BY (ts / ?)');
    expect(sql).toContain('args: [o.fromTs, o.toTs, o.limit]');
  });
});
