import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildCallExample, buildExampleArgs, callLine, shellQuote } from './example-args.js';

/** The example value of one required property named `name` with the given schema. */
function example(schema: unknown, name = 'name', extra: Record<string, unknown> = {}): unknown {
  return buildExampleArgs({ type: 'object', properties: { [name]: schema }, required: [name], ...extra })[name];
}

/** Characters in a value, counted the way JSON Schema counts them (code points). */
function length(value: unknown): number {
  return [...String(value)].length;
}

describe('buildExampleArgs', () => {
  it('builds typed placeholders for the required properties only', () => {
    expect(buildExampleArgs({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        ratio: { type: 'number', minimum: 1 },
        dry: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        opts: { type: 'object' },
        optional: { type: 'string' },
      },
      required: ['name', 'count', 'ratio', 'dry', 'tags', 'opts'],
    })).toEqual({ name: '<name>', count: 0, ratio: 1, dry: false, tags: [], opts: {} });
  });

  it('prefers const, then the first enum member, and the first non-null type of a type array', () => {
    expect(buildExampleArgs({
      type: 'object',
      properties: { a: { const: 'fixed' }, b: { enum: ['x', 'y'] }, c: { type: ['null', 'integer'] }, d: { type: 'string', enum: [] } },
      required: ['a', 'b', 'c', 'd'],
    })).toEqual({ a: 'fixed', b: 'x', c: 0, d: '<d>' });
  });

  it('follows $ref, takes the first anyOf branch and recurses into required nested properties', () => {
    expect(buildExampleArgs({
      type: 'object',
      properties: {
        label: { $ref: '#/$defs/Label' },
        either: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        nested: { type: 'object', properties: { inner: { type: 'string' }, skip: { type: 'string' } }, required: ['inner'] },
        broken: { $ref: 'https://example.com/x.json' },
      },
      required: ['label', 'either', 'nested', 'broken'],
      $defs: { Label: { enum: ['bug', 'feature'] } },
    })).toEqual({ label: 'bug', either: 0, nested: { inner: '<inner>' }, broken: '<broken>' });
  });

  it('falls back to a string placeholder for required names without a usable schema', () => {
    expect(buildExampleArgs({ type: 'object', required: ['ghost', 5, 'constructor'] })).toEqual({ ghost: '<ghost>', constructor: '<constructor>' });
    expect(buildExampleArgs(null)).toEqual({});
    expect(buildExampleArgs({ type: 'object' })).toEqual({});
  });

  it('stops recursing through self-referencing schemas', () => {
    const args = buildExampleArgs({
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      required: ['node'],
      $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } }, required: ['next'] } },
    });
    expect(JSON.stringify(args).length).toBeLessThan(200);
  });
});

describe('buildCallExample', () => {
  it('prints a ready mcpkit call with the JSON in single quotes', () => {
    expect(buildCallExample('github', 'create_issue', { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }))
      .toBe(`mcpkit call github create_issue '{"title":"<title>"}'`);
    expect(buildCallExample('github', 'list', { type: 'object' })).toBe(`mcpkit call github list '{}'`);
  });

  it('shell-quotes single quotes in the JSON and names that are not plain words', () => {
    const line = buildCallExample('my server', "it's", { type: 'object', properties: { "o'k": { const: "it's" } }, required: ["o'k"] });
    expect(line).toBe(`mcpkit call 'my server' 'it'\\''s' '{"o'\\''k":"it'\\''s"}'`);
  });

  it('keeps a name with line breaks or control characters on one line that the shell reads back as that name', () => {
    const server = 'srv\n# Injected';
    const tool = "x\r\n## Injected\u001b[2J\\ 'q'";
    const schema = { type: 'object', properties: { 'p\nq': { type: 'string' } }, required: ['p\nq'] };
    const line = buildCallExample(server, tool, schema);
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

    const printed = execFileSync('bash', ['-c', `printf '%s\\0' ${line.replace(/^mcpkit /, '')}`], { encoding: 'utf-8' });
    expect(printed.split('\0').slice(0, -1)).toEqual(['call', server, tool, JSON.stringify({ 'p\nq': '<p\nq>' })]);
  });

  it('keeps the Unicode line separators out of the line too', () => {
    const separator = String.fromCharCode(0x2028);
    const line = buildCallExample(`a${separator}b`, 'tool', { type: 'object' });
    expect(line).not.toContain(separator);
    expect(line).toContain('\\xe2\\x80\\xa8');
    expect(line).not.toContain('\\u2028');
  });
});

