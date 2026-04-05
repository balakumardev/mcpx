import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveEnvVars, resolveHeaders, redirectSafeFetch } from './client.js';

describe('resolveEnvVars', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TEST_TOKEN = 'abc123';
    process.env.API_KEY = 'key456';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves a single env var', () => {
    expect(resolveEnvVars('${TEST_TOKEN}')).toBe('abc123');
  });

  it('resolves env var within a string', () => {
    expect(resolveEnvVars('Bearer ${TEST_TOKEN}')).toBe('Bearer abc123');
  });

  it('resolves multiple env vars', () => {
    expect(resolveEnvVars('${TEST_TOKEN}:${API_KEY}')).toBe('abc123:key456');
  });

  it('returns string unchanged when no env vars present', () => {
    expect(resolveEnvVars('plain-string')).toBe('plain-string');
  });

  it('throws when env var is not set', () => {
    expect(() => resolveEnvVars('${NONEXISTENT_VAR}')).toThrow(
      'Environment variable "NONEXISTENT_VAR" is not set',
    );
  });

  it('does not resolve $VAR without braces', () => {
    expect(resolveEnvVars('$TEST_TOKEN')).toBe('$TEST_TOKEN');
  });
});

describe('resolveHeaders', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.MY_TOKEN = 'tok_xyz';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves env vars in all header values', () => {
    const headers = {
      Authorization: 'Bearer ${MY_TOKEN}',
      'X-Custom': 'static-value',
    };
    const resolved = resolveHeaders(headers);
    expect(resolved).toEqual({
      Authorization: 'Bearer tok_xyz',
      'X-Custom': 'static-value',
    });
  });

  it('returns empty object for empty headers', () => {
    expect(resolveHeaders({})).toEqual({});
  });
});

describe('redirectSafeFetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('follows 302 redirect preserving POST method', async () => {
    const calls: Array<{ url: string | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://shard.example.com/mcp' } });
      }
      return new Response('ok', { status: 200 });
    }) as any;

    const response = await redirectSafeFetch('https://example.com/mcp', { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    // Second call should be to the redirect location with redirect: manual
    expect(calls[1].url.toString()).toBe('https://shard.example.com/mcp');
    expect(calls[1].init?.method).toBe('POST');
    expect(calls[1].init?.body).toBe('{}');
  });

  it('returns response directly for non-redirect status', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as any;

    const response = await redirectSafeFetch('https://example.com/mcp', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws after too many redirects', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://loop.example.com' } }),
    ) as any;

    await expect(redirectSafeFetch('https://example.com')).rejects.toThrow('Too many redirects');
  });
});
