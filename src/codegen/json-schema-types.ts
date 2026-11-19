/*!
 * Adapted from cloudflare/agents (packages/codemode), https://github.com/cloudflare/agents
 *
 * MIT License
 *
 * Copyright (c) 2025 Cloudflare, Inc.
 *
 * Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice
 * (including the next paragraph) shall be included in all copies or substantial
 * portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
 * ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
 * OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { escapeJsDoc, escapeStringLiteral, quoteProp } from './utils.js';

/**
 * JSON Schema to TypeScript type strings.
 *
 * Schemas come from servers and are untrusted: every field is narrowed before
 * use and anything malformed degrades to `unknown` instead of throwing. Only
 * local `#/...` references are resolved (never files or URLs), reference cycles
 * become `unknown`, and a node budget bounds the output of pathological schemas.
 */

type SchemaObject = Record<string, unknown>;

/** Binding strength of a type expression, used to decide where parentheses are needed. */
type Precedence = 'primary' | 'intersection' | 'union';

interface TypeExpr {
  code: string;
  prec: Precedence;
}

interface ConversionContext {
  root: SchemaObject;
  depth: number;
  seen: Set<unknown>;
  maxDepth: number;
  budget: { nodes: number };
}

const MAX_DEPTH = 20;
const MAX_NODES = 5000;

const UNKNOWN: TypeExpr = { code: 'unknown', prec: 'primary' };
const NEVER: TypeExpr = { code: 'never', prec: 'primary' };
const NULL: TypeExpr = { code: 'null', prec: 'primary' };

/** Object and array types that say nothing; they add no information to an intersection. */
const GENERIC_CODES = new Set(['Record<string, unknown>', 'unknown[]']);

export function isRecord(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primary(code: string): TypeExpr {
  return { code, prec: 'primary' };
}

function wrap(type: TypeExpr, needs: 'primary' | 'intersection'): string {
  const fits = needs === 'primary' ? type.prec === 'primary' : type.prec !== 'union';
  return fits ? type.code : `(${type.code})`;
}

function dedupe(types: TypeExpr[]): TypeExpr[] {
  const seen = new Set<string>();
  return types.filter((type) => !seen.has(type.code) && seen.add(type.code));
}

function union(types: TypeExpr[]): TypeExpr {
  if (types.some((type) => type.code === UNKNOWN.code)) return UNKNOWN;
  const members = dedupe(types.filter((type) => type.code !== NEVER.code));
  if (members.length === 0) return NEVER;
  if (members.length === 1) return members[0];
  return { code: members.map((type) => type.code).join(' | '), prec: 'union' };
}

function intersection(types: TypeExpr[]): TypeExpr {
  if (types.some((type) => type.code === NEVER.code)) return NEVER;
  let members = dedupe(types.filter((type) => type.code !== UNKNOWN.code));
  const specific = members.filter((type) => !GENERIC_CODES.has(type.code));
  if (specific.length > 0) members = specific;
  if (members.length === 0) return UNKNOWN;
  if (members.length === 1) return members[0];
  return { code: members.map((type) => wrap(type, 'intersection')).join(' & '), prec: 'intersection' };
}

/**
 * Resolve a local JSON Pointer $ref (e.g. #/definitions/Foo) against the root schema.
 * Returns null for external URLs, remote documents and unresolvable paths.
 */
export function resolveRef(ref: string, root: SchemaObject): SchemaObject | boolean | null {
  // "#" is a valid self-reference to the root schema
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return null;

  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    segment = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return null;
    current = current[segment];
  }

  // Allow both object schemas and boolean schemas (true = any, false = never)
  return typeof current === 'boolean' || isRecord(current) ? current : null;
}

/** OpenAPI 3.0 `nullable: true`. */
function applyNullable(type: TypeExpr, schema: SchemaObject): TypeExpr {
  if (schema.nullable === true && type.code !== UNKNOWN.code && type.code !== NEVER.code) {
    return union([type, NULL]);
  }
  return type;
}

function literalType(value: unknown): TypeExpr {
  if (value === null) return NULL;
  switch (typeof value) {
    case 'string': return primary(`"${escapeStringLiteral(value)}"`);
    case 'number': return Number.isFinite(value) ? primary(String(value)) : UNKNOWN;
    case 'boolean': return primary(String(value));
    case 'object': return primary(JSON.stringify(value) ?? 'unknown');
    default: return UNKNOWN;
  }
}

function enumType(values: unknown[]): TypeExpr {
  return union(values.map(literalType));
}

/**
 * The JSON types a schema declares. Without `type`, object and array keywords
 * imply their type, so property-only branches of an anyOf still produce an object.
 */
function declaredTypes(schema: SchemaObject): string[] | undefined {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) {
    return schema.type.filter((type): type is string => typeof type === 'string');
  }
  if (isRecord(schema.properties) || schema.additionalProperties !== undefined || isRecord(schema.patternProperties)) {
    return ['object'];
  }
  if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return ['array'];
  return undefined;
}

/** The type the schema's own keywords describe, ignoring $ref and combinators. */
function ownType(schema: SchemaObject, indent: string, ctx: ConversionContext): TypeExpr | undefined {
  if (Array.isArray(schema.enum)) return enumType(schema.enum);
  if (schema.const !== undefined) return literalType(schema.const);

  const types = declaredTypes(schema);
  if (types === undefined) return undefined;
  return union(types.map((type) => {
    switch (type) {
      case 'string': return primary('string');
      case 'number':
      case 'integer': return primary('number');
      case 'boolean': return primary('boolean');
      case 'null': return NULL;
      case 'array': return arrayType(schema, indent, ctx);
      case 'object': return objectType(schema, indent, ctx);
      default: return UNKNOWN;
    }
  }));
}

