import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from './atomic-file.js';
import type { FileLockOptions } from './atomic-file.js';

/**
 * What mcpkit remembers between runs, in `~/.mcpkit/state.json`: which agents it has already moved to
 * the guide (so that it never does that twice) and whether the user turned the hook offer down. It is
 * a file of its own, not a key of `config.yaml`, because a published mcpkit that does not know a key
 * of that file drops it the next time it saves a setting.
 *
 * Shape: { "version": 1, "adopted": { "<agent>": { at, by, removed, backup, deferred, hookPending?, hookTried? } }, "hookDeclined": false,
 *          "fingerprint": "<hash>", "guideFiles": { "<agent>": { path, sig } },
 *          "refreshFingerprint": "<hash>", "refreshGuideFiles": { "<agent>": { path, sig } }, "lastNotice": { key, at } }
 *
 * `fingerprint` and `guideFiles` are written by the start-up reconcile after a full pass that finished
 * without a problem: they let the next run see, from `stat` data alone, that nothing has changed.
 * `refreshFingerprint` and `refreshGuideFiles` are the same for a refresh pass (the one `call` and `exec`
 * run, which adopts nothing): a refresh run takes the fast path on either record, a full run on the
 * full record only, so a refresh pass can never stand in for the adoption a full pass does.
 * `lastNotice` is the last failure notice it printed (a key of its text and when), so that a failure
 * that repeats on every command is not printed on every command.
 *
 * Nothing here ever throws. A file that is missing is an empty state; one that cannot be read, parsed
 * or understood is `usable: false` (an empty file included: a full disk can truncate one, and the
 * record of what was done and declined would be gone), and then `updateState` refuses to write: a
 * state that cannot be trusted is never replaced. Keys this version does not know are kept when the file is written.
 */

export const STATE_VERSION = 1;

/** What was done when mcpkit moved one agent to the guide. */
export interface AdoptedRecord {
  /** When, as an ISO timestamp. */
  at: string;
  /** The version of mcpkit that did it. */
  by: string;
  /** How many per-server skills were removed. */
  removed: number;
  /** The directory the removed skills were copied to, or null when there was nothing to back up. */
  backup: string | null;
  /**
   * The servers whose per-server skills were kept because their tools are not in the schema cache yet
   * (the skill holds the only copy of the tool list), or because another agent on per-server skills
   * reads the same file: they go once the cache exists and nobody shares them. Absent in a record
   * written before this field; read it with `deferredOf`.
   */
  deferred?: string[];
  /**
   * Claude Code only: the SessionStart hook is still to be installed. Written in the same state write
   * as the adoption (a crash before the hook step cannot lose it) and removed once the hook is installed,
   * was there already, or the user declined it.
   */
  hookPending?: boolean;
  /** The `<mtimeMs>:<size>` of `~/.claude/settings.json` (or `absent`) when the hook last failed: the hook is tried again only when the file differs. */
  hookTried?: string;
  [key: string]: unknown;
}

/** What `stat` said about one agent's guide file when the state was last stored. */
export interface GuideFileSignature {
  path: string;
  sig: string;
}

export interface McpkitState {
  version: typeof STATE_VERSION;
  adopted: Record<string, AdoptedRecord>;
  hookDeclined: boolean;
  /** A hash of every input the start-up reconcile reads (by `stat`), as of the last pass that finished without a problem. */
  fingerprint?: string;
  /** The guide files of the agents in guide mode at that pass. */
  guideFiles?: Record<string, GuideFileSignature>;
  /** `fingerprint`, for the last refresh pass (`call`, `exec`): a different record, so the full one keeps its meaning. */
  refreshFingerprint?: string;
  /** The guide files of the agents in guide mode at that refresh pass. */
  refreshGuideFiles?: Record<string, GuideFileSignature>;
  /** The last failure notice the start-up reconcile printed: a key of its text, and when (an ISO timestamp). */
  lastNotice?: { key: string; at: string };
  /** Keys of a newer mcpkit, kept as they are. */
  [key: string]: unknown;
}

