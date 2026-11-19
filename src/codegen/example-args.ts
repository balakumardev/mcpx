import { isDeepStrictEqual } from 'node:util';
import { isRecord, resolveRef } from './json-schema-types.js';

type SchemaObject = Record<string, unknown>;

const MAX_DEPTH = 4;

/** A schema can demand any number of items or characters; an example is meant to be read, so these stay bounded. */
const MAX_EXAMPLE_ITEMS = 100;
const MAX_EXAMPLE_LENGTH = 1000;

/** How many multiples of `multipleOf`, or integers, are tried before a set of numeric bounds is given up as unsatisfiable. */
const MAX_NUMBER_STEPS = 1000;

interface Bound {
  value: number;
  exclusive: boolean;
}

/** The lower bound of a numeric schema: `exclusiveMinimum` as a number (draft 6+) or as the flag of `minimum` (draft 4). */
function lowerBound(schema: SchemaObject): Bound | undefined {
  const { minimum, exclusiveMinimum } = schema;
  if (typeof exclusiveMinimum === 'number' && (typeof minimum !== 'number' || exclusiveMinimum >= minimum)) {
    return { value: exclusiveMinimum, exclusive: true };
  }
  return typeof minimum === 'number' ? { value: minimum, exclusive: exclusiveMinimum === true } : undefined;
}

function upperBound(schema: SchemaObject): Bound | undefined {
  const { maximum, exclusiveMaximum } = schema;
  if (typeof exclusiveMaximum === 'number' && (typeof maximum !== 'number' || exclusiveMaximum <= maximum)) {
    return { value: exclusiveMaximum, exclusive: true };
  }
  return typeof maximum === 'number' ? { value: maximum, exclusive: exclusiveMaximum === true } : undefined;
}

/** Whether `value` meets the number keywords of the schema, with the division check validators run for `multipleOf`. */
function numberFits(schema: SchemaObject, integer: boolean, value: number): boolean {
  const lower = lowerBound(schema);
  const upper = upperBound(schema);
  const { multipleOf } = schema;
  return Number.isFinite(value)
    && (!integer || Number.isInteger(value))
    && (lower === undefined || (lower.exclusive ? value > lower.value : value >= lower.value))
    && (upper === undefined || (upper.exclusive ? value < upper.value : value <= upper.value))
    && (typeof multipleOf !== 'number' || !(multipleOf > 0) || Number.isInteger(value / multipleOf));
}

/**
 * A number inside the bounds: the lower bound when there is one (else 0), moved
 * onto the grid of `multipleOf` (or of the integers) and past an exclusive bound;
 * when only an upper bound rules zero out, the highest value below it.
 */
function numberPlaceholder(schema: SchemaObject, integer: boolean): number {
  const lower = lowerBound(schema);
  const upper = upperBound(schema);
  if (lower === undefined && numberFits(schema, integer, 0)) return 0;

  const ascending = lower !== undefined;
  const edge = (ascending ? lower : upper)?.value ?? 0;
  const multiple = typeof schema.multipleOf === 'number' && schema.multipleOf > 0 ? schema.multipleOf : undefined;
  const step = multiple ?? (integer ? 1 : undefined);

  if (step === undefined) {
    // A plain number has no grid to land on: the bound itself, or just inside an exclusive one.
    const bound = ascending ? lower : upper;
    if (!bound?.exclusive) return edge;
    const other = ascending ? upper : lower;
    return other === undefined ? edge + (ascending ? 1 : -1) : (edge + other.value) / 2;
  }

  let multipleIndex = ascending ? Math.ceil(edge / step) : Math.floor(edge / step);
  for (let tried = 0; tried < MAX_NUMBER_STEPS; tried++, multipleIndex += ascending ? 1 : -1) {
    const product = multipleIndex * step;
    // A fractional step makes noise like 0.30000000000000004: round it away, but leave integers exact.
    const candidate = Number.isInteger(step) ? product : Number(product.toPrecision(12));
    if (numberFits(schema, integer, candidate)) return candidate;
  }
  return edge;
}

/** `<name>`, padded inside the brackets to `minLength` or cut to `maxLength`, counted in code points like JSON Schema does. */
function stringPlaceholder(name: string, schema: SchemaObject): string {
  const minLength = typeof schema.minLength === 'number' ? Math.min(schema.minLength, MAX_EXAMPLE_LENGTH) : 0;
  const maxLength = typeof schema.maxLength === 'number' ? Math.max(schema.maxLength, 0) : Infinity;
  const base = [...`<${name}>`];
  if (base.length > maxLength) return base.slice(0, maxLength).join('');
  return base.length < minLength ? `<${name}${'_'.repeat(minLength - base.length)}>` : base.join('');
}

