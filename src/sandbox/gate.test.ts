import { describe, expect, it } from 'vitest';
import {
  AllowPatternError,
  blockedMessage,
  gateVerdict,
  isDeclaredReadOnly,
  matchesAllow,
  parseAllowPatterns,
  resolveAllowPatterns,
  type GatePolicy,
} from './gate.js';

const deny: GatePolicy = { allow: [], allowWrites: false, allowReadOnly: false };

/** The rules for `patterns` in a registry that holds `registered`. */
const rulesFor = (patterns: string[], registered: string[]) => resolveAllowPatterns(patterns, registered).rules;

describe('parseAllowPatterns', () => {
  it('splits repeated and comma-separated values and trims them', () => {
    expect(parseAllowPatterns(['a.x, b.y', 'c.*', '*.z'])).toEqual(['a.x', 'b.y', 'c.*', '*.z']);
  });

  it('ignores empty pieces', () => {
    expect(parseAllowPatterns(['', ' , a.x,,'])).toEqual(['a.x']);
    expect(parseAllowPatterns([])).toEqual([]);
  });

  it('treats *.* as *', () => {
    expect(parseAllowPatterns(['*.*'])).toEqual(['*']);
  });

  it.each(['onlyname', 'a*.tool', 'server.t*', '**', 'a.*.b', '.tool', 'server.', '*.', '.*'])(
    'rejects the unsupported pattern %s',
    (pattern) => {
      expect(() => parseAllowPatterns([pattern])).toThrow(/invalid --allow pattern/);
    },
  );

  it('accepts names that contain dots', () => {
    expect(parseAllowPatterns(['my.server.tool', 'my.server.*', '*.files.read'])).toEqual([
      'my.server.tool',
      'my.server.*',
      '*.files.read',
    ]);
  });
});

describe('matchesAllow', () => {
  // [pattern, registered servers, server of the call, tool of the call, allowed]
  const cases: Array<[string, string[], string, string, boolean]> = [
    ['fixture.echo', ['fixture', 'other'], 'fixture', 'echo', true],
    ['fixture.echo', ['fixture', 'other'], 'fixture', 'add', false],
    ['fixture.echo', ['fixture', 'other'], 'other', 'echo', false],
    ['fixture.*', ['fixture', 'fixture2', 'other'], 'fixture', 'anything', true],
    ['fixture.*', ['fixture', 'fixture2', 'other'], 'fixture2', 'anything', false],
    ['fixture.*', ['fixture', 'fixture2', 'other'], 'other', 'fixture', false],
    ['*.echo', ['fixture', 'other'], 'fixture', 'echo', true],
    ['*.echo', ['fixture', 'other'], 'other', 'echo', true],
    ['*.echo', ['fixture', 'other'], 'fixture', 'echo2', false],
    ['*', ['any'], 'any', 'thing', true],
    // names with dots: a wildcard matches the exact server or the exact tool
    ['a.*', ['a', 'a.b'], 'a.b', 'c', false],
    ['a.*', ['a', 'a.b'], 'a', 'b.c', true],
    ['a.b.*', ['a', 'a.b'], 'a.b', 'c', true],
    ['*.c', ['a', 'a.b'], 'a.b', 'c', true],
    ['*.b.c', ['a', 'a.b'], 'a', 'b.c', true],
    ['*.b.c', ['a', 'a.b'], 'a.b', 'c', false],
    // CHANGED: with only `a` registered the literal a.b.c means server a, tool b.c, and nothing else
    ['a.b.c', ['a'], 'a', 'b.c', true],
    ['a.b.c', ['a'], 'a.b', 'c', false],
    ['a.b.c', ['a'], 'a', 'b', false],
    // CHANGED: with only `a.b` registered it means server a.b, tool c (it used to allow server a, tool b.c as well)
    ['a.b.c', ['a.b'], 'a.b', 'c', true],
    ['a.b.c', ['a.b'], 'a', 'b.c', false],
    // CHANGED: a.b.* is server a.b, any tool; it no longer allows server a, tool "b.*"
    ['a.b.*', ['a', 'a.b'], 'a', 'b.*', false],
    ['a.b.*', ['a'], 'a', 'b.*', false],
    ['a.b.*', ['a'], 'a', 'b.x', false],
  ];
  it.each(cases)('pattern %s with servers %j against %s / %s is %s', (pattern, registered, server, tool, expected) => {
    expect(matchesAllow(rulesFor([pattern], registered), server, tool)).toBe(expected);
  });

  it('is false for no rules and true if any one matches', () => {
    expect(matchesAllow([], 'a', 'b')).toBe(false);
    expect(matchesAllow(rulesFor(['x.y', 'a.b'], ['x', 'a']), 'a', 'b')).toBe(true);
  });

  it('compares (server, tool) pairs, so a dot can never shift the boundary', () => {
    const rules = [{ server: 'a', tool: 'b.c' }];
    expect(matchesAllow(rules, 'a', 'b.c')).toBe(true);
    expect(matchesAllow(rules, 'a.b', 'c')).toBe(false);
    expect(matchesAllow([{ server: null, tool: 'c' }], 'a.b', 'c')).toBe(true);
    expect(matchesAllow([{ server: 'a', tool: null }], 'a.b', 'c')).toBe(false);
  });
});

