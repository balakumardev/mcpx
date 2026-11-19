/**
 * The one rule for what a registered server may be called. A server name becomes a directory name
 * (`mcpkit-<name>` under every agent's skills directory), a file name (the schema cache), a socket
 * and a log name, so it must never be able to carry a path separator, a `..` segment, a NUL or a
 * leading dot. Every place that accepts a name from outside (the command line, a JSON spec, a
 * rename, a registry file) checks it here, and so does every place that builds a path from one.
 */

import { jsonLine } from './search-index.js';

/** Longest name accepted: well under the 255-byte limit of a file name even with the `mcpkit-` prefix. */
export const MAX_SERVER_NAME_LENGTH = 64;

/** Letters, digits, `.`, `_` and `-`, starting with a letter or a digit. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Prefix of every skill directory mcpkit writes (`mcpkit-<server>`, and `mcpkit-cli` for the guide). */
export const SKILL_DIR_PREFIX = 'mcpkit-';

/** Why `name` cannot be a server name, or null when it can. */
export function serverNameProblem(name: unknown): string | null {
  if (typeof name !== 'string') return 'it must be a string';
  if (name.length === 0) return 'it must not be empty';
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    return `it must be at most ${MAX_SERVER_NAME_LENGTH} characters (it has ${name.length})`;
  }
  if (!SERVER_NAME_PATTERN.test(name)) {
    return 'it may only contain letters, digits, ".", "_" and "-", and must start with a letter or a digit';
  }
  if (name.includes('..')) return 'it must not contain ".."';
  return null;
}

export function isValidServerName(name: unknown): name is string {
  return serverNameProblem(name) === null;
}

/**
 * `name` as it may be quoted in a message: JSON-escaped (also DEL, the C1 controls such as NEL, and
 * the line and paragraph separators, which plain JSON leaves raw), so a NUL or a terminal escape
 * sequence in a hostile name is shown as text, and cut short so a 10 000-character name does not
 * flood the output.
 */
export function quoteName(name: unknown): string {
  const text = typeof name === 'string' ? name : String(name);
  return jsonLine(text.length > 48 ? `${text.slice(0, 48)}…` : text);
}

/** The error for a name that fails the rule, saying what the rule is. */
export function serverNameError(name: unknown): Error | null {
  const problem = serverNameProblem(name);
  return problem === null ? null : new Error(`Invalid server name ${quoteName(name)}: ${problem}.`);
}

/** Returns `name` when it is valid and throws `serverNameError` otherwise. */
export function assertServerName(name: unknown): string {
  const error = serverNameError(name);
  if (error) throw error;
  return name as string;
}

/** The skill directory for a server: `mcpkit-<name>`. Throws for a name that fails the rule. */
export function skillDirName(serverName: string): string {
  return `${SKILL_DIR_PREFIX}${assertServerName(serverName)}`;
}

/** Whether `dir` is a skill directory name mcpkit could have produced. */
export function isSkillDirName(dir: string): boolean {
  return dir.startsWith(SKILL_DIR_PREFIX) && isValidServerName(dir.slice(SKILL_DIR_PREFIX.length));
}