function stringFits(schema: SchemaObject, value: string): boolean {
  const length = [...value].length;
  return (typeof schema.minLength !== 'number' || length >= schema.minLength)
    && (typeof schema.maxLength !== 'number' || length <= schema.maxLength);
}

/** The first member of an enum that also meets the number and length keywords next to it, else its first member. */
function enumMember(schema: SchemaObject, members: unknown[]): unknown {
  const integer = declaredType(schema) === 'integer';
  const fits = members.find((member) =>
    typeof member === 'number' ? numberFits(schema, integer, member)
      : typeof member === 'string' ? stringFits(schema, member)
        : true);
  return fits ?? members[0];
}

/** The schema of one branch of a combinator, with a local `$ref` followed. Undefined for anything that is not an object schema. */
function branchSchema(branch: unknown, root: SchemaObject): SchemaObject | undefined {
  const resolved = isRecord(branch) && typeof branch.$ref === 'string' ? resolveRef(branch.$ref, root) : branch;
  return isRecord(resolved) ? resolved : undefined;
}

const RAISED_BY_MERGE = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'] as const;
const LOWERED_BY_MERGE = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'] as const;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * `base` and `extra` as one schema that both must hold: the tighter bound wins,
 * enums intersect, required names and properties accumulate (a property in both
 * becomes an `allOf` of the two), and for the rest `base` wins.
 */
function mergeSchemas(base: SchemaObject, extra: SchemaObject): SchemaObject {
  const merged: SchemaObject = { ...extra, ...base };
  for (const key of RAISED_BY_MERGE) {
    if (typeof base[key] === 'number' && typeof extra[key] === 'number') merged[key] = Math.max(base[key], extra[key]);
  }
  for (const key of LOWERED_BY_MERGE) {
    if (typeof base[key] === 'number' && typeof extra[key] === 'number') merged[key] = Math.min(base[key], extra[key]);
  }
  if (Array.isArray(base.enum) && Array.isArray(extra.enum)) {
    merged.enum = base.enum.filter((member) => (extra.enum as unknown[]).some((other) => isDeepStrictEqual(member, other)));
  }
  if (base.required !== undefined || extra.required !== undefined) {
    merged.required = [...new Set([...stringList(base.required), ...stringList(extra.required)])];
  }
  if (isRecord(base.properties) || isRecord(extra.properties)) {
    const properties: SchemaObject = {};
    for (const source of [extra.properties, base.properties]) {
      if (!isRecord(source)) continue;
      for (const [key, schema] of Object.entries(source)) {
        properties[key] = Object.hasOwn(properties, key) ? { allOf: [properties[key], schema] } : schema;
      }
    }
    merged.properties = properties;
  }
  return merged;
}

/**
 * What stands in for a schema nested too deep to expand: the empty value of its
 * type, so that an object or array keeps the shape the schema declares.
 */
function cutOffValue(name: string, schema: SchemaObject, root: SchemaObject): unknown {
  let current: unknown = schema;
  for (let hops = 0; hops < MAX_DEPTH && isRecord(current) && typeof current.$ref === 'string'; hops++) {
    current = resolveRef(current.$ref, root);
  }
  if (!isRecord(current)) return `<${name}>`;
  switch (declaredType(current)) {
    case 'object': return {};
    case 'array': return [];
    case 'boolean': return false;
    case 'null': return null;
    case 'integer': return numberPlaceholder(current, true);
    case 'number': return numberPlaceholder(current, false);
    default: return stringPlaceholder(name, current);
  }
}

function declaredType(schema: SchemaObject): unknown {
  return Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') : schema.type;
}

/** The items of an array of at least `minItems`, each built from the item schema of its position. */
function arrayPlaceholder(name: string, schema: SchemaObject, root: SchemaObject, depth: number): unknown[] {
  const count = typeof schema.minItems === 'number' ? Math.min(Math.max(Math.trunc(schema.minItems), 0), MAX_EXAMPLE_ITEMS) : 0;
  const itemSchema = (index: number): unknown => {
    if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) return schema.prefixItems[index];
    if (Array.isArray(schema.items)) return index < schema.items.length ? schema.items[index] : schema.additionalItems;
    return schema.items;
  };
  return Array.from({ length: count }, (_, index) => placeholder(name, itemSchema(index), root, depth + 1));
}

