import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveEnvVars, resolveHeaders } from './client.js';

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