describe('shellQuote hands the shell the exact bytes of the name', () => {
  // macOS /bin/bash is 3.2, which leaves \u escapes in $'...' literal, and the
  // C1 controls must reach the server as UTF-8, not as a lone invalid byte.
  const shells = ['/bin/bash', '/bin/zsh', '/usr/bin/zsh'].filter((shell) => existsSync(shell));

  const names: Array<[string, string]> = [
    ['NEL', 'c\u0085c'],
    ['line separator', `n${String.fromCharCode(0x2028)}l`],
    ['paragraph separator', `p${String.fromCharCode(0x2029)}q`],
    ['last C1 control', 'x\u009fy'],
    ['DEL', 'a\u007fb'],
    ['escape sequence', 'a\u001b[2Jb'],
    ['tab, CR and LF', 'a\tb\rc\nd'],
    ['backslash and quote next to a control', "a\\x41'b\n"],
    ['hex digits after a control', 'a\u0001deadbeef'],
    ['printable non-ASCII beside a control', 'caf\u00e9\u0085\u20ac\u{1f600}'],
  ];

  function bytesReceivedBy(shell: string, word: string): Buffer {
    return execFileSync(shell, ['-c', `printf '%s' ${word}`]);
  }

  describe.each(shells)('%s', (shell) => {
    it.each(names)('passes a name with %s through unchanged', (_label, name) => {
      expect(bytesReceivedBy(shell, shellQuote(name)).equals(Buffer.from(name, 'utf-8'))).toBe(true);
    });
  });

  it('writes the control characters as UTF-8 byte escapes, never \\u escapes', () => {
    expect(shellQuote('c\u0085c')).toBe("$'c\\xc2\\x85c'");
    expect(shellQuote(`n${String.fromCharCode(0x2028)}l`)).toBe("$'n\\xe2\\x80\\xa8l'");
    expect(shellQuote('a\u001bb')).toBe("$'a\\x1bb'");
    expect(shellQuote('\u2029\u007f')).not.toMatch(/\\u/);
  });

  it('leaves plain words bare and other text in single quotes', () => {
    expect(shellQuote('create_issue.v2')).toBe('create_issue.v2');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe("''");
  });
});

