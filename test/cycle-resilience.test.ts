import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * On 2026-08-28 the bridge stopped writing for 6h40m. readings and air_quality
 * had identical gap boundaries to the minute, and /health answered normally
 * throughout -- so neither Turso nor the Worker was down. The cause was the
 * first await in runCycle being unguarded: one Daikin failure threw past the
 * AirGradient read, both inserts and the publish.
 *
 * These assert the shape that prevents it, rather than the behaviour, because
 * the alternative is standing up a fake Daikin API and a fake Turso to observe
 * a try/catch. The shape is what regressed and the shape is cheap to check.
 */
describe('runCycle failure isolation', () => {
  const src = readFileSync('src/cycle.ts', 'utf-8');
  const body = src.slice(src.indexOf('export async function runCycle'));

  it('guards the device fetch, the first await in the cycle', () => {
    const i = body.indexOf('daikin.getDevices()');
    expect(i, 'getDevices call not found').toBeGreaterThan(-1);
    // The nearest preceding block opener must be a try.
    const before = body.slice(0, i);
    expect(before.lastIndexOf('try {')).toBeGreaterThan(before.lastIndexOf('} catch'));
  });

  it('captures air quality downstream of the Daikin read, not conditional on it', () => {
    // The point of the fix: a dead thermostat must not cost the air sensor.
    expect(body.indexOf('insertAirQuality')).toBeGreaterThan(body.indexOf('getDevices'));
  });

  it('leaves no unguarded await between the cycle start and the inserts', () => {
    const upTo = body.slice(0, body.indexOf('insertAirQuality'));
    // Comments mention await freely; only code lines count.
    const lines = upTo.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
    let depth = 0;
    const naked: string[] = [];
    for (const ln of lines) {
      if (/\btry\s*\{/.test(ln)) depth++;
      if (/^\s*\}\s*catch/.test(ln)) depth--;
      if (depth === 0 && /\bawait\b/.test(ln)) naked.push(ln.trim().slice(0, 70));
    }
    expect(naked, 'unguarded awaits would take the whole cycle down').toEqual([]);
  });
});
