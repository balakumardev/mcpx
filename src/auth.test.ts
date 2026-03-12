import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpkitOAuthProvider } from './auth.js';

// Test credential storage via the provider class (uses in-memory store)
describe('McpkitOAuthProvider', () => {
  const serverUrl = 'https://mcp.example.com';

  it('returns undefined for clientInformation when no credentials stored', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {});
    expect(provider.clientInformation()).toBeUndefined();
  });

  it('returns undefined for tokens when no credentials stored', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {});
    expect(provider.tokens()).toBeUndefined();
  });

  it('returns empty string for codeVerifier when no credentials stored', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {});
    expect(provider.codeVerifier()).toBe('');
  });

  it('stores and retrieves client information in memory', async () => {
    const store: Record<string, any> = {};
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);

    const clientInfo = { client_id: 'test-id', client_secret: 'test-secret' };
    // saveClientInformation writes to disk, but we can test the in-memory state
    store[serverUrl] = { clientInfo };

    const freshProvider = new McpkitOAuthProvider(serverUrl, 9999, store);
    expect(freshProvider.clientInformation()).toEqual(clientInfo);
  });

  it('stores and retrieves tokens in memory', () => {
    const store: Record<string, any> = {};
    const tokens = { access_token: 'at_123', token_type: 'bearer', refresh_token: 'rt_456' };
    store[serverUrl] = { tokens };

    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);
    expect(provider.tokens()).toEqual(tokens);
  });

  it('has correct client metadata', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {});
    const meta = provider.clientMetadata;
    expect(meta.client_name).toBe('mcpkit');
    expect(meta.token_endpoint_auth_method).toBe('none');
    expect(meta.grant_types).toContain('authorization_code');
    expect(meta.grant_types).toContain('refresh_token');
    expect(meta.response_types).toContain('code');
  });

  it('has correct redirect URL', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 8765, {});
    expect(provider.redirectUrl.toString()).toBe('http://127.0.0.1:8765/callback');
  });

  it('invalidateCredentials clears all fields for scope "all"', async () => {
    const store: Record<string, any> = {};
    store[serverUrl] = {
      clientInfo: { client_id: 'x' },
      tokens: { access_token: 'y', token_type: 'bearer' },
      codeVerifier: 'z',
    };
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);
    // invalidateCredentials writes to disk — catch the error since ~/.mcpkit may not be writable in test
    try {
      await provider.invalidateCredentials('all');
    } catch {
      // disk write may fail in CI, in-memory state is still updated
    }
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.tokens()).toBeUndefined();
    expect(provider.codeVerifier()).toBe('');
  });
});