/** `record.deferred` as a list of strings; anything else in the field counts as nothing deferred. */
export function deferredOf(record: AdoptedRecord): string[] {
  return Array.isArray(record.deferred) ? record.deferred.filter((name): name is string => typeof name === 'string') : [];
}

export interface LoadedState {
  state: McpkitState;
  /** False when the file exists but cannot be used; the state is then empty and must not be written back. */
  usable: boolean;
}

export function stateFilePath(): string {
  return join(homedir(), '.mcpkit', 'state.json');
}

function emptyState(): McpkitState {
  return { version: STATE_VERSION, adopted: {}, hookDeclined: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAdoptedRecord(value: unknown): value is AdoptedRecord {
  return isRecord(value)
    && typeof value.at === 'string'
    && typeof value.by === 'string'
    && typeof value.removed === 'number'
    && (value.backup === null || typeof value.backup === 'string');
}

/** `data` as a state, or undefined when it is not one (a wrong version, a key of the wrong type). Missing keys take their empty values. */
function toState(data: unknown): McpkitState | undefined {
  if (!isRecord(data) || data.version !== STATE_VERSION) return undefined;
  const adopted = data.adopted ?? {};
  if (!isRecord(adopted) || !Object.values(adopted).every(isAdoptedRecord)) return undefined;
  const hookDeclined = data.hookDeclined ?? false;
  if (typeof hookDeclined !== 'boolean') return undefined;
  const { version, adopted: _adopted, hookDeclined: _hookDeclined, ...rest } = data;
  // A fingerprint that is not text, or guide signatures that are not a mapping, only mean "no pass is on record": they never make the state unusable.
  if (typeof rest.fingerprint !== 'string') delete rest.fingerprint;
  if (rest.guideFiles !== undefined && !isRecord(rest.guideFiles)) delete rest.guideFiles;
  if (typeof rest.refreshFingerprint !== 'string') delete rest.refreshFingerprint;
  if (rest.refreshGuideFiles !== undefined && !isRecord(rest.refreshGuideFiles)) delete rest.refreshGuideFiles;
  // A last notice of another shape only means "none is on record".
  if (rest.lastNotice !== undefined && !(isRecord(rest.lastNotice) && typeof rest.lastNotice.key === 'string' && typeof rest.lastNotice.at === 'string')) delete rest.lastNotice;
  return { version, adopted: { ...adopted } as Record<string, AdoptedRecord>, hookDeclined, ...rest };
}

/** The state file. Synchronous and cheap: start-up reads it before it decides anything. */
export function loadState(): LoadedState {
  let text: string;
  try {
    text = readFileSync(stateFilePath(), 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: emptyState(), usable: true }
      : { state: emptyState(), usable: false };
  }
  try {
    const state = toState(JSON.parse(text));
    return state === undefined ? { state: emptyState(), usable: false } : { state, usable: true };
  } catch {
    return { state: emptyState(), usable: false };
  }
}

/**
 * Change the state as one step no other mcpkit process can interleave with: take the lock, read the
 * file fresh, let `change` edit the state in place or return a new one, write it atomically with
 * owner-only permissions. Returns whether it was written. False, and nothing written, when the file
 * cannot be used, when `change` throws or leaves something that is not a state, or when the lock or
 * the write fails. Never throws.
 */
export async function updateState(
  change: (state: McpkitState) => McpkitState | void,
  lockOptions?: FileLockOptions,
): Promise<boolean> {
  try {
    const path = stateFilePath();
    return await withFileLock(`${path}.lock`, async () => {
      const { state, usable } = loadState();
      if (!usable) return false;
      const next = toState(change(state) ?? state);
      if (next === undefined) return false;
      await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      return true;
    }, lockOptions);
  } catch {
    return false;
  }
}