describe('resolveAllowPatterns', () => {
  it('uses the one reading whose server is registered', () => {
    expect(resolveAllowPatterns(['a.b.c'], ['a']).rules).toEqual([{ server: 'a', tool: 'b.c' }]);
    expect(resolveAllowPatterns(['a.b.c'], ['a.b']).rules).toEqual([{ server: 'a.b', tool: 'c' }]);
    expect(resolveAllowPatterns(['a.b.c'], ['a', 'unrelated']).warnings).toEqual([]);
  });

  it('refuses a pattern with two registered readings, naming both', () => {
    expect(() => resolveAllowPatterns(['a.b.c'], ['a', 'a.b'])).toThrow(AllowPatternError);
    expect(() => resolveAllowPatterns(['a.b.c'], ['a', 'a.b'])).toThrow(
      /ambiguous.*server "a", tool "b\.c" or server "a\.b", tool "c"/,
    );
  });

  it('keeps the first-dot reading, which matches nothing, and warns once, when no server is registered', () => {
    const { rules, warnings } = resolveAllowPatterns(['a.b.c'], ['x']);
    expect(rules).toEqual([{ server: 'a', tool: 'b.c' }]);
    expect(warnings).toEqual(['warning: --allow pattern "a.b.c" matches no registered server']);
    expect(matchesAllow(rules, 'x', 'b.c')).toBe(false);
  });

  it('warns for a server wildcard naming no registered server, and for nothing else', () => {
    expect(resolveAllowPatterns(['ghost.*'], ['a']).warnings).toEqual(['warning: --allow pattern "ghost.*" matches no registered server']);
    expect(resolveAllowPatterns(['a.*', '*.t', '*'], ['a']).warnings).toEqual([]);
    expect(resolveAllowPatterns(['ghost.t', 'a.t'], ['a']).warnings).toHaveLength(1);
  });

  it('keeps a tool-wildcard tool whole, dots included', () => {
    expect(resolveAllowPatterns(['*.b.c'], ['a']).rules).toEqual([{ server: null, tool: 'b.c' }]);
  });

  it('resolves every pattern independently, in order', () => {
    expect(resolveAllowPatterns(['a.x', '*', 'b.*'], ['a', 'b']).rules).toEqual([
      { server: 'a', tool: 'x' },
      { server: null, tool: null },
      { server: 'b', tool: null },
    ]);
  });

  // The names of the report: servers `a` and `a.b`, tools `b.c` (on a) and `c` (on a.b).
  describe('servers a and a.b, tools b.c and c', () => {
    const registered = ['a', 'a.b'];
    const calls: Array<[string, string]> = [['a', 'b.c'], ['a.b', 'c']];
    const allowed = (pattern: string) => calls.filter(([server, tool]) => matchesAllow(rulesFor([pattern], registered), server, tool));

    it('a.* allows only server a', () => expect(allowed('a.*')).toEqual([['a', 'b.c']]));
    it('a.b.* allows only server a.b', () => expect(allowed('a.b.*')).toEqual([['a.b', 'c']]));
    it('*.c allows the tool c wherever it is', () => expect(allowed('*.c')).toEqual([['a.b', 'c']]));
    it('*.b.c allows the tool b.c wherever it is', () => expect(allowed('*.b.c')).toEqual([['a', 'b.c']]));
    it('a.b.c is refused as ambiguous', () => expect(() => allowed('a.b.c')).toThrow(AllowPatternError));
    it('* allows both', () => expect(allowed('*')).toEqual(calls));
  });
});

describe('gateVerdict', () => {
  it('denies by default', () => {
    expect(gateVerdict(deny, 'a', 'b')).toBe('deny');
  });

  it('allows a matching pattern and denies the rest', () => {
    const policy = { ...deny, allow: rulesFor(['a.b'], ['a']) };
    expect(gateVerdict(policy, 'a', 'b')).toBe('allow');
    expect(gateVerdict(policy, 'a', 'c')).toBe('deny');
  });

  it('allows everything with allowWrites', () => {
    expect(gateVerdict({ ...deny, allowWrites: true }, 'any', 'thing')).toBe('allow');
  });

  it('asks for the read-only hint with allowReadOnly, unless a pattern already allows the call', () => {
    const policy = { ...deny, allowReadOnly: true, allow: rulesFor(['a.b'], ['a']) };
    expect(gateVerdict(policy, 'a', 'c')).toBe('check-read-only');
    expect(gateVerdict(policy, 'a', 'b')).toBe('allow');
  });
});

describe('isDeclaredReadOnly', () => {
  it('needs an explicit readOnlyHint: true', () => {
    expect(isDeclaredReadOnly({ readOnlyHint: true })).toBe(true);
    expect(isDeclaredReadOnly({ readOnlyHint: false })).toBe(false);
    expect(isDeclaredReadOnly({ destructiveHint: false })).toBe(false);
    expect(isDeclaredReadOnly({})).toBe(false);
    expect(isDeclaredReadOnly(undefined)).toBe(false);
  });
});

describe('blockedMessage', () => {
  it('names the tool and the three ways to allow it', () => {
    expect(blockedMessage('fixture', 'write_note')).toBe(
      'mcpkit: blocked fixture.write_note (not allowed). Re-run with --allow fixture.write_note, '
        + '--allow-read-only (if the server marks it read-only) or --allow-writes.',
    );
  });
});
