import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessWatch, descendantsOf, parseProcessTable, type ProcessRow, type ProcessTableReader } from './reaper.js';

const table = [
  { pid: 10, ppid: 1 },
  { pid: 11, ppid: 10 },
  { pid: 12, ppid: 10 },
  { pid: 13, ppid: 11 },
  { pid: 14, ppid: 13 },
  { pid: 20, ppid: 1 },
  { pid: 21, ppid: 20 },
];

describe('descendantsOf', () => {
  it('finds children and grandchildren, parents first, and not the root or other trees', () => {
    expect(descendantsOf(10, table)).toEqual([11, 12, 13, 14]);
    expect(descendantsOf(20, table)).toEqual([21]);
  });

  it('finds nothing below a process without children, or one that is not listed', () => {
    expect(descendantsOf(14, table)).toEqual([]);
    expect(descendantsOf(999, table)).toEqual([]);
  });

  it('survives a table that loops', () => {
    expect(descendantsOf(1, [{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }])).toEqual([2]);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** A node process that starts a grandchild, and prints both pids. */
function startTree(sleepOnTerm = false): Promise<{ parent: ChildProcess; grandchild: number }> {
  const program = `
    const { spawn } = require('node:child_process');
    ${sleepOnTerm ? "process.on('SIGTERM', () => {});" : ''}
    const g = spawn(process.execPath, ['-e', ${JSON.stringify(sleepOnTerm ? "process.on('SIGTERM', () => {}); setTimeout(() => {}, 600000)" : 'setTimeout(() => {}, 600000)')}], { stdio: 'ignore' });
    console.log(g.pid);
    setTimeout(() => {}, 600000);
  `;
  const parent = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    parent.stdout?.once('data', (chunk: Buffer) => resolve({ parent, grandchild: Number(chunk.toString().trim()) }));
    parent.once('error', reject);
  });
}

const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
});

