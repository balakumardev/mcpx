import { describe, expect, it } from 'vitest';
import type { ExecEnvelope } from '../sandbox/host.js';
import { envelopeLine } from './exec.js';

const [NEL, LS, PS] = [0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code));

/** Every character that ends a line for some reader: \n, \r, \v, \f, FS, GS, RS, NEL, LS and PS. */
const LINE_BREAKS = new RegExp(`[\n\r\v\f\x1c\x1d\x1e${NEL}${LS}${PS}]`);

const envelope = (result: unknown, logs: string[] = []): ExecEnvelope => ({
  ok: true,
  result,
  logs,
  calls: 0,
  blocked: [],
  truncated: false,
});

describe('envelopeLine', () => {
  it('is one line for every reader, and parses back to the same value', () => {
    const value = envelope(`a${LS}b${PS}c${NEL}d\n\r\v\f\x1c\x1d\x1e`, [`log${LS}${NEL}`]);
    const line = envelopeLine(value);
    expect(LINE_BREAKS.test(line)).toBe(false);
    expect(JSON.parse(line)).toEqual(value);
  });

  it('writes the three characters JSON.stringify leaves raw as \\u escapes', () => {
    const line = envelopeLine(envelope(`${NEL}${LS}${PS}`));
    expect(line).toContain('"result":"\\u0085\\u2028\\u2029"');
  });

  it('leaves everything else as JSON.stringify writes it', () => {
    const value = envelope({ text: 'plain é 中', list: [1, null, true] });
    expect(envelopeLine(value)).toBe(JSON.stringify(value));
  });
});