function arrayType(schema: SchemaObject, indent: string, ctx: ConversionContext): TypeExpr {
  const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : undefined;
  if (tuple) {
    const elements = tuple.map((item) => convert(item, indent, ctx).code);
    // JSON Schema 2020-12: `items` after `prefixItems` types the remaining elements.
    if (Array.isArray(schema.prefixItems) && (isRecord(schema.items) || schema.items === true)) {
      elements.push(`...${wrap(convert(schema.items, indent, ctx), 'primary')}[]`);
    }
    return primary(`[${elements.join(', ')}]`);
  }
  if (schema.items === undefined) return primary('unknown[]');
  return primary(`${wrap(convert(schema.items, indent, ctx), 'primary')}[]`);
}

/** The JSDoc lines for one property: its description and format. */
function propertyDoc(schema: unknown, indent: string): string[] {
  if (!isRecord(schema)) return [];
  const description = typeof schema.description === 'string'
    ? escapeJsDoc(schema.description.replace(/\r?\n/g, ' ').trim())
    : '';
  const format = typeof schema.format === 'string' && schema.format ? `@format ${escapeJsDoc(schema.format)}` : '';

  if (description && format) {
    return [`${indent}/**`, `${indent} * ${description}`, `${indent} * ${format}`, `${indent} */`];
  }
  const single = description || format;
  return single ? [`${indent}/** ${single} */`] : [];
}

/**
 * The value type of the properties a schema allows beyond its listed ones, or
 * undefined when it says nothing about them. `never` means none are allowed.
 */
function extraPropertiesType(schema: SchemaObject, indent: string, ctx: ConversionContext): TypeExpr | undefined {
  const members: TypeExpr[] = [];
  if (schema.additionalProperties === true) members.push(UNKNOWN);
  else if (isRecord(schema.additionalProperties)) members.push(convert(schema.additionalProperties, indent, ctx));
  if (isRecord(schema.patternProperties)) {
    for (const value of Object.values(schema.patternProperties)) members.push(convert(value, indent, ctx));
  }
  if (members.length > 0) return union(members);
  return schema.additionalProperties === false ? NEVER : undefined;
}

function objectType(schema: SchemaObject, indent: string, ctx: ConversionContext): TypeExpr {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const inner = `${indent}  `;
  const lines: string[] = [];

  for (const [name, propSchema] of Object.entries(properties)) {
    lines.push(...propertyDoc(propSchema, inner));
    lines.push(`${inner}${quoteProp(name)}${required.has(name) ? '' : '?'}: ${convert(propSchema, inner, ctx).code};`);
  }

  const extra = extraPropertiesType(schema, inner, ctx);
  if (lines.length === 0) return primary(`Record<string, ${extra?.code ?? 'unknown'}>`);
  // A narrower index signature would clash with the optional properties above
  // (strict mode), and TypeScript cannot express "the rest are T" any other way.
  if (extra !== undefined && extra.code !== NEVER.code) lines.push(`${inner}[key: string]: unknown;`);
  return primary(`{\n${lines.join('\n')}\n${indent}}`);
}

function convert(schema: unknown, indent: string, ctx: ConversionContext): TypeExpr {
  if (schema === true) return UNKNOWN;
  if (schema === false) return NEVER;
  if (!isRecord(schema)) return UNKNOWN;
  if (ctx.depth >= ctx.maxDepth || ctx.budget.nodes <= 0 || ctx.seen.has(schema)) return UNKNOWN;

  ctx.budget.nodes -= 1;
  ctx.seen.add(schema);
  const next: ConversionContext = { ...ctx, depth: ctx.depth + 1 };

  try {
    // A schema is the intersection of its $ref target, its combinators and its
    // own keywords, so siblings of anyOf/oneOf/allOf/$ref are kept, not dropped.
    const parts: TypeExpr[] = [];
    if (typeof schema.$ref === 'string') {
      const resolved = resolveRef(schema.$ref, ctx.root);
      parts.push(resolved === null ? UNKNOWN : convert(resolved, indent, next));
    }
    const own = ownType(schema, indent, next);
    if (own) parts.push(own);
    for (const key of ['anyOf', 'oneOf']) {
      const branches = schema[key];
      if (Array.isArray(branches) && branches.length > 0) {
        parts.push(union(branches.map((branch) => convert(branch, indent, next))));
      }
    }
    if (Array.isArray(schema.allOf)) {
      parts.push(...schema.allOf.map((branch) => convert(branch, indent, next)));
    }

    return applyNullable(intersection(parts), schema);
  } finally {
    ctx.seen.delete(schema);
  }
}

/** Convert a JSON Schema to a TypeScript type expression. `indent` is the indentation of the line the type starts on. */
export function jsonSchemaToType(schema: unknown, indent = ''): string {
  const ctx: ConversionContext = {
    root: isRecord(schema) ? schema : {},
    depth: 0,
    seen: new Set(),
    maxDepth: MAX_DEPTH,
    budget: { nodes: MAX_NODES },
  };
  return convert(schema, indent, ctx).code;
}

/**
 * Whether a tool's arguments object must be passed: the root schema (following
 * root $refs) lists required properties, or has combinators, which can hide them.
 */
export function schemaRequiresArgs(schema: unknown): boolean {
  const root = isRecord(schema) ? schema : {};
  let current: unknown = schema;
  for (let hops = 0; hops < 10 && isRecord(current); hops++) {
    const node: SchemaObject = current;
    if (Array.isArray(node.required) && node.required.length > 0) return true;
    if (['anyOf', 'oneOf', 'allOf'].some((key) => Array.isArray(node[key]))) return true;
    if (typeof node.$ref !== 'string') return false;
    current = resolveRef(node.$ref, root);
  }
  return false;
}