/** A typed placeholder for one value that meets the schema: const, an enum member, or a value of the declared type. */
function placeholder(name: string, schema: unknown, root: SchemaObject, depth: number): unknown {
  if (!isRecord(schema)) return `<${name}>`;
  if (depth > MAX_DEPTH) return cutOffValue(name, schema, root);
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, root);
    return resolved === null ? `<${name}>` : placeholder(name, resolved, root, depth + 1);
  }

  // allOf: every branch holds, so fold them into one schema.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const { allOf, ...rest } = schema;
    const folded = allOf.reduce<SchemaObject>((merged, branch) => {
      const resolved = branchSchema(branch, root);
      return resolved === undefined ? merged : mergeSchemas(merged, resolved);
    }, rest);
    return placeholder(name, folded, root, depth + 1);
  }

  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return enumMember(schema, schema.enum);

  // anyOf and oneOf: take the first branch, with the keywords that sit next to the combinator.
  for (const key of ['anyOf', 'oneOf']) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      const { [key]: _combinator, ...rest } = schema;
      const branch = branchSchema(branches[0], root);
      return placeholder(name, branch === undefined ? rest : mergeSchemas(rest, branch), root, depth + 1);
    }
  }

  switch (declaredType(schema)) {
    case 'string': return stringPlaceholder(name, schema);
    case 'integer': return numberPlaceholder(schema, true);
    case 'number': return numberPlaceholder(schema, false);
    case 'boolean': return false;
    case 'array': return arrayPlaceholder(name, schema, root, depth);
    case 'null': return null;
    case 'object': return requiredPlaceholders(schema, root, depth + 1);
    default: return `<${name}>`;
  }
}

function requiredPlaceholders(schema: SchemaObject, root: SchemaObject, depth: number): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = stringList(schema.required);
  // fromEntries defines own properties, so a property named __proto__ is not lost.
  return Object.fromEntries(required.map((name) => [
    name,
    placeholder(name, Object.hasOwn(properties, name) ? properties[name] : undefined, root, depth),
  ]));
}

/** An arguments object holding a typed placeholder for each required property. */
export function buildExampleArgs(inputSchema: unknown): Record<string, unknown> {
  if (!isRecord(inputSchema)) return {};
  // The root is one level above its properties, which stay level 0 as they always were.
  const args = placeholder('arguments', { type: 'object', ...inputSchema }, inputSchema, -1);
  return isRecord(args) ? args : {};
}

const CONTROL_CHAR = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const ANSI_C_ESCAPES: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * `$'...'` quoting: the shell turns the escapes back into the original characters.
 * A control character is written as the `\xHH` escapes of its UTF-8 bytes, never as
 * `\uXXXX` (bash 3.2, the macOS /bin/bash, keeps that literal) and never as one
 * `\xHH` per code unit (U+0085 would reach the server as a lone byte, not as U+0085).
 */
function ansiCQuote(text: string): string {
  const body = text.replace(/[\\'\p{Cc}\p{Zl}\p{Zp}]/gu, (char) =>
    ANSI_C_ESCAPES[char] ?? [...Buffer.from(char, 'utf-8')].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join(''));
  return `$'${body}'`;
}

/**
 * A shell word for `text`: bare when it is plain, single-quoted otherwise. Text
 * with a control character goes in `$'...'` instead, because a single-quoted
 * string would carry the raw line break (or escape) into the printed line.
 */
export function shellQuote(text: string): string {
  if (/^[A-Za-z0-9._:@%+=,/-]+$/.test(text)) return text;
  return CONTROL_CHAR.test(text) ? ansiCQuote(text) : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * A `mcpkit <command>` line from shell words. A word that starts with a dash
 * would be read as an option, so `--` goes right before the first such word
 * and everything after it is an operand.
 */
export function commandLine(command: string, ...words: string[]): string {
  // Look at the words as typed, not as quoted: the shell removes the quotes, so '-a b' reaches mcpkit as an option too.
  const quoted = words.map(shellQuote);
  const dashed = words.findIndex((word) => word.startsWith('-'));
  if (dashed !== -1) quoted.splice(dashed, 0, '--');
  return ['mcpkit', command, ...quoted].join(' ');
}

/** A `mcpkit call` line whose server, tool and JSON arguments are each one shell word. */
export function callLine(server: string, tool: string, json: string): string {
  return commandLine('call', server, tool, json);
}

/** A ready-to-run `mcpkit call` line with placeholders for the required arguments. */
export function buildCallExample(server: string, tool: string, inputSchema: unknown): string {
  return callLine(server, tool, JSON.stringify(buildExampleArgs(inputSchema)));
}
