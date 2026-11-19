import { spawnSync } from 'node:child_process';

/**
 * Ends the processes `mcpkit exec` started: the sandbox child, the MCP server children and
 * whatever those spawned (`npx` runs the real server one level down).
 *
 * The SDK closes a stdio session by ending the server's stdin, waiting up to 2 s for it to
 * exit, sending SIGTERM, waiting 2 s more, then SIGKILL. A server that is stuck or stopped
 * (SIGSTOP never delivers SIGTERM) makes that take seconds, and the wait is also held up by any
 * grandchild that still holds the server's pipes. When a run is over for good (time limit,
 * interrupt, failure) none of that waiting helps, so the tree is ended directly.
 *
 * The servers are not spawned as process-group leaders, so they share the group of `mcpkit`
 * itself (and with it the user's shell job): signalling the group would kill `mcpkit` too.
 * The tree is found through the process table instead, and it must be read BEFORE anything is
 * signalled: a dead parent re-parents its children to init, and the walk loses them.
 *
 * A remembered pid can outlive its process, and the OS may hand the number to an unrelated
 * process of the same user. So a process is remembered by pid AND start time, and immediately
 * before every signal the table is read again: only a pid that is present with the start time
 * that was recorded is signalled, anything else is forgotten. (Where `ps` cannot print start
 * times, the pair pid + parent-at-discovery stands in; an orphan, whose parent has changed, is
 * then no longer matched and is left alone rather than risk another process.)
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The process's start time as `ps` prints it (`lstart`), whitespace-normalised; absent where `ps` cannot print it. */
  started?: string;
}

/** Reads the process table; undefined where it cannot be read (no `ps`, as on Windows). */
export type ProcessTableReader = () => ProcessRow[] | undefined;

/** Parses `ps -A -o pid=,ppid=[,lstart=]` output. `ownPid` (the `ps` that just ran, gone again by now) is left out. */
export function parseProcessTable(listing: string, ownPid?: number): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(\S.*?))?\s*$/.exec(line);
    if (match === null || Number(match[1]) === ownPid) continue;
    const started = match[3]?.replace(/\s+/g, ' ');
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), ...(started === undefined ? {} : { started }) });
  }
  return rows;
}

function runPs(columns: string): ProcessRow[] | undefined {
  const listing = spawnSync('ps', ['-A', '-o', columns], { encoding: 'utf-8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
  if (listing.error !== undefined || listing.status !== 0 || typeof listing.stdout !== 'string') return undefined;
  return parseProcessTable(listing.stdout, listing.pid);
}

/** The system process table with start times, or without them where this `ps` does not know `lstart`. */
export const readProcessTable: ProcessTableReader = () => runPs('pid=,ppid=,lstart=') ?? runPs('pid=,ppid=');

/** Every process below `root`, children before grandchildren; `root` itself is not included. */
export function descendantsOf(root: number, table: readonly ProcessRow[]): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const row of table) {
    const siblings = childrenOf.get(row.ppid);
    if (siblings === undefined) childrenOf.set(row.ppid, [row.pid]);
    else siblings.push(row.pid);
  }
  const found: number[] = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of childrenOf.get(next) ?? []) {
      if (found.includes(child) || child === root) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone, or not ours to signal: nothing to do.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is somebody else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const POLL_MS = 20;

/** What was seen of a process when it was first found below the root. */
interface Identity {
  ppid: number;
  started: string | undefined;
}

/** `lstart` has one-second resolution, and on Linux the same process can read a second apart between two listings. */
const START_TOLERANCE_MS = 1000;

function sameStart(recorded: string, now: string): boolean {
  if (recorded === now) return true;
  const difference = Math.abs(Date.parse(recorded) - Date.parse(now));
  return difference <= START_TOLERANCE_MS;
}

/** Whether `row` is still the process that was recorded as `known`, or another one that now has its pid. */
function sameProcess(known: Identity, row: ProcessRow): boolean {
  if (known.started !== undefined && row.started !== undefined) return sameStart(known.started, row.started);
  return known.ppid === row.ppid;
}

/** The processes below one root, remembered, so that ones whose parent has died since are still found. */
export interface ProcessWatch {
  /** Remember every process below the root right now. Synchronous. */
  refresh(): void;
  /** SIGKILL every remembered process that is still the one that was seen, and everything below the root right now. Synchronous. */
  killAllSync(): void;
  /**
   * Ask everything remembered (and anything new below the root) to exit with SIGTERM, plus SIGCONT so
   * a stopped process can act on it, wait at most `graceMs` for them to go, then SIGKILL what is
   * left. `graceMs` of 0 kills at once.
   */
  reap(graceMs: number): Promise<void>;
}

/**
 * A server that exits when its stdin closes leaves its own children running (they hold its
 * pipes), and an orphan is no longer below anything: the tree has to be read before the server
 * goes, which is what `refresh` is for. `readTable` is a parameter so a test can play a pid being
 * reused.
 */
export function createProcessWatch(root: number = process.pid, readTable: ProcessTableReader = readProcessTable): ProcessWatch {
  const known = new Map<number, Identity>();

  /**
   * Re-read the table, forget every remembered pid that is gone or is now another process, remember
   * the processes below the root, and return the pids that are safe to signal right now. Undefined
   * when the table cannot be read: nothing can then be verified, so nothing is signalled.
   */
  const verify = (): number[] | undefined => {
    const table = readTable();
    if (table === undefined) return undefined;
    const rows = new Map(table.map((row) => [row.pid, row] as const));
    for (const [pid, identity] of known) {
      const row = rows.get(pid);
      if (row === undefined || !sameProcess(identity, row)) known.delete(pid);
    }
    for (const pid of descendantsOf(root, table)) {
      const row = rows.get(pid);
      if (row !== undefined && !known.has(pid)) known.set(pid, { ppid: row.ppid, started: row.started });
    }
    return [...known.keys()];
  };

  const killAllSync = (): void => {
    // A process can fork between the listing and the kill, so look again until nothing is left.
    for (let pass = 0; pass < 3; pass++) {
      const targets = verify();
      if (targets === undefined || targets.length === 0) break;
      signal(targets, 'SIGKILL');
    }
  };

  return {
    refresh() {
      verify();
    },
    killAllSync,
    async reap(graceMs) {
      if (graceMs > 0) {
        const targets = verify();
        if (targets === undefined || targets.length === 0) return;
        signal(targets, 'SIGTERM');
        signal(targets, 'SIGCONT');
        // Only a wait: a reused pid can make this last the whole grace period, it cannot make anything be signalled.
        const until = Date.now() + graceMs;
        while (Date.now() < until && targets.some(alive)) {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
        }
      }
      killAllSync();
    },
  };
}