describe('buildExampleArgs respects the number keywords of the schema', () => {
  it('keeps the inclusive minimum, the common case, as it was', () => {
    expect(example({ type: 'integer', minimum: 5 })).toBe(5);
    expect(example({ type: 'number', minimum: 1 })).toBe(1);
    expect(example({ type: 'number', minimum: -5 })).toBe(-5);
    expect(example({ type: 'integer', minimum: 1.5 })).toBe(2);
    expect(example({ type: 'integer' })).toBe(0);
    expect(example({ type: 'integer', maximum: 10 })).toBe(0);
  });

  it('steps past an exclusive minimum, as a number and as the draft-04 flag', () => {
    expect(example({ type: 'integer', exclusiveMinimum: 0 })).toBe(1);
    expect(example({ type: 'integer', exclusiveMinimum: 4.5 })).toBe(5);
    expect(example({ type: 'number', exclusiveMinimum: 0 })).toBe(1);
    expect(example({ type: 'number', exclusiveMinimum: 0, maximum: 0.5 })).toBe(0.25);
    expect(example({ type: 'integer', minimum: 0, exclusiveMinimum: true })).toBe(1);
    expect(example({ type: 'number', minimum: 2, exclusiveMinimum: true })).toBe(3);
  });

  it('lands below a maximum that excludes zero, and below an exclusive maximum', () => {
    expect(example({ type: 'integer', maximum: -3 })).toBe(-3);
    expect(example({ type: 'integer', exclusiveMaximum: 0 })).toBe(-1);
    expect(example({ type: 'integer', exclusiveMaximum: -2.5 })).toBe(-3);
    expect(example({ type: 'number', exclusiveMaximum: 0 })).toBe(-1);
    expect(example({ type: 'integer', maximum: 0, exclusiveMaximum: true })).toBe(-1);
    expect(example({ type: 'integer', minimum: 0, exclusiveMaximum: 1 })).toBe(0);
    expect(example({ type: 'integer', minimum: 3, maximum: 3 })).toBe(3);
  });

  it('picks a multiple of multipleOf inside the bounds, preferring zero', () => {
    expect(example({ type: 'integer', multipleOf: 3 })).toBe(0);
    expect(example({ type: 'integer', multipleOf: 5, minimum: 1 })).toBe(5);
    expect(example({ type: 'integer', multipleOf: 3, minimum: 10 })).toBe(12);
    expect(example({ type: 'integer', multipleOf: 4, maximum: -5 })).toBe(-8);
    expect(example({ type: 'integer', multipleOf: 3, exclusiveMinimum: 3 })).toBe(6);
    expect(example({ type: 'integer', multipleOf: 2, minimum: 1, maximum: 3 })).toBe(2);
  });

  it('picks a fractional multiple that survives the division check validators use', () => {
    for (const [multipleOf, minimum] of [[0.1, 0.25], [0.01, 0.07], [0.5, 1.2], [0.3, 1]]) {
      const value = example({ type: 'number', multipleOf, minimum }) as number;
      expect(value).toBeGreaterThanOrEqual(minimum);
      expect(Number.isInteger(value / multipleOf)).toBe(true);
    }
  });

  it('returns a finite number, without looping, when the bounds cannot be met', () => {
    expect(Number.isFinite(example({ type: 'integer', minimum: 5, maximum: 1 }))).toBe(true);
    expect(Number.isFinite(example({ type: 'integer', multipleOf: 10, minimum: 1, maximum: 9 }))).toBe(true);
    expect(Number.isFinite(example({ type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 1 }))).toBe(true);
  });

  it('keeps a huge integer bound exact', () => {
    expect(example({ type: 'integer', minimum: 9007199254740991 })).toBe(9007199254740991);
  });
});

