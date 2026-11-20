import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEntry, TransportConfig } from '../types.js';
import { redactMessage, scrubSecrets, secretValuesOf } from './redact.js';

function entryFor(transport: TransportConfig, extra: Partial<ServerEntry> = {}): ServerEntry {
  return {
    name: 'fx',
    transport,
    toolCount: 0,
    agents: ['cursor'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const httpEntry = (url: string, headers?: Record<string, string>): ServerEntry =>
  entryFor({ type: 'http', url, ...(headers === undefined ? {} : { headers }) });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('redactMessage: a credential in the URL path', () => {
  const TOKEN = 'PATHTOKEN-abcdef123456';

  it('hides the token and the path around it when a server echoes the path back', () => {
    const entry = httpEntry(`http://127.0.0.1:4000/mcp/${TOKEN}`);
    const cleaned = redactMessage(entry, `Streamable HTTP error: Cannot POST /mcp/${TOKEN}`);
    expect(cleaned).toBe('Streamable HTTP error: Cannot POST <redacted>');
  });

  it('hides the token when only the segment is quoted', () => {
    const entry = httpEntry(`http://127.0.0.1:4000/mcp/${TOKEN}`);
    expect(redactMessage(entry, `unknown token ${TOKEN} rejected`)).toBe('unknown token <redacted> rejected');
  });

  it('hides it with a trailing slash in the configuration, and whichever way the message quotes it', () => {
    const entry = httpEntry(`http://127.0.0.1:4000/mcp/${TOKEN}/`);
    for (const quoted of [`/mcp/${TOKEN}/`, `/mcp/${TOKEN}`, TOKEN]) {
      expect(redactMessage(entry, `Cannot POST ${quoted}`)).not.toContain(TOKEN);
    }
  });

  it('hides a percent-encoded token as written and as decoded', () => {
    const entry = httpEntry('https://host.example/mcp/p%C3%A4ss-w0rd%2F1234');
    for (const quoted of ['p%C3%A4ss-w0rd%2F1234', 'päss-w0rd/1234']) {
      const cleaned = redactMessage(entry, `bad path ${quoted} here`);
      expect(cleaned).toBe('bad path <redacted> here');
    }
  });

  it('hides a token path and a query together', () => {
    const entry = httpEntry(`https://host.example/mcp/${TOKEN}?api_key=QUERYKEY-998877`);
    const cleaned = redactMessage(entry, `GET https://host.example/mcp/${TOKEN}?api_key=QUERYKEY-998877 failed; path ${TOKEN}; key QUERYKEY-998877`);
    expect(cleaned).toBe('GET https://host.example<redacted><redacted> failed; path <redacted>; key <redacted>');
  });

  it('hides each long segment on its own when the path has several', () => {
    const entry = httpEntry('https://host.example/tenant-4711x/mcp/SECRETSEGMENT99');
    const cleaned = redactMessage(entry, 'tenant tenant-4711x, token SECRETSEGMENT99');
    expect(cleaned).toBe('tenant <redacted>, token <redacted>');
  });

  it.each([
    ['/mcp', 'POST https://host.example/mcp failed'],
    ['/sse', 'GET https://host.example/sse failed'],
    ['/api/v1/mcp', 'POST https://host.example/api/v1/mcp failed'],
    ['/v1/rpc', 'POST https://host.example/v1/rpc failed'],
    ['/mcp/v1/sse', 'GET https://host.example/mcp/v1/sse failed'],
    ['/api/messages', 'POST https://host.example/api/messages failed'],
    ['/mcp/stream/events', 'GET https://host.example/mcp/stream/events failed'],
  ])('leaves a path of ordinary words alone: %s', (path, message) => {
    expect(redactMessage(httpEntry(`https://host.example${path}`), message)).toBe(message);
  });

  it('does not blank an ordinary word elsewhere in a message because the path has a token', () => {
    const entry = httpEntry(`https://host.example/mcp/${TOKEN}`);
    expect(redactMessage(entry, `the mcp endpoint answered 404 for ${TOKEN}`)).toBe('the mcp endpoint answered 404 for <redacted>');
  });

  it('ignores a segment shorter than the length cut-off, as it does for every other value', () => {
    const entry = httpEntry('https://host.example/mcp/ab12');
    expect(redactMessage(entry, 'POST /mcp/ab12 failed')).toBe('POST /mcp/ab12 failed');
  });

  it('hides a long segment that is not on the list of ordinary words, even a plain word', () => {
    const entry = httpEntry('https://host.example/workspace/mcp');
    expect(redactMessage(entry, 'POST /workspace/mcp failed')).toBe('POST <redacted> failed');
  });

  it('adds nothing for a stdio server or an address that does not parse', () => {
    expect(secretValuesOf(entryFor({ type: 'stdio', command: 'node', args: ['/some/long/path/segment'] }))).toEqual([]);
    expect(secretValuesOf(httpEntry('not a url /with/LONGSEGMENT-1234'))).toContain('not a url /with/LONGSEGMENT-1234');
  });

  it('survives a segment with malformed percent-encoding', () => {
    const entry = httpEntry('https://host.example/mcp/bad%ZZtoken-123456');
    expect(redactMessage(entry, 'POST /mcp/bad%ZZtoken-123456 failed')).toBe('POST <redacted> failed');
  });
});

describe('redactMessage: ordinary words in header and environment values', () => {
  it('keeps the auth scheme and hides the credential that follows it', () => {
    vi.stubEnv('FAKE_TOKEN', 'abc123def456xyz');
    const entry = httpEntry('https://host.example/mcp', { Authorization: 'Bearer ${FAKE_TOKEN}' });
    expect(redactMessage(entry, 'expected Bearer scheme, got Bearer abc123def456xyz')).toBe('expected Bearer scheme, got <redacted>');
    expect(redactMessage(entry, 'rejected key abc123def456xyz (Bearer)')).toBe('rejected key <redacted> (Bearer)');
  });

  it.each(['Bearer', 'bearer', 'BEARER', 'Basic', 'Token', 'Digest', 'DIGEST', 'ApiKey', 'apikey'])(
    'never treats the auth scheme %s as a secret',
    (scheme) => {
      const entry = httpEntry('https://host.example/mcp', { Authorization: `${scheme} s3cr3t-value-42` });
      const values = secretValuesOf(entry);
      expect(values).not.toContain(scheme);
      expect(values).toContain('s3cr3t-value-42');
      expect(redactMessage(entry, `scheme ${scheme} unsupported`)).toBe(`scheme ${scheme} unsupported`);
      expect(redactMessage(entry, 'token s3cr3t-value-42 invalid')).toBe('token <redacted> invalid');
    },
  );

  it('does not blank a plain lowercase word used as a non-secret header value', () => {
    const entry = httpEntry('https://host.example/mcp', { 'X-Env': 'production' });
    expect(redactMessage(entry, 'production database unavailable')).toBe('production database unavailable');
    expect(secretValuesOf(entry)).toEqual([]);
  });

  it('does not blank such a word from a stdio env value either, but still hides one under a secret-looking name', () => {
    const entry = entryFor({
      type: 'stdio',
      command: 'node',
      args: [],
      env: { APP_ENV: 'production', DB_PASSWORD: 'letmeinplease' },
    });
    expect(redactMessage(entry, 'production database rejected letmeinplease')).toBe('production database rejected <redacted>');
  });

  it.each(['Authorization', 'X-Api-Key', 'X-Auth-Token', 'Cookie', 'X-Session-Id', 'X-Client-Secret', 'X-Credentials', 'X-Pass'])(
    'still hides a plain lowercase word under the secret-looking name %s',
    (name) => {
      const entry = httpEntry('https://host.example/mcp', { [name]: 'hunter' });
      expect(redactMessage(entry, 'the value hunter was rejected')).toBe('the value <redacted> was rejected');
    },
  );

  it('hides the word everywhere when the same string is also the value of a secret-looking key', () => {
    const entry = httpEntry('https://host.example/mcp', { 'X-Env': 'production', 'X-Api-Key': 'production' });
    expect(redactMessage(entry, 'production database unavailable')).toBe('<redacted> database unavailable');
  });

  it('counts the name of the environment variable a value is read from', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghpatword');
    vi.stubEnv('REGION_NAME', 'frankfurt');
    const entry = httpEntry('https://host.example/mcp', { 'X-Custom': '${GITHUB_TOKEN}', 'X-Region': '${REGION_NAME}' });
    expect(redactMessage(entry, 'got ghpatword in frankfurt')).toBe('got <redacted> in frankfurt');
  });

  it('keeps hiding a password in the URL even when a harmless header holds the same word', () => {
    const entry = httpEntry('https://bob:production@host.example/mcp', { 'X-Env': 'production' });
    expect(redactMessage(entry, 'production database unavailable')).toBe('<redacted> database unavailable');
  });

  it.each([
    ['a digit', 'staging2'],
    ['a capital letter', 'Production'],
    ['a dash', 'pre-production'],
    ['sixteen letters or more', 'abcdefghijklmnop'],
  ])('still hides a value that has %s, because it is not a plain short word', (_label, value) => {
    const entry = httpEntry('https://host.example/mcp', { 'X-Env': value });
    expect(redactMessage(entry, `value ${value} here`)).toBe('value <redacted> here');
  });

  it('keeps hiding a query value, even a plain word, because a URL query is a credential by position', () => {
    const entry = httpEntry('https://host.example/mcp?mode=production');
    expect(redactMessage(entry, 'production database unavailable')).toBe('<redacted> database unavailable');
    expect(redactMessage(entry, 'GET https://host.example/mcp?mode=production failed')).toBe('GET https://host.example/mcp<redacted> failed');
  });

  it('keeps hiding the parts of a value that is not itself a plain word', () => {
    const entry = entryFor({ type: 'stdio', command: 'node', args: [], env: { OPTS: '--password=letmeinplease' } });
    expect(redactMessage(entry, 'bad option --password=letmeinplease; got letmeinplease')).toBe('bad option <redacted>; got <redacted>');
  });

  it('keeps hiding a plain word that a secret-looking environment value resolves to, and not one that a harmless one does', () => {
    vi.stubEnv('SERVICE_PASSWORD', 'swordfish');
    vi.stubEnv('SERVICE_REGION', 'frankfurt');
    const entry = entryFor({
      type: 'stdio',
      command: 'node',
      args: [],
      env: { A: '${SERVICE_PASSWORD}', B: '${SERVICE_REGION}' },
    });
    expect(redactMessage(entry, 'swordfish at frankfurt')).toBe('<redacted> at frankfurt');
  });

  it('still hides a parameter provider argument that is a plain word: the exemption covers header and environment values only', () => {
    const entry = httpEntry('https://host.example/mcp');
    entry.paramProvider = { command: 'mint', args: ['production', '--token=abcdefgh'] };
    expect(redactMessage(entry, 'ran mint production --token=abcdefgh')).toBe('ran mint <redacted> <redacted>');
  });
});

describe('redactMessage: a credential in the launch arguments of a stdio server', () => {
  const KEY = 'sk-LAUNCHcanary0123456789abcdef';
  const launch = (...args: string[]): ServerEntry => entryFor({ type: 'stdio', command: 'npx', args });

  it('hides an inline header, an --api-key option, and a URL user and password, as the arguments quote them', () => {
    const entry = launch('mcp-remote', 'https://host.example/mcp', '--header', `x-api-key: ${KEY}`, '--api-key=OPTIONkey-9876543210', 'https://user:PASSword-abc123@h.example/x');
    expect(redactMessage(entry, `spawn failed: npx mcp-remote https://host.example/mcp --header x-api-key: ${KEY}`))
      .toBe('spawn failed: npx mcp-remote https://host.example/mcp --header x-api-key: <redacted>');
    expect(redactMessage(entry, 'bad --api-key=OPTIONkey-9876543210')).toBe('bad --api-key=<redacted>');
    expect(redactMessage(entry, 'GET https://user:PASSword-abc123@h.example/x')).toBe('GET https://<redacted>@h.example/x');
  });

  it('hides the header of the whitespace-split form', () => {
    const entry = launch('--header', '"x-api-key:', `${KEY}"`);
    expect(redactMessage(entry, `header "x-api-key: ${KEY}" rejected`)).toBe('header "x-api-key: <redacted>" rejected');
  });

  it('leaves the ordinary arguments alone', () => {
    const entry = launch('-y', '@modelcontextprotocol/server-filesystem@2025.1.14', '/Users/someone/project');
    expect(secretValuesOf(entry)).toEqual([]);
  });
});

describe('scrubSecrets', () => {
  it('hides credentials like redactMessage but keeps the env hints: the owner needs the recipe', () => {
    const entry = httpEntry('https://host.example/mcp', { 'X-Api-Key': 'HEADERkey-0123456789' });
    entry.envHints = { MY_TOKEN: 'Mint one with `mint-token`.' };
    const message = 'x-api-key HEADERkey-0123456789 rejected\n\nHint: Mint one with `mint-token`.';
    expect(scrubSecrets(entry, message)).toBe('x-api-key <redacted> rejected\n\nHint: Mint one with `mint-token`.');
    expect(redactMessage(entry, message)).toBe('x-api-key <redacted> rejected');
  });
});
