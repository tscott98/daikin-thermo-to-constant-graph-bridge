import { describe, it, expect } from 'vitest';
import { skyportSelectClause } from '../src/db/repo';
import { SKYPORT_COLUMNS } from '../src/skyport/map';

describe('skyportSelectClause', () => {
  const clause = skyportSelectClause();

  it('projects every Skyport column exactly once', () => {
    for (const col of SKYPORT_COLUMNS) {
      expect(clause).toContain(`AS ${col}`);
    }
    expect((clause.match(/ AS sp_/g) ?? []).length).toBe(SKYPORT_COLUMNS.length);
  });

  it('averages continuous measurements', () => {
    expect(clause).toMatch(/ROUND\(AVG\(sp_outdoor_power\), 2\) AS sp_outdoor_power/);
    expect(clause).toMatch(/ROUND\(AVG\(sp_suction_temp\), 2\) AS sp_suction_temp/);
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
});
