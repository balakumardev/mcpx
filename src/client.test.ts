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

  it('appends configured hint to the error when env var is missing', () => {
    const hints = { NONEXISTENT_VAR: 'Run `make-token.sh` first' };
    expect(() => resolveEnvVars('${NONEXISTENT_VAR}', hints)).toThrow(
      /Environment variable "NONEXISTENT_VAR" is not set[\s\S]*Hint: Run `make-token\.sh` first/,
    );
  });

  it('does not append a hint when one is not provided for the missing var', () => {
    const hints = { OTHER_VAR: 'unrelated hint' };
    let captured: Error | undefined;
    try {
      resolveEnvVars('${NONEXISTENT_VAR}', hints);
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.message).not.toMatch(/Hint:/);
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

  it('forwards hints to the underlying resolveEnvVars call', () => {
    const headers = { Authorization: 'Bearer ${MISSING_HEADER_VAR}' };
    const hints = { MISSING_HEADER_VAR: 'Run mint-token.sh and export the result' };
    expect(() => resolveHeaders(headers, hints)).toThrow(/Hint: Run mint-token\.sh/);
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
