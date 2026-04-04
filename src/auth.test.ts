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
    expect(provider.redirectUrl.toString()).toBe('http://localhost:8765/callback');
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

  // --- Pre-configured OAuth tests ---

  it('returns pre-configured clientId from clientInformation when no stored credentials', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {}, { clientId: 'slack-client-id' });
    const info = provider.clientInformation();
    expect(info).toEqual({ client_id: 'slack-client-id' });
  });

  it('returns pre-configured clientId and clientSecret together', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {}, {
      clientId: 'my-client',
      clientSecret: 'my-secret',
    });
    const info = provider.clientInformation();
    expect(info).toEqual({ client_id: 'my-client', client_secret: 'my-secret' });
  });

  it('prefers stored clientInfo over pre-configured clientId', () => {
    const store: Record<string, any> = {};
    store[serverUrl] = { clientInfo: { client_id: 'stored-id', client_secret: 'stored-secret' } };
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store, { clientId: 'preconfigured-id' });
    expect(provider.clientInformation()).toEqual({ client_id: 'stored-id', client_secret: 'stored-secret' });
  });

  it('uses callbackPort in redirect URL', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 3118, {}, { callbackPort: 3118 });
    expect(provider.redirectUrl.toString()).toBe('http://localhost:3118/callback');
  });

  it('sets token_endpoint_auth_method to client_secret_post when clientSecret is provided', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {}, {
      clientId: 'my-client',
      clientSecret: 'my-secret',
    });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
  });

  it('sets token_endpoint_auth_method to none when no clientSecret', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {}, { clientId: 'my-client' });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none');
  });

  // --- Token expiry tests ---

  it('hasValidTokens returns false when no tokens', () => {
    const provider = new McpkitOAuthProvider(serverUrl, 9999, {});
    expect(provider.hasValidTokens()).toBe(false);
  });

  it('hasValidTokens returns true when tokens exist but no tokenIssuedAt (legacy tokens)', () => {
    const store: Record<string, any> = {};
    store[serverUrl] = {
      tokens: { access_token: 'at_123', token_type: 'bearer', expires_in: 43200 },
    };
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);
    expect(provider.hasValidTokens()).toBe(true);
  });

  it('hasValidTokens returns true when token is fresh', () => {
    const store: Record<string, any> = {};
    store[serverUrl] = {
      tokens: { access_token: 'at_123', token_type: 'bearer', expires_in: 43200 },
      tokenIssuedAt: Date.now(),
    };
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);
    expect(provider.hasValidTokens()).toBe(true);
  });

  it('hasValidTokens returns false when token is expired', () => {
    const store: Record<string, any> = {};
    store[serverUrl] = {
      tokens: { access_token: 'at_123', token_type: 'bearer', expires_in: 3600 },
      tokenIssuedAt: Date.now() - 4000 * 1000, // issued 4000s ago, expires_in is 3600s
    };
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);
    expect(provider.hasValidTokens()).toBe(false);
  });

  it('hasValidTokens returns false within 5-minute buffer before expiry', () => {
    const store: Record<string, any> = {};
    store[serverUrl] = {
      tokens: { access_token: 'at_123', token_type: 'bearer', expires_in: 3600 },
      // issued 56 minutes ago — 4 minutes left, within 5-minute buffer
      tokenIssuedAt: Date.now() - 56 * 60 * 1000,
    };
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);
    expect(provider.hasValidTokens()).toBe(false);
  });

  it('saveTokens sets tokenIssuedAt', async () => {
    const store: Record<string, any> = {};
    store[serverUrl] = {};
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);
    const before = Date.now();
    try {
      await provider.saveTokens({ access_token: 'new', token_type: 'bearer', expires_in: 3600 });
    } catch {
      // disk write may fail in CI
    }
    const after = Date.now();
    expect(store[serverUrl].tokenIssuedAt).toBeGreaterThanOrEqual(before);
    expect(store[serverUrl].tokenIssuedAt).toBeLessThanOrEqual(after);
  });

  it('invalidateCredentials tokens clears tokenIssuedAt', async () => {
    const store: Record<string, any> = {};
    store[serverUrl] = {
      tokens: { access_token: 'at_123', token_type: 'bearer' },
      tokenIssuedAt: Date.now(),
    };
    const provider = new McpkitOAuthProvider(serverUrl, 9999, store);
    try {
      await provider.invalidateCredentials('tokens');
    } catch {
      // disk write may fail in CI
    }
    expect(provider.tokens()).toBeUndefined();
    expect(provider.hasValidTokens()).toBe(false);
  });
});
