import { describe, expect, it } from 'vitest';
import { LogBuffer } from './limits.js';

describe('LogBuffer', () => {
  it('keeps lines that fit and reports nothing cut', () => {
    const buffer = new LogBuffer(100);
    expect(buffer.add('hello')).toBe('hello');
    expect(buffer.truncated).toBe(false);
    expect(buffer.result()).toEqual(['hello']);
    expect(buffer.account).toEqual({ droppedLines: 0, shortenedLines: 0, removedBytes: 0 });
  });

  it('shortens the line that crosses the budget, then drops the rest, and counts both', () => {
    const buffer = new LogBuffer(10);
    expect(buffer.add('12345678')).toBe('12345678');
    expect(buffer.add('abcdefgh')).toBe('ab');
    expect(buffer.add('more')).toBeUndefined();
    expect(buffer.add('again')).toBeUndefined();
    expect(buffer.truncated).toBe(true);
    expect(buffer.account).toEqual({ droppedLines: 2, shortenedLines: 1, removedBytes: 6 + 4 + 5 });
    expect(buffer.result()).toEqual([
      '12345678',
      'ab',
      '[logs truncated: the limit is 10 bytes; 2 line(s) dropped, 1 line(s) shortened, about 15 byte(s) removed in all]',
    ]);
  });

  it('drops a line that does not fit at all without calling it shortened', () => {
    const buffer = new LogBuffer(5);
    buffer.add('12345');
    expect(buffer.add('x')).toBeUndefined();
    expect(buffer.account).toEqual({ droppedLines: 1, shortenedLines: 0, removedBytes: 1 });
  });

  it('counts the part of a line that the caller already cut off', () => {
    const buffer = new LogBuffer(100);
    expect(buffer.add('abc', 1000)).toBe('abc');
    expect(buffer.truncated).toBe(true);
    expect(buffer.account).toEqual({ droppedLines: 0, shortenedLines: 1, removedBytes: 997 });
  });

  it('keeps a multi-byte character whole at the budget', () => {
    const buffer = new LogBuffer(4);
    expect(buffer.add('aéé')).toBe('aé');
    expect(buffer.account.removedBytes).toBe(2);
  });

  it('adds the counts the sandbox reports, and then the marker states them', () => {
    const buffer = new LogBuffer(50);
    buffer.add('kept');
    buffer.noteCut();
    expect(buffer.truncated).toBe(true);
    expect(buffer.result().at(-1)).toBe('[logs truncated: the limit is 50 bytes; some lines were cut before the sandbox could count them]');
    buffer.absorb({ droppedLines: 10, shortenedLines: 2, removedBytes: 700 });
    expect(buffer.result().at(-1)).toBe('[logs truncated: the limit is 50 bytes; 10 line(s) dropped, 2 line(s) shortened, about 700 byte(s) removed in all]');
  });

  it('ignores a cut notice once it has counted something itself', () => {
    const buffer = new LogBuffer(3);
    buffer.add('abcdef');
    buffer.noteCut();
    expect(buffer.result().at(-1)).toContain('1 line(s) shortened');
  });
});