describe('buildExampleArgs respects the string and array keywords of the schema', () => {
  it('pads a placeholder to minLength and keeps it a visible placeholder', () => {
    const value = example({ type: 'string', minLength: 12 }, 'token') as string;
    expect(length(value)).toBe(12);
    expect(value.startsWith('<token')).toBe(true);
    expect(value.endsWith('>')).toBe(true);
    expect(example({ type: 'string', minLength: 1 }, 'token')).toBe('<token>');
  });

  it('cuts a placeholder to maxLength, down to the empty string', () => {
    expect(example({ type: 'string', maxLength: 4 }, 'token')).toBe('<tok');
    expect(example({ type: 'string', maxLength: 0 }, 'token')).toBe('');
    expect(example({ type: 'string', minLength: 2, maxLength: 3 }, 'token')).toBe('<to');
    expect(example({ type: 'string', maxLength: 100 }, 'token')).toBe('<token>');
  });

  it('counts code points, as JSON Schema does, and never cuts a surrogate pair in half', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const value = String(example({ type: 'string', maxLength: 3 }, emoji.repeat(4)));
    expect(length(value)).toBe(3);
    expect(Buffer.from(value, 'utf-8').toString('utf-8')).toBe(value);
  });

  it('stays bounded for an absurd minLength', () => {
    expect(length(example({ type: 'string', minLength: 1e9 }))).toBeLessThanOrEqual(1000);
  });

  it('fills minItems with items built from the item schema', () => {
    expect(example({ type: 'array', items: { type: 'string' }, minItems: 2 }, 'paths')).toEqual(['<paths>', '<paths>']);
    expect(example({ type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 3 })).toEqual([1, 1, 1]);
    expect(example({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, minItems: 1 }, 'rows'))
      .toEqual([{ id: '<id>' }]);
    expect(example({ type: 'array', items: { $ref: '#/$defs/Id' }, minItems: 1 }, 'ids', { $defs: { Id: { enum: ['a', 'b'] } } })).toEqual(['a']);
  });

  it('keeps an array without minItems empty, and fills a missing item schema with a placeholder', () => {
    expect(example({ type: 'array', items: { type: 'string' } })).toEqual([]);
    expect(example({ type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 3 })).toEqual([]);
    expect(example({ type: 'array', minItems: 1 }, 'xs')).toEqual(['<xs>']);
  });

  it('reads item schemas by position for tuples', () => {
    expect(example({ type: 'array', items: [{ type: 'string' }, { type: 'integer' }], minItems: 2 }, 'pair')).toEqual(['<pair>', 0]);
    expect(example({ type: 'array', prefixItems: [{ type: 'boolean' }, { const: 'k' }], minItems: 2 })).toEqual([false, 'k']);
  });

  it('stays bounded for an absurd minItems', () => {
    expect((example({ type: 'array', items: { type: 'string' }, minItems: 1e9 }) as unknown[]).length).toBeLessThanOrEqual(100);
  });

  it('keeps the declared type of a value that the depth limit cuts off', () => {
    const value = example({ $ref: '#/$defs/Tree' }, 'tree', {
      $defs: { Tree: { type: 'object', properties: { children: { type: 'array', minItems: 1, items: { $ref: '#/$defs/Tree' } } }, required: ['children'] } },
    });
    let levels = 0;
    let node = value as { children: unknown[] };
    while (node.children.length > 0) {
      node = node.children[0] as { children: unknown[] };
      levels++;
    }
    // The nesting stops after a few levels, and the cut-off property is an empty array, not a string.
    expect(levels).toBeGreaterThanOrEqual(1);
    expect(levels).toBeLessThan(10);
    expect(node).toEqual({ children: [] });
  });

  it('cuts a too-deep object, number and string to their own empty values', () => {
    const nested = (leaf: unknown): unknown => ({
      type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'object', properties: { e: { type: 'object', properties: { leaf }, required: ['leaf'] } }, required: ['e'] } }, required: ['d'] } }, required: ['c'] } }, required: ['b'] } }, required: ['a'],
    });
    const leafOf = (schema: unknown): unknown => {
      const innermost = (buildExampleArgs(nested(schema)) as Record<string, any>).a.b.c.d.e;
      return innermost.leaf ?? innermost;
    };
    expect(leafOf({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] })).toEqual({});
    expect(leafOf({ type: 'integer', minimum: 3 })).toBe(3);
    expect(leafOf({ type: 'string', minLength: 8 })).toMatch(/^<leaf_*>$/);
  });
});

describe('buildExampleArgs respects enum, const and the branches of the schema', () => {
  it('takes the first enum member that also meets the numeric and length keywords', () => {
    expect(example({ type: 'integer', enum: [0, 5, 9], minimum: 1 })).toBe(5);
    expect(example({ type: 'string', enum: ['a', 'bcd'], minLength: 2 })).toBe('bcd');
    expect(example({ enum: ['x', 'y'] })).toBe('x');
    expect(example({ type: 'integer', enum: [0], minimum: 1 })).toBe(0);
  });

  it('keeps const as it is', () => {
    expect(example({ const: 7, type: 'integer', minimum: 100 })).toBe(7);
  });

  it('merges allOf branches, so an enum or a bound in any branch holds', () => {
    expect(example({ allOf: [{ type: 'string' }, { enum: ['x', 'y'] }] })).toBe('x');
    expect(example({ allOf: [{ type: 'integer', minimum: 2 }, { minimum: 10 }, { maximum: 50 }] })).toBe(10);
    expect(example({ allOf: [{ $ref: '#/$defs/Base' }, { required: ['b'], properties: { b: { type: 'integer', minimum: 3 } } }] }, 'cfg', {
      $defs: { Base: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
    })).toEqual({ a: '<a>', b: 3 });
    expect(example({ allOf: [{ enum: ['a', 'b', 'c'] }, { enum: ['c', 'b'] }] })).toBe('b');
  });

  it('keeps the sibling keywords of an anyOf or oneOf next to the branch it takes', () => {
    expect(example({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], anyOf: [{ required: ['b'], properties: { b: { type: 'integer' } } }, { required: ['c'] }] }))
      .toEqual({ a: '<a>', b: 0 });
    expect(example({ type: 'integer', minimum: 4, oneOf: [{ maximum: 9 }, { maximum: 20 }] })).toBe(4);
  });

  it('applies a root-level anyOf or allOf to the whole arguments object', () => {
    expect(buildExampleArgs({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, anyOf: [{ required: ['id'] }, { required: ['name'] }] }))
      .toEqual({ id: '<id>' });
    expect(buildExampleArgs({ properties: { id: { type: 'string' } }, required: ['id'] })).toEqual({ id: '<id>' });
  });
});

