import { describe, expect, it } from 'vitest';
import { isStale, skillAgeSec } from './auto-refresh.js';
import { DEFAULT_AUTO_REFRESH_TTL_SEC } from './types.js';
import type { ServerEntry } from './types.js';

function makeEntry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  const now = new Date().toISOString();
  return {
    name: 'srv',
    transport: { type: 'stdio', command: 'npx', args: [] },
    toolCount: 1,
    agents: ['claude-code'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('auto-refresh staleness', () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it('reports age in seconds from lastRefreshedAt when present', () => {
    const entry = makeEntry({
      updatedAt: iso(1000 * 1000),
      autoRefresh: { enabled: true, lastRefreshedAt: iso(60_000) },
    });
    // Should use lastRefreshedAt (60s), not updatedAt (1000s)
    expect(skillAgeSec(entry, now)).toBeGreaterThanOrEqual(59);
    expect(skillAgeSec(entry, now)).toBeLessThanOrEqual(61);
  });

  it('falls back to updatedAt when no lastRefreshedAt', () => {
    const entry = makeEntry({ updatedAt: iso(120_000) });
    expect(skillAgeSec(entry, now)).toBeGreaterThanOrEqual(119);
  });

  it('is not stale within the default TTL', () => {
    const entry = makeEntry({ updatedAt: iso(60_000) }); // 60s old
    expect(isStale(entry, now)).toBe(false);
  });

  it('is stale once past the default TTL', () => {
    const entry = makeEntry({ updatedAt: iso((DEFAULT_AUTO_REFRESH_TTL_SEC + 60) * 1000) });
    expect(isStale(entry, now)).toBe(true);
  });

  it('honors a custom ttlSec', () => {
    const entry = makeEntry({
      updatedAt: iso(120_000), // 120s old
      autoRefresh: { enabled: true, ttlSec: 60 },
    });
    expect(isStale(entry, now)).toBe(true);
  });

  it('treats an unparseable timestamp as maximally stale', () => {
    const entry = makeEntry({ updatedAt: 'not-a-date' });
    expect(isStale(entry, now)).toBe(true);
  });
});
