import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { ToolInfo } from '../types.js';
import { generateMcpTypes } from './mcp-types.js';

const MIT_TEXT = `MIT License Copyright (c) 2025 Cloudflare, Inc.
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

function tool(name: string, inputSchema: Record<string, unknown>, extra: Partial<ToolInfo> = {}): ToolInfo {
  return { name, description: '', inputSchema, ...extra };
}

/**
 * Compile `declarations` as a .d.ts next to a usage file and return every
 * diagnostic. skipLibCheck stays off, otherwise TypeScript would not check the
 * generated .d.ts at all.
 */
function compile(declarations: string, usage: string): string[] {
  const sources = new Map([['/mcp.d.ts', declarations], ['/use.ts', `export {};\n${usage}`]]);
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
    skipLibCheck: false,
    skipDefaultLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile: readHostFile } = host;
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const text = sources.get(name);
    return text === undefined ? getSourceFile.call(host, name, languageVersion, ...rest) : ts.createSourceFile(name, text, languageVersion);
  };
  host.fileExists = (name) => sources.has(name) || fileExists.call(host, name);
  host.readFile = (name) => sources.get(name) ?? readHostFile.call(host, name);

  const program = ts.createProgram([...sources.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where = diagnostic.file ? `${diagnostic.file.fileName}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1} ` : '';
    return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
}

const kitchenSink: ToolInfo[] = [
  tool('create-issue', {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Ends the comment */ declare const hacked: 1; /*' },
      state: { enum: ['open', 'closed'] },
      labels: { type: 'array', items: { $ref: '#/$defs/Label' } },
      values: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      assignee: { type: ['string', 'null'] },
      milestone: { type: 'integer', nullable: true },
      pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
      fixed: { const: 'v1' },
      mixed: { enum: [1, 'two', null, true] },
      external: { $ref: 'https://example.com/schema.json#/x' },
      dangling: { $ref: '#/$defs/Missing' },
    },
    required: ['title', 'state'],
    $defs: { Label: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  }, {
    description: 'Create an issue. */ declare const hacked2: 2; /*',
    outputSchema: { type: 'object', properties: { number: { type: 'number' }, url: { type: 'string' } }, required: ['number'] },
    annotations: { readOnlyHint: false },
  }),
  tool('delete', { type: 'object', properties: { force: { type: 'boolean' } } }, { description: 'Reserved word as a tool name', annotations: { readOnlyHint: true } }),
  tool('tree', {
    type: 'object',
    properties: { root: { $ref: '#/$defs/Node' } },
    required: ['root'],
    $defs: { Node: { type: 'object', properties: { value: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } }, required: ['value'] } },
  }),
  tool('siblings', {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
    anyOf: [{ properties: { b: { type: 'number' } }, required: ['b'] }, { properties: { c: { type: 'boolean' } } }],
  }),
  tool('merged', {
    allOf: [{ $ref: '#/$defs/Base' }, { type: 'object', properties: { extra: { type: 'string' } }, required: ['extra'] }],
    $defs: { Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  }),
  tool('maps', {
    type: 'object',
    properties: {
      byName: { type: 'object', additionalProperties: { type: 'string' } },
      open: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: { type: 'number' } },
      loose: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'number' } }, additionalProperties: true },
      closed: { type: 'object', additionalProperties: false },
      patterned: { type: 'object', patternProperties: { '^x-': { type: 'number' } } },
    },
  }),
  tool('weird-keys', {
    type: 'object',
    properties: { 'my-key': { type: 'number' }, 'a b': { type: 'string' }, '1abc': { type: 'string' }, 'q"uote': { type: 'string' }, class: { type: 'string' }, __proto__: { type: 'string' } },
    required: ['my-key'],
  }),
  tool('malformed', { type: 'object', properties: null, required: 'a', enum: 'x', anyOf: 'y', description: 5 }),
  tool('no-schema', {}),
  tool('typed-output', { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }, {
    outputSchema: { type: 'object', properties: { total: { type: 'number' }, names: { type: 'array', items: { type: 'string' } } }, required: ['total'] },
  }),
];

const kitchenSinkUsage = `
async function main() {
  const k = mcp['kitchen-sink'];
  const created = await k['create-issue']({
    title: 't',
    state: 'open',
    labels: [{ name: 'bug' }],
    values: ['a', 1],
    assignee: null,
    milestone: null,
    pair: ['x', 2],
    fixed: 'v1',
    mixed: 'two',
    external: { anything: true },
  });
  const n: number = created.number;
  // @ts-expect-error number is not a string
  const s: string = created.number;
  // @ts-expect-error title is required
  await k['create-issue']({ state: 'open' });
  // @ts-expect-error state must be one of the enum values
  await k['create-issue']({ title: 't', state: 'nope' });
  // @ts-expect-error values are strings or numbers, not booleans
  await k['create-issue']({ title: 't', state: 'open', values: [true] });

  await k.delete();
  await k.delete({ force: true });
  await k.tree({ root: { value: 'v', children: [{ value: 'w' }] } });
  await k.siblings({ a: 'x', b: 1 });
  await k.siblings({ a: 'x', c: true });
  // @ts-expect-error the sibling property a is required
  await k.siblings({ b: 1 });
  await k.merged({ id: 'i', extra: 'e' });
  // @ts-expect-error extra is required by the second allOf member
  await k.merged({ id: 'i' });
  await k.maps({
    byName: { x: 'a' },
    open: { id: 'i', other: 5 },
    loose: { id: 'i', n: 1, more: 'x' },
    closed: {},
    patterned: { 'x-a': 1 },
  });
  // @ts-expect-error map values are strings
  await k.maps({ byName: { x: 1 } });
  await k['weird-keys']({ 'my-key': 1, 'a b': 'x', '1abc': 'y', 'q"uote': 'z', class: 'c' });
  await k.malformed();
  await k['no-schema']();
  const out = await k['typed-output']({ n: 1 });
  const total: number = out.total;
  const names: string[] | undefined = out.names;
  // @ts-expect-error total is a number
  const wrong: string = out.total;

  await mcp['odd server.1']['get.thing']({ id: 'x' });
  await mcp.empty;
  // @ts-expect-error a comment injected through a description must not declare anything
  hacked;
  // @ts-expect-error same for the tool description
  hacked2;
}
`;

const servers = [
  { server: 'kitchen-sink', tools: kitchenSink },
  { server: 'odd server.1', tools: [tool('get.thing', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] })] },
  { server: 'empty', tools: [] },
];

describe('generateMcpTypes', () => {
  it('declares mcp keyed by the real server and tool names, quoting only non-identifiers', () => {
    const dts = generateMcpTypes(servers);
    expect(dts).toContain('declare const mcp: {');
    expect(dts).toContain('\n  "kitchen-sink": {\n');
    expect(dts).toContain('\n    "create-issue"(args: {');
    expect(dts).toContain('\n    delete(args?: {');
    expect(dts).toContain('\n  "odd server.1": {\n');
    expect(dts).toContain('\n    "get.thing"(args: {');
    expect(dts).toContain('\n  empty: {};\n');
  });

  it('writes the description as JSDoc, @readonly for readOnlyHint true, and escapes star-slash', () => {
    const dts = generateMcpTypes([{
      server: 's',
      tools: [
        tool('read', {}, { description: 'Reads things.\n\nSecond paragraph.', annotations: { readOnlyHint: true } }),
        tool('write', {}, { description: 'Writes */ things', annotations: { readOnlyHint: false, destructiveHint: true } }),
        tool('bare', {}),
        tool('only_title', {}, { title: 'A title' }),
        tool('only_hint', {}, { annotations: { readOnlyHint: true } }),
      ],
    }]);
    expect(dts).toContain('    /**\n     * Reads things.\n     *\n     * Second paragraph.\n     *\n     * @readonly\n     */\n    read(');
    expect(dts).toContain('     * Writes *\\/ things\n     */\n    write(');
    expect(dts).not.toContain('@readonly\n     */\n    write(');
    expect(dts).toContain('\n    bare(args?:');
    expect(dts).not.toContain('/**\n     */');
    expect(dts).toContain('     * A title\n     */\n    only_title(');
    expect(dts).toContain('     * @readonly\n     */\n    only_hint(');
  });

  it('makes args optional when nothing is required and types the output from outputSchema', () => {
    const dts = generateMcpTypes([{
      server: 's',
      tools: [
        tool('optional', { type: 'object', properties: { a: { type: 'string' } } }),
        tool('required', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }),
      ],
    }]);
    expect(dts).toContain('optional(args?: {\n      a?: string;\n    }): Promise<unknown>;');
    expect(dts).toContain('required(args: {\n      a: string;\n    }): Promise<{\n      ok: boolean;\n    }>;');
  });

  it('emits a valid empty declaration for no servers', () => {
    expect(generateMcpTypes([])).toContain('declare const mcp: {};');
    expect(compile(generateMcpTypes([]), 'const keys = Object.keys(mcp);')).toEqual([]);
  });

  it('keeps going when one tool cannot be converted', () => {
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, 'type', { get() { throw new Error('boom'); }, enumerable: true });
    const dts = generateMcpTypes([{ server: 's', tools: [tool('broken', hostile), tool('fine', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })] }]);
    expect(dts).toContain('broken(args?: unknown): Promise<unknown>;');
    expect(dts).toContain('fine(args: {');
  });
});

describe('generated declarations compile with TypeScript', () => {
  const dts = generateMcpTypes(servers);

  it('produces zero diagnostics for tricky schemas, and rejects wrong calls (so the types are not any)', () => {
    expect(compile(dts, kitchenSinkUsage)).toEqual([]);
  });

  it('would notice a broken declaration file (negative controls)', () => {
    // A call that omits a required argument must be an error.
    expect(compile(dts, "async function main() { await mcp['odd server.1']['get.thing']({}); }").length).toBeGreaterThan(0);
    // An invalid .d.ts must be reported even though it is never used: this is the index-signature clash
    // that a narrower additionalProperties type causes, and proves the declarations are really checked.
    const broken = 'declare const mcp: { s: { t(args: { x?: number; [key: string]: string }): Promise<unknown>; }; };';
    expect(compile(broken, 'async function main() { await mcp.s.t(); }').some((message) => message.includes('mcp.d.ts'))).toBe(true);
  });
});

describe('MIT notice for code adapted from cloudflare/agents', () => {
  const files = ['utils.ts', 'json-schema-types.ts', 'mcp-types.ts'];

  async function header(file: string): Promise<{ raw: string; normalised: string }> {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf-8');
    const raw = /^\/\*![\s\S]*?\*\//.exec(source)?.[0] ?? '';
    const normalised = raw
      .replace(/^\/\*!|\*\/$/g, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { raw, normalised };
  }

  it.each(files)('%s opens with the full licence text and copyright line in a /*! comment', async (file) => {
    const { raw, normalised } = await header(file);
    expect(raw.startsWith('/*!')).toBe(true);
    expect(normalised).toContain('cloudflare/agents');
    expect(normalised).toContain(MIT_TEXT.replace(/\n/g, ' '));
  });
});