describe('the example call line stops option parsing before a name that starts with a dash', () => {
  it('writes -- before the first word that starts with a dash', () => {
    expect(callLine('srv', '--flag', '{}')).toBe(`mcpkit call srv -- --flag '{}'`);
    expect(callLine('srv', '-x', '{}')).toBe(`mcpkit call srv -- -x '{}'`);
    expect(callLine('-srv', 'tool', '{}')).toBe(`mcpkit call -- -srv tool '{}'`);
    expect(callLine('srv', '--', '{}')).toBe(`mcpkit call srv -- -- '{}'`);
    // A name that needs quoting still starts with a dash once the shell has removed the quotes.
    expect(callLine('srv', '-a b', '{}')).toBe(`mcpkit call srv -- '-a b' '{}'`);
    expect(callLine('srv', '-x\n', '{}')).toBe(`mcpkit call srv -- $'-x\\n' '{}'`);
    expect(buildCallExample('srv', '--flag', { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }))
      .toBe(`mcpkit call srv -- --flag '{"q":"<q>"}'`);
  });

  it('adds nothing for ordinary names, including one with a dash inside', () => {
    expect(callLine('srv', 'list-items', '{}')).toBe(`mcpkit call srv list-items '{}'`);
    expect(callLine('my-srv', 'a_b', '{}')).toBe(`mcpkit call my-srv a_b '{}'`);
  });

  /** What a `call <server> <tool> [params]` command declared like mcpkit's reads from the argv a shell produced. */
  function parseCall(words: string[]): string[] | undefined {
    let seen: string[] | undefined;
    const call = new Command('call').argument('<server>').argument('<tool>').argument('[params]').option('--json')
      .exitOverride()
      .configureOutput({ writeErr: () => {} })
      .action((server: string, tool: string, params: string) => { seen = [server, tool, params]; });
    new Command().name('mcpkit').exitOverride().configureOutput({ writeErr: () => {} }).addCommand(call).parse(words, { from: 'user' });
    return seen;
  }

  it.each(['--flag', '-x', '-5', '--', '--json', '-', '-a b', "-it's", '-x\n', '--flag\u0085', '-$HOME'])('round-trips the tool "%s" through the shell and through commander', (tool) => {
    const line = callLine('srv', tool, '{"a":1}');
    const words = execFileSync('bash', ['-c', `printf '%s\\0' ${line.replace(/^mcpkit /, '')}`], { encoding: 'utf-8' }).split('\0').slice(0, -1);

    expect(parseCall(words)).toEqual(['srv', tool, '{"a":1}']);
  });

  it('without the -- commander reads the name as an option, which is what the line avoids', () => {
    expect(() => parseCall(['call', 'srv', '--flag', '{}'])).toThrow(/unknown option/);
  });

  it('keeps options that come before the -- working', () => {
    expect(parseCall(['call', '--json', 'srv', '--', '--flag', '{}'])).toEqual(['srv', '--flag', '{}']);
  });
});
