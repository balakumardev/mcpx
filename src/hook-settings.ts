import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from './atomic-file.js';

/**
 * The command the installed hook runs. It can never produce a visible error: an `mcpkit` that is not
 * on the PATH, or an older one that has no `hook` command, fails inside the shell and is silenced there.
 */
export const HOOK_COMMAND = 'mcpkit hook session-start 2>/dev/null || true';

/** A hook entry is ours when its command starts with this, so an entry written by an earlier version (the bare command) is recognised. */
const HOOK_COMMAND_PREFIX = 'mcpkit hook session-start';

/** The SessionStart sources the hook covers by default. */
export const DEFAULT_MATCHER = 'startup|resume|clear|compact';

/** The settings file cannot be edited safely; nothing was written. */
export class SettingsRefusal extends Error {}

/** The outcome of an install or an uninstall: the settings text to write, whether it differs, and what was added or removed. */
export interface SettingsEdit {
  changed: boolean;
  /** The text to write: the original, byte for byte, when nothing changed (an empty string for a missing file). */
  text: string;
  /** Install: the `hooks.SessionStart` entry added, updated or already there. Uninstall: the hook items removed. */
  entry?: unknown;
  /** Install: the commands of earlier entries of ours that were updated in place (or removed as duplicates); empty for a new entry. */
  replaced?: string[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOurHook(hook: unknown): boolean {
  return isObject(hook) && hook.type === 'command' && typeof hook.command === 'string' && hook.command.startsWith(HOOK_COMMAND_PREFIX);
}

/** The hooks of a SessionStart group that are ours. */
function ourHooksIn(group: unknown): JsonObject[] {
  return isObject(group) && Array.isArray(group.hooks) ? group.hooks.filter(isObject).filter(isOurHook) : [];
}

function kind(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
}

/** The settings as an object; a missing or blank file is an empty one. Anything else that is not a JSON object is refused. */
function parseSettings(text: string | undefined): JsonObject {
  if (text === undefined || text.trim() === '') return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SettingsRefusal(`the settings file is not valid JSON (${(err instanceof Error ? err.message : String(err)).split('\n')[0]})`);
  }
  if (!isObject(data)) throw new SettingsRefusal(`the settings file must be a JSON object, not ${kind(data)}`);
  return data;
}

/** `root.hooks.SessionStart` with its parents, checked: each must be absent or of the expected type. */
function sessionStartOf(root: JsonObject): { hooks: JsonObject | undefined; groups: unknown[] | undefined } {
  const { hooks } = root;
  if (hooks !== undefined && !isObject(hooks)) throw new SettingsRefusal(`"hooks" must be an object, not ${kind(hooks)}`);
  const groups = hooks?.SessionStart;
  if (groups !== undefined && !Array.isArray(groups)) throw new SettingsRefusal(`"hooks.SessionStart" must be an array, not ${kind(groups)}`);
  return { hooks, groups };
}

/** The settings text for `root`, written the way the original was: same indentation, same final newline (or lack of it). */
function serialize(root: JsonObject, original: string | undefined): string {
  const indent = /^([ \t]+)\S/m.exec(original ?? '')?.[1] ?? '  ';
  const finalNewline = original === undefined || original.trim() === '' || original.endsWith('\n');
  return `${JSON.stringify(root, null, indent)}${finalNewline ? '\n' : ''}`;
}

/**
 * Add the SessionStart hook to the settings text, unless it is there already. An earlier entry of ours
 * (any command that starts with `mcpkit hook session-start`) is updated in place to the current command,
 * keeping its group, its matcher and its other keys; further entries of ours are removed as duplicates.
 * Throws SettingsRefusal for a file that cannot be edited safely.
 */
export function installHook(before: string | undefined, matcher: string): SettingsEdit {
  const root = parseSettings(before);
  const { hooks, groups } = sessionStartOf(root);

  const [first, ...duplicates] = (groups ?? []).flatMap(ourHooksIn);
  if (first === undefined) {
    const entry = { matcher, hooks: [{ type: 'command', command: HOOK_COMMAND }] };
    const sessionStart = [...(groups ?? []), entry];
    root.hooks = hooks === undefined ? { SessionStart: sessionStart } : Object.assign(hooks, { SessionStart: sessionStart });
    return { changed: true, text: serialize(root, before), entry, replaced: [] };
  }

  const replaced = [first, ...duplicates].map((hook) => hook.command as string);
  const kept = (groups ?? []).flatMap((group) => {
    if (ourHooksIn(group).length === 0) return [group];
    const rest = (group as { hooks: unknown[] }).hooks.filter((hook) => !duplicates.includes(hook as JsonObject));
    return rest.length === 0 ? [] : [{ ...(group as JsonObject), hooks: rest }];
  });
  const entry = kept.find((group) => ourHooksIn(group).includes(first));
  if (duplicates.length === 0 && first.command === HOOK_COMMAND) return { changed: false, text: before ?? '', entry };

  first.command = HOOK_COMMAND;
  (hooks as JsonObject).SessionStart = kept;
  return { changed: true, text: serialize(root, before), entry, replaced };
}

/**
 * Remove the hooks that are ours (a command that starts with `mcpkit hook session-start`), and only those. A group left without hooks goes
 * with them; so do `hooks.SessionStart` and `hooks` when this removal empties them. Anything else
 * stays, and a file that holds none of ours is returned untouched.
 */
export function uninstallHook(before: string | undefined): SettingsEdit {
  const root = parseSettings(before);
  const { hooks, groups } = sessionStartOf(root);
  const removed = (groups ?? []).flatMap(ourHooksIn);
  if (hooks === undefined || groups === undefined || removed.length === 0) return { changed: false, text: before ?? '' };

  const kept = groups.flatMap((group) => {
    if (ourHooksIn(group).length === 0) return [group];
    const rest = (group as { hooks: unknown[] }).hooks.filter((hook) => !isOurHook(hook));
    return rest.length === 0 ? [] : [{ ...(group as JsonObject), hooks: rest }];
  });
  if (kept.length > 0) hooks.SessionStart = kept;
  else delete hooks.SessionStart;
  if (Object.keys(hooks).length === 0) delete root.hooks;
  return { changed: true, text: serialize(root, before), entry: removed };
}

/**
 * Whether the settings text has a SessionStart hook of ours (a command that starts with
 * `mcpkit hook session-start`). Read-only and forgiving: a missing, empty or malformed file simply has none.
 */
export function hasInstalledHook(text: string | undefined): boolean {
  try {
    return (sessionStartOf(parseSettings(text)).groups ?? []).some((group) => ourHooksIn(group).length > 0);
  } catch {
    return false;
  }
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const DIFF_CONTEXT_LINES = 3;

/**
 * A unified diff of `before` (undefined for a file that does not exist) against `after`, as one
 * hunk with three lines of context: everything between the first and the last changed line.
 * Empty when the two are the same.
 */
export function unifiedDiff(label: string, before: string | undefined, after: string): string {
  const a = before === undefined ? [] : splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return '';

  const from = Math.max(0, start - DIFF_CONTEXT_LINES);
  const afterA = Math.min(a.length, endA + DIFF_CONTEXT_LINES);
  const context = (lines: string[], first: number, last: number): string[] => lines.slice(first, last).map((line) => ` ${line}`);
  const body = [
    ...context(a, from, start),
    ...a.slice(start, endA).map((line) => `-${line}`),
    ...b.slice(start, endB).map((line) => `+${line}`),
    ...context(a, endA, afterA),
  ];
  const oldLength = (start - from) + (endA - start) + (afterA - endA);
  const newLength = (start - from) + (endB - start) + (afterA - endA);
  const first = (length: number): number => (length === 0 ? from : from + 1);
  return [
    `--- ${before === undefined ? '/dev/null' : label}`,
    `+++ ${label}`,
    `@@ -${first(oldLength)},${oldLength} +${first(newLength)},${newLength} @@`,
    ...body,
  ].join('\n');
}

export function timestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const MAX_BACKUP_SUFFIX = 100;

/**
 * Copy `path` byte for byte to `<path>.mcpkit-bak-<yyyymmddhhmmss>` (local time), readable by the owner only,
 * and return the backup's path. A backup of the same second is never overwritten: the next gets `-1`, `-2`, ....
 * A failure removes the partial copy.
 */
export async function backupFile(path: string, now: Date = new Date()): Promise<string> {
  const bytes = await readFile(path);
  for (let attempt = 0; attempt <= MAX_BACKUP_SUFFIX; attempt++) {
    const target = `${path}.mcpkit-bak-${timestamp(now)}${attempt === 0 ? '' : `-${attempt}`}`;
    let handle;
    try {
      handle = await open(target, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      await handle.writeFile(bytes);
      // The creation mode is cut by the umask, which may only narrow it; this makes it exact.
      await handle.chmod(0o600);
    } catch (err) {
      await handle.close();
      await rm(target, { force: true });
      throw err;
    }
    await handle.close();
    return target;
  }
  throw new Error(`could not pick a backup name for ${path}: ${MAX_BACKUP_SUFFIX} backups were made in the same second`);
}

/** Write the settings atomically (a symlinked file is written through), creating the directory and, for a new file, with the owner's permissions only. */
export async function writeSettings(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, text, { newFileMode: 0o600 });
}
