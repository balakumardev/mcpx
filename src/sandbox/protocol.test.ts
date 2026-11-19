import { describe, expect, it } from 'vitest';
import { MAX_ARGS_BYTES, MAX_LOG_LINE_CHARS, MAX_NAME_CHARS } from './limits.js';
import { ProtocolError, parseChildMessage, parseParentMessage } from './protocol.js';

const limits = { maxOutputBytes: 1000 };
const parse = (raw: unknown) => parseChildMessage(raw, limits);

describe('parseChildMessage', () => {
  it('accepts the three message types', () => {
    expect(parse({ type: 'log', line: 'hello' })).toEqual({ type: 'log', line: 'hello' });
    expect(parse({ type: 'call', id: 0, server: 'fx', tool: 'echo', args: '{"a":1}' })).toEqual({
      type: 'call',
      id: 0,
      server: 'fx',
      tool: 'echo',
      args: '{"a":1}',
    });
    expect(parse({ type: 'done', ok: true, result: '42', resultTruncated: false, resultBytes: 2 })).toEqual({
      type: 'done',
      ok: true,
      result: '42',
      resultTruncated: false,
      resultBytes: 2,
    });
    expect(parse({ type: 'done', ok: false, error: { kind: 'tool', message: 'boom', tool: 'fx.fail' } })).toEqual({
      type: 'done',
      ok: false,
      error: { kind: 'tool', message: 'boom', tool: 'fx.fail' },
    });
  });

  it('drops fields it does not know', () => {
    const message = parse({ type: 'log', line: 'x', extra: 'ignored', __proto__: { polluted: true } });
    expect(message).toEqual({ type: 'log', line: 'x' });
  });

  it.each([
    ['null', null],
    ['a string', 'log'],
    ['a number', 7],
    ['an array', [{ type: 'log', line: 'x' }]],
    ['an object without a type', { line: 'x' }],
    ['an unknown type', { type: 'exec', line: 'x' }],
    ['a type that is not a string', { type: 5 }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parse(raw)).toThrow(ProtocolError);
  });

  it.each([
    ['a log line that is not a string', { type: 'log', line: 5 }],
    ['a log line without text', { type: 'log' }],
    ['a log line over the cap', { type: 'log', line: 'x'.repeat(MAX_LOG_LINE_CHARS + 1) }],
    ['a call without an id', { type: 'call', server: 'a', tool: 'b', args: '{}' }],
    ['a negative id', { type: 'call', id: -1, server: 'a', tool: 'b', args: '{}' }],
    ['a fractional id', { type: 'call', id: 1.5, server: 'a', tool: 'b', args: '{}' }],
    ['a string id', { type: 'call', id: '1', server: 'a', tool: 'b', args: '{}' }],
    ['a huge id', { type: 'call', id: 2 ** 60, server: 'a', tool: 'b', args: '{}' }],
    ['an empty server', { type: 'call', id: 1, server: '', tool: 'b', args: '{}' }],
    ['an empty tool', { type: 'call', id: 1, server: 'a', tool: '', args: '{}' }],
    ['a non-string server', { type: 'call', id: 1, server: { toString: 'x' }, tool: 'b', args: '{}' }],
    ['a server name over the cap', { type: 'call', id: 1, server: 'a'.repeat(MAX_NAME_CHARS + 1), tool: 'b', args: '{}' }],
    ['args that are not a string', { type: 'call', id: 1, server: 'a', tool: 'b', args: {} }],
    ['args over 1 MB', { type: 'call', id: 1, server: 'a', tool: 'b', args: 'x'.repeat(MAX_ARGS_BYTES + 1) }],
    ['args over 1 MB once encoded as UTF-8', { type: 'call', id: 1, server: 'a', tool: 'b', args: '€'.repeat(MAX_ARGS_BYTES / 2) }],
    ['done without ok', { type: 'done', result: '1' }],
    ['done with a result that is not text', { type: 'done', ok: true, result: 1, resultTruncated: false, resultBytes: 1 }],
    ['done with a result over the output limit', { type: 'done', ok: true, result: 'x'.repeat(1001), resultTruncated: false, resultBytes: 1001 }],
    ['done with a multi-byte result over the output limit', { type: 'done', ok: true, result: '€'.repeat(400), resultTruncated: false, resultBytes: 1200 }],
    ['done without the truncation flag', { type: 'done', ok: true, result: '1', resultBytes: 1 }],
    ['done with a negative size', { type: 'done', ok: true, result: '1', resultTruncated: false, resultBytes: -1 }],
    ['a failure without an error', { type: 'done', ok: false }],
    ['a failure with an unknown kind', { type: 'done', ok: false, error: { kind: 'root', message: 'x' } }],
    ['a failure with a non-string message', { type: 'done', ok: false, error: { kind: 'tool', message: { a: 1 } } }],
    ['a failure with a huge message', { type: 'done', ok: false, error: { kind: 'tool', message: 'x'.repeat(100_000) } }],
    ['a failure with a non-string tool', { type: 'done', ok: false, error: { kind: 'tool', message: 'x', tool: 5 } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parse(raw)).toThrow(ProtocolError);
  });

  it('accepts args exactly at the cap', () => {
    const args = 'x'.repeat(MAX_ARGS_BYTES);
    expect(parse({ type: 'call', id: 1, server: 'a', tool: 'b', args })).toMatchObject({ type: 'call' });
  });
});

describe('parseParentMessage', () => {
  const runLimits = { timeoutMs: 1000, memoryMb: 64, maxOutputBytes: 1000, maxCalls: 5 };

  it('accepts run and call-result messages', () => {
    expect(parseParentMessage({ type: 'run', code: 'return 1', limits: runLimits, deadline: 1_800_000_000_000 })).toEqual({
      type: 'run',
      code: 'return 1',
      limits: runLimits,
      deadline: 1_800_000_000_000,
    });
    expect(parseParentMessage({ type: 'call-result', id: 3, ok: true, json: '1' })).toEqual({
      type: 'call-result',
      id: 3,
      ok: true,
      json: '1',
    });
    expect(parseParentMessage({ type: 'call-result', id: 3, ok: false, error: { kind: 'blocked', message: 'no' } })).toEqual({
      type: 'call-result',
      id: 3,
      ok: false,
      error: { kind: 'blocked', message: 'no' },
    });
  });

  it.each([
    ['a non-object', 'run'],
    ['an unknown type', { type: 'log' }],
    ['a run without code', { type: 'run', limits: runLimits }],
    ['a run without limits', { type: 'run', code: '1' }],
    ['a run with bad limits', { type: 'run', code: '1', limits: { ...runLimits, timeoutMs: -1 } }],
    ['a call-result without an id', { type: 'call-result', ok: true, json: '1' }],
    ['a call-result without json', { type: 'call-result', id: 1, ok: true }],
    ['a failed call-result without an error', { type: 'call-result', id: 1, ok: false }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseParentMessage(raw)).toThrow(ProtocolError);
  });
});

describe('what the sandbox may say about cut logs and ignored calls', () => {
  const ok = { type: 'done', ok: true, result: '1', resultTruncated: false, resultBytes: 1 };

  it('accepts a logs-cut notice', () => {
    expect(parse({ type: 'logs-cut', extra: 1 })).toEqual({ type: 'logs-cut' });
  });

  it('accepts a log account and warnings on a done message, and leaves them out when absent', () => {
    const logs = { droppedLines: 3, shortenedLines: 1, removedBytes: 900 };
    expect(parse({ ...ok, logs, warnings: ['a', 'b'] })).toMatchObject({ logs, warnings: ['a', 'b'] });
    expect(parse(ok)).not.toHaveProperty('logs');
    expect(parse(ok)).not.toHaveProperty('warnings');
    expect(parse({ type: 'done', ok: false, error: { kind: 'script', message: 'x' }, logs })).toMatchObject({ logs });
  });

  it.each([
    ['a log account that is not an object', { logs: 5 }],
    ['a negative count', { logs: { droppedLines: -1, shortenedLines: 0, removedBytes: 0 } }],
    ['a fractional count', { logs: { droppedLines: 0, shortenedLines: 0.5, removedBytes: 0 } }],
    ['a missing count', { logs: { droppedLines: 0, shortenedLines: 0 } }],
    ['warnings that are not an array', { warnings: 'x' }],
    ['a warning that is not a string', { warnings: [1] }],
    ['more than 20 warnings', { warnings: Array.from({ length: 21 }, () => 'x') }],
  ])('rejects %s', (_label, extra) => {
    expect(() => parse({ ...ok, ...extra })).toThrow(ProtocolError);
  });

  it('never accepts the kind "interrupted" from the sandbox: it is the parent\'s own verdict', () => {
    expect(() => parse({ type: 'done', ok: false, error: { kind: 'interrupted', message: 'x' } })).toThrow(/not a known kind/);
    expect(() => parseParentMessage({ type: 'call-result', id: 1, ok: false, error: { kind: 'interrupted', message: 'x' } })).toThrow(ProtocolError);
  });

  it('requires the deadline in a run request', () => {
    const run = { type: 'run', code: 'return 1', limits: { timeoutMs: 1, memoryMb: 8, maxOutputBytes: 256, maxCalls: 1 } };
    expect(() => parseParentMessage(run)).toThrow(/deadline/);
    expect(() => parseParentMessage({ ...run, deadline: -5 })).toThrow(ProtocolError);
  });
});
