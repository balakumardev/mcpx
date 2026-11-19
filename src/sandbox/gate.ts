import type { ToolAnnotations } from '../types.js';

/**
 * The write gate of `mcpkit exec`: default deny. A call runs only when an
 * `--allow` pattern matches it, `--allow-writes` is set, or `--allow-read-only`
 * is set and the tool's `readOnlyHint` annotation is true.
 */
export interface GatePolicy {
  /** The `--allow` patterns, resolved against the registered servers (see resolveAllowPatterns). */
  allow: readonly AllowRule[];
  allowWrites: boolean;
  allowReadOnly: boolean;
}

/** One resolved `--allow` pattern; `null` matches any server or any tool. */
export interface AllowRule {
  server: string | null;
  tool: string | null;
}

/**
 * - `allow`: no further check needed.
 * - `check-read-only`: allowed only if the tool declares `readOnlyHint: true`.
 * - `deny`: blocked.
 */
export type GateVerdict = 'allow' | 'check-read-only' | 'deny';

/**
 * Split the repeated and/or comma-separated `--allow` values into patterns and
 * reject anything that is not one of the four supported forms, so a typo never
 * silently allows nothing (or, worse, something else).
 */
export function parseAllowPatterns(values: readonly string[]): string[] {
  const patterns: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const pattern = part.trim();
      if (pattern === '') continue;
      patterns.push(validatePattern(pattern));
    }
  }
  return patterns;
}

/** One warning per `--allow` value that holds no pattern at all (an empty string, or only commas): it allows nothing. */
export function emptyAllowWarnings(values: readonly string[]): string[] {
  return values
    .filter((value) => value.split(',').every((part) => part.trim() === ''))
    .map((value) => `warning: --allow "${value}" holds no pattern, so it allows nothing`);
}

function validatePattern(pattern: string): string {
  if (pattern === '*' || pattern === '*.*') return '*';
  const stars = pattern.split('*').length - 1;
  if (stars === 0) {
    if (pattern.startsWith('.') || pattern.endsWith('.') || !pattern.includes('.')) {
      throw new Error(`invalid --allow pattern "${pattern}": expected server.tool, server.*, *.tool or *`);
    }
    return pattern;
  }
  const serverWildcard = stars === 1 && pattern.endsWith('.*') && pattern.length > 2;
  const toolWildcard = stars === 1 && pattern.startsWith('*.') && pattern.length > 2;
  if (!serverWildcard && !toolWildcard) {
    throw new Error(
      `invalid --allow pattern "${pattern}": partial wildcards are not supported, use server.tool, server.*, *.tool or *`,
    );
  }
  return pattern;
}

/** A pattern that cannot be turned into exactly one (server, tool) pair: a usage error. */
export class AllowPatternError extends Error {}

export interface ResolvedAllow {
  rules: AllowRule[];
  /** One line per pattern that names no registered server; the run goes on (it allows nothing for them). */
  warnings: string[];
}

function pair(server: string, tool: string): string {
  return `server "${server}", tool "${tool}"`;
}

/**
 * Turn validated patterns into (server, tool) rules. Server and tool names may contain dots,
 * so a literal `a.b.c` could mean server `a` + tool `b.c` or server `a.b` + tool `c`; the
 * registered server names decide. Exactly one registered reading is used; none keeps the
 * first-dot reading (it matches nothing, and a warning says so); more than one is an error,
 * because the pattern would allow two different tools.
 */
export function resolveAllowPatterns(patterns: readonly string[], serverNames: readonly string[]): ResolvedAllow {
  const registered = new Set(serverNames);
  const rules: AllowRule[] = [];
  const warnings: string[] = [];
  const unmatched = (pattern: string): string => `warning: --allow pattern "${pattern}" matches no registered server`;

  for (const pattern of patterns) {
    if (pattern === '*') {
      rules.push({ server: null, tool: null });
    } else if (pattern.startsWith('*.')) {
      rules.push({ server: null, tool: pattern.slice(2) });
    } else if (pattern.endsWith('.*')) {
      const server = pattern.slice(0, -2);
      rules.push({ server, tool: null });
      if (!registered.has(server)) warnings.push(unmatched(pattern));
    } else {
      const readings: AllowRule[] = [];
      for (let dot = pattern.indexOf('.'); dot !== -1; dot = pattern.indexOf('.', dot + 1)) {
        if (dot > 0 && dot < pattern.length - 1) readings.push({ server: pattern.slice(0, dot), tool: pattern.slice(dot + 1) });
      }
      const found = readings.filter((reading) => registered.has(reading.server as string));
      if (found.length > 1) {
        throw new AllowPatternError(
          `--allow pattern "${pattern}" is ambiguous: it could mean `
          + `${found.map((reading) => pair(reading.server as string, reading.tool as string)).join(' or ')}. `
          + 'Rename one of the servers (`mcpkit edit <server> --name <new>`), or allow with server.* or *.tool.',
        );
      }
      if (found.length === 0) warnings.push(unmatched(pattern));
      rules.push(found[0] ?? readings[0]);
    }
  }
  return { rules, warnings };
}

/** Compares (server, tool) pairs, never joined strings: a dot in a name cannot shift the boundary. */
export function matchesAllow(rules: readonly AllowRule[], server: string, tool: string): boolean {
  return rules.some((rule) => (rule.server === null || rule.server === server) && (rule.tool === null || rule.tool === tool));
}

export function gateVerdict(policy: GatePolicy, server: string, tool: string): GateVerdict {
  if (policy.allowWrites || matchesAllow(policy.allow, server, tool)) return 'allow';
  return policy.allowReadOnly ? 'check-read-only' : 'deny';
}

/** Only an explicit `readOnlyHint: true` counts; a missing hint means "might write". */
export function isDeclaredReadOnly(annotations: ToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true;
}

export function blockedMessage(server: string, tool: string): string {
  return `mcpkit: blocked ${server}.${tool} (not allowed). Re-run with --allow ${server}.${tool}, `
    + '--allow-read-only (if the server marks it read-only) or --allow-writes.';
}
