import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferredOf, loadState, stateFilePath, updateState } from './state.js';
import type { AdoptedRecord } from './state.js';

const record = (removed: number, backup: string | null = null): AdoptedRecord => ({ at: '2026-11-20T10:00:00.000Z', by: '0.1.33', removed, backup });

describe('state file', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home = '';

  const writeState = async (text: string) => {
    await mkdir(join(home, '.mcpkit'), { recursive: true });
    await writeFile(stateFilePath(), text, 'utf-8');
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-state-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await chmod(home, 0o755).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  it('lives in ~/.mcpkit/state.json, resolved from the home at the time of the call', () => {
    expect(stateFilePath()).toBe(join(home, '.mcpkit', 'state.json'));
  });

  describe('loadState', () => {
    it('treats a missing file as an empty, usable state, and writes nothing', async () => {
      expect(loadState()).toEqual({ state: { version: 1, adopted: {}, hookDeclined: false }, usable: true });
      expect(await readdir(home)).toEqual([]);
    });

    it.each(['', '  \n'])('is unusable for an empty file (%j): a truncated state must not read as nothing adopted and nothing declined', async (text) => {
      await writeState(text);
      expect(loadState()).toEqual({ state: { version: 1, adopted: {}, hookDeclined: false }, usable: false });
    });

    it('does not write over an empty file either', async () => {
      await writeState('');
      expect(await updateState((state) => { state.hookDeclined = true; })).toBe(false);
      expect(await readFile(stateFilePath(), 'utf-8')).toBe('');
    });

    it('reads a state that was written', async () => {
      await writeState(JSON.stringify({ version: 1, adopted: { 'claude-code': record(3, '/b') }, hookDeclined: true }));
      expect(loadState()).toEqual({
        state: { version: 1, adopted: { 'claude-code': record(3, '/b') }, hookDeclined: true },
        usable: true,
      });
    });

    it('fills in the keys a file leaves out', async () => {
      await writeState(JSON.stringify({ version: 1 }));
      expect(loadState()).toEqual({ state: { version: 1, adopted: {}, hookDeclined: false }, usable: true });
    });

    it.each([
      ['text that is not JSON', '{ not json'],
      ['a list', '[]'],
      ['a scalar', '42'],
      ['null', 'null'],
      ['another version', JSON.stringify({ version: 2, adopted: {}, hookDeclined: false })],
      ['no version', JSON.stringify({ adopted: {}, hookDeclined: false })],
      ['adopted of the wrong type', JSON.stringify({ version: 1, adopted: [], hookDeclined: false })],
      ['an adopted entry of the wrong shape', JSON.stringify({ version: 1, adopted: { cursor: { at: 1 } }, hookDeclined: false })],
      ['hookDeclined of the wrong type', JSON.stringify({ version: 1, adopted: {}, hookDeclined: 'yes' })],
    ])('is unusable, with an empty state and no throw, for %s', async (_label, text) => {
      await writeState(text);
      expect(loadState()).toEqual({ state: { version: 1, adopted: {}, hookDeclined: false }, usable: false });
    });

    it('is unusable when the path is a directory', async () => {
      await mkdir(stateFilePath(), { recursive: true });
      expect(loadState().usable).toBe(false);
    });
  });

  describe('updateState', () => {
    it('creates the file, owner-only, and leaves neither a temp file nor a lock behind', async () => {
      expect(await updateState((state) => { state.hookDeclined = true; })).toBe(true);

      expect(JSON.parse(await readFile(stateFilePath(), 'utf-8'))).toEqual({ version: 1, adopted: {}, hookDeclined: true });
      expect((await stat(stateFilePath())).mode & 0o777).toBe(0o600);
      expect(await readdir(join(home, '.mcpkit'))).toEqual(['state.json']);
      expect(loadState().state.hookDeclined).toBe(true);
    });

    it('accepts a new state returned instead of an edit in place', async () => {
      expect(await updateState((state) => ({ ...state, adopted: { cursor: record(0) } }))).toBe(true);
      expect(loadState().state.adopted).toEqual({ cursor: record(0) });
    });

    it('keeps keys it does not know, at the top and inside an entry', async () => {
      await writeState(JSON.stringify({
        version: 1,
        adopted: { codex: { ...record(1), note: 'by hand' } },
        hookDeclined: false,
        futureKey: { a: [1, 2] },
      }));

      expect(await updateState((state) => { state.adopted.cursor = record(2); })).toBe(true);

      const written = JSON.parse(await readFile(stateFilePath(), 'utf-8')) as Record<string, unknown>;
      expect(written.futureKey).toEqual({ a: [1, 2] });
      expect(written.adopted).toEqual({ codex: { ...record(1), note: 'by hand' }, cursor: record(2) });
    });

    it('refuses to write, and leaves the file as it is, when the file cannot be used', async () => {
      const text = '{ corrupt';
      await writeState(text);
      let called = false;

      expect(await updateState(() => { called = true; })).toBe(false);

      expect(called).toBe(false);
      expect(await readFile(stateFilePath(), 'utf-8')).toBe(text);
    });

    it('returns false, writes nothing, and does not throw when the change throws', async () => {
      await updateState((state) => { state.hookDeclined = true; });
      const before = await readFile(stateFilePath(), 'utf-8');

      expect(await updateState(() => { throw new Error('boom'); })).toBe(false);

      expect(await readFile(stateFilePath(), 'utf-8')).toBe(before);
    });

    it('returns false, and writes nothing, when the change leaves something that is not a state', async () => {
      const before = loadState();
      expect(await updateState((state) => ({ ...state, version: 2 }) as never)).toBe(false);
      expect(await updateState((state) => ({ ...state, hookDeclined: 'yes' }) as never)).toBe(false);
      expect(loadState()).toEqual(before);
      expect(await readdir(join(home, '.mcpkit'))).toEqual([]);
    });

    it('returns false instead of throwing when the lock cannot be taken', async () => {
      await mkdir(join(home, '.mcpkit', 'state.json.lock'), { recursive: true });
      expect(await updateState((state) => { state.hookDeclined = true; }, { timeoutMs: 150, retryMs: 20, staleMs: 60_000 })).toBe(false);
      expect(loadState().state.hookDeclined).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)('returns false instead of throwing when the home is read-only', async () => {
      await chmod(home, 0o555);
      expect(await updateState((state) => { state.hookDeclined = true; })).toBe(false);
    });

    it('loses nothing when 8 updates run at once', async () => {
      const agents = ['claude-code', 'cursor', 'codex', 'windsurf', 'augment', 'openclaw', 'hermes', 'extra'];

      const results = await Promise.all(agents.map((agent, index) => updateState((state) => {
        state.adopted[agent] = record(index, `/backup/${agent}`);
      })));

      expect(results).toEqual(agents.map(() => true));
      const { state, usable } = loadState();
      expect(usable).toBe(true);
      expect(Object.keys(state.adopted).sort()).toEqual([...agents].sort());
      agents.forEach((agent, index) => expect(state.adopted[agent]).toEqual(record(index, `/backup/${agent}`)));
      expect(await readdir(join(home, '.mcpkit'))).toEqual(['state.json']);
    });
  });
});

describe('state file: what the start-up reconcile stores', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home = '';

  const writeState = async (value: unknown) => {
    await mkdir(join(home, '.mcpkit'), { recursive: true });
    await writeFile(stateFilePath(), JSON.stringify(value), 'utf-8');
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-state-reconcile-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(home, { recursive: true, force: true });
  });

  it('keeps `deferred`, the fingerprint and the guide signatures through an update, with the keys it does not know', async () => {
    const adopted = { 'claude-code': { ...record(2, '/b'), deferred: ['c'], futureField: 1 } };
    await writeState({ version: 1, adopted, hookDeclined: false, fingerprint: 'abc', guideFiles: { cursor: { path: '/g', sig: '1' } }, other: [1] });

    expect(await updateState((state) => { state.hookDeclined = true; })).toBe(true);

    expect(JSON.parse(await readFile(stateFilePath(), 'utf-8'))).toEqual({
      version: 1, adopted, hookDeclined: true, fingerprint: 'abc', guideFiles: { cursor: { path: '/g', sig: '1' } }, other: [1],
    });
  });

  it.each([
    ['a number', 5],
    ['an object', { a: 1 }],
    ['null', null],
  ])('a fingerprint that is %s means no pass is on record, and does not make the state unusable', async (_label, fingerprint) => {
    await writeState({ version: 1, adopted: {}, hookDeclined: false, fingerprint });
    const { state, usable } = loadState();
    expect(usable).toBe(true);
    expect(state.fingerprint).toBeUndefined();
  });

  it('guide signatures that are not a mapping are dropped, and the state stays usable', async () => {
    await writeState({ version: 1, adopted: {}, hookDeclined: false, fingerprint: 'abc', guideFiles: ['x'] });
    const { state, usable } = loadState();
    expect(usable).toBe(true);
    expect(state.guideFiles).toBeUndefined();
    expect(state.fingerprint).toBe('abc');
  });

  it('keeps the refresh pass record and a pending hook through an update, and reads a refresh record of another shape as none without making the state unusable', async () => {
    const adopted = { 'claude-code': { ...record(2, '/b'), hookPending: true, hookTried: '1763632800000:12' } };
    const refresh = { refreshFingerprint: 'def', refreshGuideFiles: { cursor: { path: '/g', sig: '2' } } };
    await writeState({ version: 1, adopted, hookDeclined: false, fingerprint: 'abc', ...refresh });
    expect(await updateState((state) => { state.hookDeclined = true; })).toBe(true);
    expect(JSON.parse(await readFile(stateFilePath(), 'utf-8'))).toEqual({ version: 1, adopted, hookDeclined: true, fingerprint: 'abc', ...refresh });

    await writeState({ version: 1, adopted: {}, hookDeclined: false, fingerprint: 'abc', refreshFingerprint: 5, refreshGuideFiles: ['x'] });
    const { state, usable } = loadState();
    expect(usable).toBe(true);
    expect(state.refreshFingerprint).toBeUndefined();
    expect(state.refreshGuideFiles).toBeUndefined();
    expect(state.fingerprint).toBe('abc');
  });

  it('keeps the last notice through an update, and reads one of another shape as none without making the state unusable', async () => {
    await writeState({ version: 1, adopted: {}, hookDeclined: false, lastNotice: { key: 'k', at: '2026-11-20T10:00:00.000Z' } });
    expect(loadState().state.lastNotice).toEqual({ key: 'k', at: '2026-11-20T10:00:00.000Z' });
    expect(await updateState((state) => { state.hookDeclined = true; })).toBe(true);
    expect(JSON.parse(await readFile(stateFilePath(), 'utf-8')).lastNotice).toEqual({ key: 'k', at: '2026-11-20T10:00:00.000Z' });

    for (const lastNotice of [5, 'k', null, [], { key: 'k' }, { key: 1, at: 'x' }, { at: 'x' }]) {
      await writeState({ version: 1, adopted: {}, hookDeclined: false, lastNotice });
      const { state, usable } = loadState();
      expect(usable, JSON.stringify(lastNotice)).toBe(true);
      expect(state.lastNotice, JSON.stringify(lastNotice)).toBeUndefined();
    }
  });

  it('reads `deferred` as a list of names, and anything else in it as none (a record from before the field has none)', () => {
    expect(deferredOf(record(1))).toEqual([]);
    expect(deferredOf({ ...record(1), deferred: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(deferredOf({ ...record(1), deferred: ['a', 3, null, 'b'] as unknown as string[] })).toEqual(['a', 'b']);
    expect(deferredOf({ ...record(1), deferred: 'a' as unknown as string[] })).toEqual([]);
  });
});
