import { describe, expect, it } from 'vitest';
import { jsonSchemaToType, resolveRef, schemaRequiresArgs } from './json-schema-types.js';

/** Collapse the multi-line object output to one line so assertions stay readable. */
function flat(schema: unknown): string {
  return jsonSchemaToType(schema).replace(/\s+/g, ' ');
}

describe('jsonSchemaToType', () => {
  it('maps primitives, integer to number, and unknown for an empty schema', () => {
    expect(jsonSchemaToType({ type: 'string' })).toBe('string');
    expect(jsonSchemaToType({ type: 'integer' })).toBe('number');
    expect(jsonSchemaToType({ type: 'number' })).toBe('number');
    expect(jsonSchemaToType({ type: 'boolean' })).toBe('boolean');
    expect(jsonSchemaToType({ type: 'null' })).toBe('null');
    expect(jsonSchemaToType({})).toBe('unknown');
    expect(jsonSchemaToType(true)).toBe('unknown');
    expect(jsonSchemaToType(false)).toBe('never');
  });

  it('marks properties optional unless required, with their description as JSDoc', () => {
    const type = jsonSchemaToType({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id' },
        when: { type: 'string', description: 'A time', format: 'date-time' },
        note: { type: 'string' },
      },
      required: ['id'],
    });
    expect(type).toBe([
      '{',
      '  /** The id */',
      '  id: string;',
      '  /**',
      '   * A time',
      '   * @format date-time',
      '   */',
      '  when?: string;',
      '  note?: string;',
      '}',
    ].join('\n'));
  });

  it('quotes property keys that are not valid identifiers and keeps reserved words bare', () => {
    const type = flat({
      type: 'object',
      properties: { 'my-key': { type: 'string' }, 'a b': { type: 'string' }, '1abc': { type: 'string' }, 'q"uote': { type: 'string' }, class: { type: 'string' }, $ok_1: { type: 'string' } },
    });
    expect(type).toContain('"my-key"?: string;');
    expect(type).toContain('"a b"?: string;');
    expect(type).toContain('"1abc"?: string;');
    expect(type).toContain('"q\\"uote"?: string;');
    expect(type).toContain(' class?: string;');
    expect(type).toContain(' $ok_1?: string;');
  });

  it('escapes star-slash in JSDoc and string literals', () => {
    const type = jsonSchemaToType({
      type: 'object',
      properties: { a: { type: 'string', description: 'closes */ early', enum: ['x"y', 'line\nbreak'] } },
    });
    expect(type).toContain('closes *\\/ early');
    expect(type).not.toMatch(/closes \*\/ early/);
    expect(type).toContain('"x\\"y" | "line\\nbreak"');
  });

  it('resolves local $ref, including pointer escapes, and the root reference "#"', () => {
    const type = flat({
      type: 'object',
      properties: { label: { $ref: '#/$defs/Label' }, odd: { $ref: '#/$defs/a~1b%20c' } },
      $defs: { Label: { type: 'string', enum: ['bug', 'feature'] }, 'a/b c': { type: 'number' } },
    });
    expect(type).toContain('label?: "bug" | "feature";');
    expect(type).toContain('odd?: number;');
    expect(resolveRef('#', { a: 1 })).toEqual({ a: 1 });
  });

  it('never resolves external references: URLs, files and missing pointers become unknown', () => {
    for (const ref of ['https://example.com/schema.json#/x', 'file:///etc/passwd', 'other.json', '#/nope/deeper', '#/$defs/%E0%A4%A', '#/__proto__']) {
      expect(jsonSchemaToType({ $ref: ref }), ref).toBe('unknown');
    }
    expect(resolveRef('#/constructor', {})).toBeNull();
  });

  it('turns reference cycles into unknown instead of recursing', () => {
    const type = flat({
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { value: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } },
    });
    expect(type).toContain('children?: unknown[];');
    expect(type).toContain('value?: string;');
    expect(flat({ type: 'object', properties: { self: { $ref: '#' } } })).toBe('{ self?: unknown; }');
  });

  it('parenthesises unions and intersections used as array elements', () => {
    expect(jsonSchemaToType({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } })).toBe('(string | number)[]');
    expect(jsonSchemaToType({ type: 'array', items: { type: ['string', 'null'] } })).toBe('(string | null)[]');
    expect(jsonSchemaToType({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(jsonSchemaToType({ type: 'array' })).toBe('unknown[]');
  });

  it('keeps the sibling properties of anyOf, oneOf and allOf', () => {
    const anyOf = flat({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      anyOf: [{ properties: { b: { type: 'number' } }, required: ['b'] }, { properties: { c: { type: 'boolean' } } }],
    });
    expect(anyOf).toBe('{ a: string; } & ({ b: number; } | { c?: boolean; })');

    const oneOf = flat({ type: 'object', properties: { a: { type: 'string' } }, oneOf: [{ properties: { b: { type: 'number' } } }, { properties: { c: { type: 'number' } } }] });
    expect(oneOf).toContain('{ a?: string; } & (');

    const allOf = flat({
      allOf: [{ $ref: '#/$defs/Base' }, { type: 'object', properties: { extra: { type: 'string' } }, required: ['extra'] }],
      $defs: { Base: { type: 'object', properties: { id: { type: 'string' } } } },
    });
    expect(allOf).toBe('{ id?: string; } & { extra: string; }');
  });

  it('keeps siblings of $ref and drops required-only branches that add nothing', () => {
    const withRef = flat({
      $ref: '#/$defs/Base',
      properties: { extra: { type: 'string' } },
      $defs: { Base: { type: 'object', properties: { id: { type: 'string' } } } },
    });
    expect(withRef).toBe('{ id?: string; } & { extra?: string; }');

    const requiredOnly = flat({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      anyOf: [{ required: ['a'] }, { required: ['b'] }],
    });
    expect(requiredOnly).toBe('{ a?: string; b?: string; }');
  });

  it('handles anyOf with null, enum, const, nullable and type arrays', () => {
    expect(jsonSchemaToType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(jsonSchemaToType({ enum: ['a', 1, true, null] })).toBe('"a" | 1 | true | null');
    expect(jsonSchemaToType({ enum: [] })).toBe('never');
    expect(jsonSchemaToType({ const: 'fixed' })).toBe('"fixed"');
    expect(jsonSchemaToType({ const: { a: [1, null] } })).toBe('{"a":[1,null]}');
    expect(jsonSchemaToType({ type: 'string', nullable: true })).toBe('string | null');
    expect(jsonSchemaToType({ type: ['string', 'null'] })).toBe('string | null');
    expect(jsonSchemaToType({ type: ['integer', 'string'] })).toBe('number | string');
    expect(flat({ type: ['object', 'null'], properties: { a: { type: 'string' } } })).toBe('{ a?: string; } | null');
    expect(jsonSchemaToType({ anyOf: [{ type: 'string' }, {}] })).toBe('unknown');
  });

  it('types additionalProperties and patternProperties', () => {
    expect(jsonSchemaToType({ type: 'object' })).toBe('Record<string, unknown>');
    expect(jsonSchemaToType({ type: 'object', additionalProperties: { type: 'string' } })).toBe('Record<string, string>');
    expect(jsonSchemaToType({ type: 'object', additionalProperties: true })).toBe('Record<string, unknown>');
    expect(jsonSchemaToType({ type: 'object', additionalProperties: false })).toBe('Record<string, never>');
    expect(jsonSchemaToType({ type: 'object', patternProperties: { '^x-': { type: 'number' } } })).toBe('Record<string, number>');
    // Next to listed properties a narrower index signature would not compile under strict mode.
    expect(flat({ type: 'object', properties: { id: { type: 'string' } }, additionalProperties: { type: 'number' } }))
      .toBe('{ id?: string; [key: string]: unknown; }');
    expect(flat({ type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }))
      .toBe('{ id?: string; }');
  });

  it('types tuples from prefixItems and array-form items', () => {
    expect(jsonSchemaToType({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] })).toBe('[string, number]');
    expect(jsonSchemaToType({ type: 'array', items: [{ type: 'string' }, { type: 'boolean' }] })).toBe('[string, boolean]');
    expect(jsonSchemaToType({ type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } })).toBe('[string, ...number[]]');
  });

  it('degrades malformed schemas to unknown instead of throwing', () => {
    const junk: unknown[] = [
      null, 'string', 42, [], undefined,
      { type: 12 },
      { type: 'object', properties: null, required: 'a' },
      { type: 'object', properties: { a: null, b: 'x', c: 7 } },
      { enum: 'x' },
      { anyOf: 'x', allOf: {}, oneOf: [null, 3] },
      { type: 'array', items: 'x' },
      { type: 'object', properties: { a: { description: 5, format: {} } } },
      { $ref: 5 },
    ];
    for (const schema of junk) {
      expect(() => jsonSchemaToType(schema), JSON.stringify(schema)).not.toThrow();
    }
    expect(jsonSchemaToType({ type: 'object', properties: null, required: 'a' })).toBe('Record<string, unknown>');
  });

  it('bounds the output of schemas whose references fan out exponentially', () => {
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      defs[`D${i}`] = { type: 'object', properties: { l: { $ref: `#/$defs/D${i + 1}` }, r: { $ref: `#/$defs/D${i + 1}` } } };
    }
    defs.D25 = { type: 'string' };
    const type = jsonSchemaToType({ $ref: '#/$defs/D0', $defs: defs });
    expect(type.length).toBeLessThan(2_000_000);
    expect(type).toContain('unknown');
  });

  it('stops at the maximum depth with unknown', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) schema = { type: 'object', properties: { next: schema } };
    expect(jsonSchemaToType(schema)).toContain('next?: unknown;');
  });
});

describe('schemaRequiresArgs', () => {
  it('is true only when required properties or combinators may hide them', () => {
    expect(schemaRequiresArgs({ type: 'object', properties: { a: { type: 'string' } } })).toBe(false);
    expect(schemaRequiresArgs({ type: 'object', required: [] })).toBe(false);
    expect(schemaRequiresArgs({ type: 'object', required: ['a'] })).toBe(true);
    expect(schemaRequiresArgs({ anyOf: [{ required: ['a'] }] })).toBe(true);
    expect(schemaRequiresArgs({ $ref: '#/$defs/In', $defs: { In: { required: ['a'] } } })).toBe(true);
    expect(schemaRequiresArgs({ $ref: '#/$defs/In', $defs: { In: { type: 'object' } } })).toBe(false);
    expect(schemaRequiresArgs(null)).toBe(false);
  });
});