describe('createProcessWatch', () => {
  it('ends a child and its grandchild, and a grandchild whose parent died first', async () => {
    const { parent, grandchild } = await startTree();
    started.push(parent.pid!, grandchild);
    const watch = createProcessWatch(process.pid);
    watch.refresh();
    // The parent dies first: its child is orphaned, and only what was remembered can still find it.
    process.kill(parent.pid!, 'SIGKILL');
    expect(await until(() => parent.exitCode !== null || parent.signalCode !== null)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    await watch.reap(0);
    expect(await until(() => !alive(grandchild))).toBe(true);
  });

  it('asks first, and kills what ignores the request after the grace period', async () => {
    const { parent, grandchild } = await startTree(true);
    started.push(parent.pid!, grandchild);
    const watch = createProcessWatch(process.pid);
    const began = Date.now();
    await watch.reap(300);
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
    expect(await until(() => !alive(parent.pid!) && !alive(grandchild))).toBe(true);
  });

  it('ends a stopped process within the grace period, because SIGCONT lets it act on SIGTERM', async () => {
    const { parent, grandchild } = await startTree();
    started.push(parent.pid!, grandchild);
    process.kill(parent.pid!, 'SIGSTOP');
    process.kill(grandchild, 'SIGSTOP');
    const watch = createProcessWatch(process.pid);
    const began = Date.now();
    await watch.reap(5000);
    expect(Date.now() - began).toBeLessThan(2500);
    expect(await until(() => !alive(parent.pid!) && !alive(grandchild))).toBe(true);
  });

  it('does nothing, and returns at once, when there is nothing below the root', async () => {
    const began = Date.now();
    await createProcessWatch(2 ** 22 - 3).reap(2000);
    expect(Date.now() - began).toBeLessThan(500);
  });
});

describe('ProcessWatch.killAllSync', () => {
  it('kills everything below the root before it returns', async () => {
    const { parent, grandchild } = await startTree();
    started.push(parent.pid!, grandchild);
    createProcessWatch(process.pid).killAllSync();
    expect(await until(() => !alive(parent.pid!) && !alive(grandchild))).toBe(true);
  });

  it('kills a remembered process whose parent died, which a fresh walk below the root cannot find', async () => {
    const { parent, grandchild } = await startTree(true);
    started.push(parent.pid!, grandchild);
    const watch = createProcessWatch(process.pid);
    watch.refresh();
    process.kill(parent.pid!, 'SIGKILL');
    expect(await until(() => parent.exitCode !== null || parent.signalCode !== null)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    // The orphan is now a child of init: only what the watch remembered leads to it.
    createProcessWatch(process.pid).killAllSync();
    expect(alive(grandchild)).toBe(true);
    watch.killAllSync();
    expect(await until(() => !alive(grandchild))).toBe(true);
  });
});

describe('parseProcessTable', () => {
  const listing = [
    '    1     0 Thu Nov 12 06:51:04 2026    ',
    '  216     1 Mon Nov  9 07:25:08 2026',
    '98123 98001 Thu Nov 19 15:47:50 2026',
    'garbage line',
    '',
  ].join('\n');

  it('reads pid, ppid and the start time, whatever the padding of the day', () => {
    expect(parseProcessTable(listing)).toEqual([
      { pid: 1, ppid: 0, started: 'Thu Nov 12 06:51:04 2026' },
      { pid: 216, ppid: 1, started: 'Mon Nov 9 07:25:08 2026' },
      { pid: 98123, ppid: 98001, started: 'Thu Nov 19 15:47:50 2026' },
    ]);
  });

  it('leaves the start time out when ps could not print it, and drops the ps that ran', () => {
    expect(parseProcessTable('  10  1\n  11  10  \n', 11)).toEqual([{ pid: 10, ppid: 1 }]);
  });
});

/** A table reader that plays the given tables in turn and then repeats the last one. */
function playing(...tables: Array<ProcessRow[] | undefined>): ProcessTableReader {
  let next = 0;
  return () => tables[Math.min(next++, tables.length - 1)];
}

/** An unrelated process of ours that a stale pid could be mistaken for. */
function startSleeper(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  started.push(child.pid!);
  return child.pid!;
}

const FAKE_ROOT = 4_000_001;
const FIRST = 'Thu Nov 19 15:47:50 2026';
const LATER = 'Thu Nov 19 16:03:12 2026';

/** A table reader the test steers: what it returns is whatever `table.rows` holds at the time of the read. */
function steered(initial: ProcessRow[] | undefined): { table: { rows: ProcessRow[] | undefined }; read: ProcessTableReader } {
  const table = { rows: initial };
  return { table, read: () => table.rows };
}

describe('ProcessWatch only signals the process it saw, never another one that got its pid', () => {
  it('does not kill a pid that now belongs to a process with another start time, and forgets it for good', async () => {
    const victim = startSleeper();
    const control = startSleeper();
    const { table, read } = steered([{ pid: victim, ppid: FAKE_ROOT, started: FIRST }, { pid: control, ppid: FAKE_ROOT, started: FIRST }]);
    const watch = createProcessWatch(FAKE_ROOT, read);
    watch.refresh();
    // The victim's pid is reused: same number, another process, another start time. The control is untouched.
    table.rows = [{ pid: victim, ppid: 1, started: LATER }, { pid: control, ppid: FAKE_ROOT, started: FIRST }];
    watch.killAllSync();
    expect(await until(() => !alive(control))).toBe(true);
    expect(alive(victim)).toBe(true);
    // Even if the old start time shows up again later, a pid that did not match once is not remembered.
    table.rows = [{ pid: victim, ppid: 1, started: FIRST }];
    watch.killAllSync();
    expect(await until(() => !alive(victim), 400)).toBe(false);
  });

  it('treats a start time one second off as the same process, and one five seconds off as another', async () => {
    const same = startSleeper();
    const other = startSleeper();
    const { table, read } = steered([
      { pid: same, ppid: FAKE_ROOT, started: 'Thu Nov 19 15:47:50 2026' },
      { pid: other, ppid: FAKE_ROOT, started: 'Thu Nov 19 15:47:50 2026' },
    ]);
    const watch = createProcessWatch(FAKE_ROOT, read);
    watch.refresh();
    table.rows = [
      { pid: same, ppid: 1, started: 'Thu Nov 19 15:47:51 2026' },
      { pid: other, ppid: 1, started: 'Thu Nov 19 15:47:55 2026' },
    ];
    watch.killAllSync();
    expect(await until(() => !alive(same))).toBe(true);
    expect(alive(other)).toBe(true);
  });

  it('does not terminate it in reap() either, whatever the grace period', async () => {
    const victim = startSleeper();
    const control = startSleeper();
    const { table, read } = steered([{ pid: victim, ppid: FAKE_ROOT, started: FIRST }, { pid: control, ppid: FAKE_ROOT, started: FIRST }]);
    const watch = createProcessWatch(FAKE_ROOT, read);
    watch.refresh();
    table.rows = [{ pid: victim, ppid: 1, started: LATER }, { pid: control, ppid: FAKE_ROOT, started: FIRST }];
    await watch.reap(200);
    expect(await until(() => !alive(control))).toBe(true);
    expect(alive(victim)).toBe(true);
  });

  it('still kills a genuine orphan: its parent died and init adopted it, but its start time is the same', async () => {
    const orphan = startSleeper();
    const { table, read } = steered([{ pid: orphan, ppid: FAKE_ROOT, started: FIRST }]);
    const watch = createProcessWatch(FAKE_ROOT, read);
    watch.refresh();
    table.rows = [{ pid: orphan, ppid: 1, started: FIRST }];
    watch.killAllSync();
    expect(await until(() => !alive(orphan))).toBe(true);
  });

  it('forgets a pid that vanished from the table, so it is never signalled when the pid turns up again', async () => {
    const victim = startSleeper();
    const control = startSleeper();
    const { table, read } = steered([{ pid: victim, ppid: FAKE_ROOT, started: FIRST }, { pid: control, ppid: FAKE_ROOT, started: FIRST }]);
    const watch = createProcessWatch(FAKE_ROOT, read);
    watch.refresh();
    table.rows = [{ pid: control, ppid: FAKE_ROOT, started: FIRST }];
    watch.killAllSync();
    expect(await until(() => !alive(control))).toBe(true);
    // The pid is back with the very start time that was recorded, but it is neither remembered nor below the root.
    table.rows = [{ pid: victim, ppid: 1, started: FIRST }];
    watch.killAllSync();
    await watch.reap(0);
    expect(await until(() => !alive(victim), 400)).toBe(false);
  });

  it('kills a new process that took the pid when it is itself below the root', async () => {
    const newcomer = startSleeper();
    const { table, read } = steered([{ pid: newcomer, ppid: FAKE_ROOT, started: FIRST }]);
    const watch = createProcessWatch(FAKE_ROOT, read);
    watch.refresh();
    table.rows = [{ pid: newcomer, ppid: FAKE_ROOT, started: LATER }];
    watch.killAllSync();
    expect(await until(() => !alive(newcomer))).toBe(true);
  });

  it('signals nothing it cannot verify when the process table cannot be read', async () => {
    const victim = startSleeper();
    const { table, read } = steered([{ pid: victim, ppid: FAKE_ROOT, started: FIRST }]);
    const watch = createProcessWatch(FAKE_ROOT, read);
    watch.refresh();
    table.rows = undefined;
    watch.killAllSync();
    await watch.reap(100);
    expect(await until(() => !alive(victim), 400)).toBe(false);
    table.rows = [{ pid: victim, ppid: FAKE_ROOT, started: FIRST }];
    watch.killAllSync();
    expect(await until(() => !alive(victim))).toBe(true);
  });

  describe('where ps cannot print start times, a pid is only trusted while its parent is the one first seen', () => {
    it('does not kill a pid whose parent differs from the one recorded, and kills it when the parent matches', async () => {
      const victim = startSleeper();
      const { table, read } = steered([{ pid: victim, ppid: FAKE_ROOT }]);
      const watch = createProcessWatch(FAKE_ROOT, read);
      watch.refresh();
      table.rows = [{ pid: victim, ppid: 1 }];
      watch.killAllSync();
      expect(await until(() => !alive(victim), 400)).toBe(false);
      table.rows = [{ pid: victim, ppid: FAKE_ROOT }];
      watch.killAllSync();
      expect(await until(() => !alive(victim))).toBe(true);
    });
  });
});
