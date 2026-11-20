import { describe, expect, it } from 'vitest';
import {
  maskArgs,
  maskCommandLine,
  maskConfiguredValue,
  maskEntryForDisplay,
  maskRecord,
  maskText,
  maskUrl,
  maskValue,
  secretsInCommand,
} from './redact-config.js';
import type { ServerEntry } from './types.js';

// Each canary is unique, so a hit anywhere in an output names the leaking field.
const KEY = 'sk-CANARYkey0123456789abcdefABCDEF';
const OTHER = 'CANARYother9876543210zyxwvuTSRQ';

/** True when any 8 consecutive characters of `canary` appear in `output`: a prefix, a suffix or the middle. */
function leaks(output: string, canary: string): boolean {
  for (let start = 0; start + 8 <= canary.length; start++) {
    if (output.includes(canary.slice(start, start + 8))) return true;
  }
  return false;
}

describe('maskValue', () => {
  it('shows the length and nothing of the value', () => {
    expect(maskValue(KEY)).toBe('<redacted len=34>');
    expect(maskValue('')).toBe('<redacted len=0>');
  });

  it('leaves a mask as it is', () => {
    expect(maskValue('<redacted len=34>')).toBe('<redacted len=34>');
  });
});

describe('environment and header values', () => {
  it('masks every value except settings', () => {
    const masked = maskRecord({
      API_KEY: KEY,
      SOME_NAME: OTHER,
      'x-api-key': KEY,
      Authorization: `Bearer ${KEY}`,
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      DEBUG: '*',
      PORT: '8080',
      HOST: 'localhost',
      HOME: '/Users/someone',
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
      ENABLED: 'true',
      VERBOSE: 'FALSE',
      TIMEOUT: '30',
      RATIO: '-1.5',
    });
    expect(masked).toEqual({
      API_KEY: '<redacted len=34>',
      SOME_NAME: '<redacted len=31>',
      'x-api-key': '<redacted len=34>',
      Authorization: '<redacted len=41>',
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      DEBUG: '*',
      PORT: '8080',
      HOST: 'localhost',
      HOME: '/Users/someone',
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
      ENABLED: 'true',
      VERBOSE: 'FALSE',
      TIMEOUT: '30',
      RATIO: '-1.5',
    });
  });

  it('masks a long number and a short number under a password name', () => {
    expect(maskConfiguredValue('ACCOUNT', '1234567')).toBe('<redacted len=7>');
    expect(maskConfiguredValue('DB_PASSWORD', '1234')).toBe('<redacted len=4>');
    expect(maskConfiguredValue('PIN', '1234')).toBe('<redacted len=4>');
  });

  it('keeps a reference to an environment variable readable: it is a pointer, not a value', () => {
    expect(maskConfiguredValue('Authorization', 'Bearer ${MY_TOKEN}')).toBe('Bearer ${MY_TOKEN}');
    expect(maskConfiguredValue('X', '${A}${B}')).toBe('${A}${B}');
    expect(maskConfiguredValue('X', `pre-${KEY}-\${A}`)).toBe('<redacted len=43>');
  });

  it('does not mask an empty value, and masks a value that is not a string', () => {
    expect(maskConfiguredValue('X', '')).toBe('');
    const masked = maskRecord({ PIN: 123456789, FLAG: true, PORT: 8080 } as unknown as Record<string, string>);
    expect(masked).toEqual({ PIN: '<redacted len=9>', FLAG: true, PORT: 8080 });
  });
});

describe('launch arguments', () => {
  it('masks the value of an inline header, keeping the header name', () => {
    expect(maskArgs(['mcp-remote', 'https://host/mcp', '--header', `x-api-key: ${KEY}`])).toEqual([
      'mcp-remote',
      'https://host/mcp',
      '--header',
      'x-api-key: <redacted len=34>',
    ]);
  });

  it('masks the same header when a shell split it into tokens, quotes kept', () => {
    expect(maskArgs(['--header', '"x-api-key:', `${KEY}"`])).toEqual(['--header', '"x-api-key:', '<redacted len=34>"']);
    expect(maskArgs(['-H', `'Authorization:`, 'Bearer', `${KEY}'`])).toEqual(['-H', "'Authorization:", 'Bearer', "<redacted len=34>'"]);
  });

  it('masks a header without a space after the colon and attached forms', () => {
    expect(maskArgs(['--header', `Authorization:Bearer${KEY}`])).toEqual(['--header', 'Authorization:<redacted len=40>']);
    expect(maskArgs([`--header=X-Token: ${KEY}`])).toEqual(['--header=X-Token: <redacted len=34>']);
    expect(maskArgs([`--headers=X-Token:${KEY}`])).toEqual(['--headers=X-Token:<redacted len=34>']);
    expect(maskArgs([`-HX-Token:${KEY}`])).toEqual(['-HX-Token:<redacted len=34>']);
  });

  it('masks the value of any header named after --header, whatever its name', () => {
    expect(maskArgs(['--header', 'X-Custom: some-value-here'])).toEqual(['--header', 'X-Custom: <redacted len=15>']);
    expect(maskArgs(['--header', 'Host: example.com'])).toEqual(['--header', 'Host: example.com']);
  });

  it('masks a header written as an argument of its own, for a secret-looking name', () => {
    expect(maskArgs([`X-Api-Key: ${KEY}`, 'Content-Type: application/json'])).toEqual([
      'X-Api-Key: <redacted len=34>',
      'Content-Type: application/json',
    ]);
    expect(maskArgs(['Authorization:', `Bearer`, KEY])).toEqual(['Authorization:', 'Bearer', '<redacted len=34>']);
  });

  it('masks secret options in both forms', () => {
    expect(maskArgs(['--api-key', KEY, '--token', OTHER, '--password', 'hunter2hunter2', '--secret', 'abc', '--key', 'k'])).toEqual([
      '--api-key', '<redacted len=34>',
      '--token', '<redacted len=31>',
      '--password', '<redacted len=14>',
      '--secret', '<redacted len=3>',
      '--key', '<redacted len=1>',
    ]);
    expect(maskArgs([`--api-key=${KEY}`, `--token=${OTHER}`, '--password=hunter2hunter2'])).toEqual([
      '--api-key=<redacted len=34>',
      '--token=<redacted len=31>',
      '--password=<redacted len=14>',
    ]);
  });

  it('does not take the next option for a value', () => {
    expect(maskArgs(['--auth', '--port', '8080'])).toEqual(['--auth', '--port', '8080']);
  });

  it('masks KEY=value arguments with a secret-looking key', () => {
    expect(maskArgs(['env', `API_KEY=${KEY}`, 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_abc', 'DB_PASSWORD="p4ss"', 'npx'])).toEqual([
      'env',
      'API_KEY=<redacted len=34>',
      'GITHUB_PERSONAL_ACCESS_TOKEN=<redacted len=7>',
      'DB_PASSWORD="<redacted len=4>"',
      'npx',
    ]);
  });

  it('masks the user and password of a URL, a secret query parameter and a key in the path', () => {
    expect(maskArgs([`https://user:${KEY}@host.example/mcp`])).toEqual(['https://<redacted len=39>@host.example/mcp']);
    expect(maskArgs(['https://TOKENONLY@host.example/mcp'])).toEqual(['https://<redacted len=9>@host.example/mcp']);
    expect(maskArgs([`https://host.example/mcp?token=${KEY}&format=json&api_key=${OTHER}`])).toEqual([
      'https://host.example/mcp?token=<redacted len=34>&format=json&api_key=<redacted len=31>',
    ]);
    expect(maskArgs([`https://host.example/mcp#access_token=${KEY}`])).toEqual(['https://host.example/mcp#access_token=<redacted len=34>']);
    expect(maskArgs(['https://host.example/mcp/AbCdEfGhIjKlMnOpQrStUv123456/sse'])).toEqual(['https://host.example/mcp/<redacted len=28>/sse']);
    expect(maskArgs(['https://host.example/v1/0123456789abcdef0123456789abcdef/mcp'])).toEqual(['https://host.example/v1/<redacted len=32>/mcp']);
  });

  it('masks Bearer and Basic credentials wherever they are', () => {
    expect(maskArgs([`Bearer ${KEY}`, `Basic ${OTHER}`, `prefix Bearer ${KEY} suffix`])).toEqual([
      'Bearer <redacted len=34>',
      'Basic <redacted len=31>',
      'prefix Bearer <redacted len=34> suffix',
    ]);
    expect(maskArgs(['Bearer', KEY])).toEqual(['Bearer', '<redacted len=34>']);
  });

  it('masks a secret inside a JSON argument', () => {
    expect(maskArgs([`--env={"API_KEY":"${KEY}","MODE":"fast"}`])).toEqual([`--env={"API_KEY":"<redacted len=34>","MODE":"fast"}`]);
  });

  it('masks a long standalone credential, but not a short word or a flag', () => {
    expect(maskArgs([KEY, OTHER, 'AbCdEfGhIjKlMnOp0123456789xx', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'])).toEqual([
      '<redacted len=34>',
      '<redacted len=31>',
      '<redacted len=28>',
      '<redacted len=40>',
    ]);
    expect(maskArgs(['mcp-remote', '-y', '--yes', 'run', 'ShortToken123'])).toEqual(['mcp-remote', '-y', '--yes', 'run', 'ShortToken123']);
  });

  it('masks a UUID: it has three kinds of characters and is as long as a credential', () => {
    expect(maskArgs(['123e4567-e89b-12d3-a456-426614174000'])).toEqual(['<redacted len=36>']);
  });

  it('leaves what is plainly not a credential readable', () => {
    const benign = [
      '-y',
      '@modelcontextprotocol/server-filesystem@2025.1.14',
      '@modelcontextprotocol/server-sequential-thinking',
      'some-long-package-name-with-many-words@latest',
      'mcp-server-fetch==2025.4.7',
      '/Users/someone/projects/some-long-directory-name-2/dist/cli.js',
      './dist/index.mjs',
      '../packages/some-long-directory-name-2/build/run.cjs',
      '~/some/long/directory/name/with/many/parts-2',
      'src/some/long/relative/path/to/a/file-name-2.test.ts',
      'node_modules/.bin/some-long-binary-name-for-a-test-2',
      'my-long-script-name-for-the-server-v2.mjs',
      'https://example.com/docs/some/long/path/to/a/page-with-a-long-name',
      'https://registry.npmjs.org/@scope/some-long-package-name/-/some-long-package-name-1.2.3.tgz',
      'git+https://github.com/someone/some-long-repository-name.git#v1.2.3',
      'git+ssh://git@github.com/someone/repo.git',
      '--port=8080',
      '--max-old-space-size=4096',
      '--config=/etc/some/long/path/to/config-file-2.json',
      'NODE_ENV=production',
      'LOG_LEVEL=debug',
      'DEBUG=*',
      '--token-limit=5000',
      '--no-auth',
    ];
    expect(maskArgs(benign)).toEqual(benign);
  });

  it('is idempotent on every shape it handles', () => {
    const once = maskArgs([
      '--header', `x-api-key: ${KEY}`,
      '--header', '"x-api-key:', `${KEY}"`,
      'Authorization:', 'Bearer', OTHER,
      `--api-key=${KEY}`, '--token', OTHER,
      `API_KEY=${KEY}`,
      `https://u:${KEY}@h.example/p/AbCdEfGhIjKlMnOpQrStUv123456?token=${OTHER}#access_token=${OTHER}`,
      `Bearer ${KEY}`,
      `--env={"API_KEY":"${KEY}"}`,
      KEY,
    ]);
    expect(maskArgs(once)).toEqual(once);
    expect(maskArgs(maskArgs(once))).toEqual(once);
    expect(JSON.stringify(once)).not.toMatch(/CANARY/);
  });
});

describe('the arguments of an inline header, end to end', () => {
  const ARGS = ['-y', 'mcp-remote', 'https://host.example/mcp', '--header', `x-api-key: ${KEY}`];

  it('prints the masked command line with the header name kept', () => {
    expect(maskCommandLine('npx', ARGS)).toBe('npx -y mcp-remote https://host.example/mcp --header x-api-key: <redacted len=34>');
  });

  it('prints the masked command line of the whitespace-split form with its quotes', () => {
    expect(maskCommandLine('npx', ['-y', 'mcp-remote', 'https://host.example/mcp', '--header', '"x-api-key:', `${KEY}"`])).toBe(
      'npx -y mcp-remote https://host.example/mcp --header "x-api-key: <redacted len=34>"',
    );
  });

  it('masks a secret in the command itself', () => {
    expect(maskCommandLine(`env API_KEY=${KEY} npx`, [])).toBe('env API_KEY=<redacted len=34> npx');
  });
});

describe('maskText', () => {
  it('keeps the spacing and masks what the arguments rules mask', () => {
    expect(maskText(`Run  eiamcli --token ${KEY}\nthen call https://u:${OTHER}@h.example/x`)).toBe(
      'Run  eiamcli --token <redacted len=34>\nthen call https://<redacted len=33>@h.example/x',
    );
  });

  it('is idempotent, masks included', () => {
    const once = maskText(`Authorization: Bearer ${KEY} and --api-key ${OTHER}`);
    expect(once).toBe('Authorization: Bearer <redacted len=34> and --api-key <redacted len=31>');
    expect(maskText(once)).toBe(once);
  });

  it('leaves text without secrets alone', () => {
    const text = 'Mint a ticket with `eiamcli iamticket`, then export it.';
    expect(maskText(text)).toBe(text);
  });
});

describe('maskUrl', () => {
  it('masks the user, the password, a secret query value and a key in the path of a server URL', () => {
    expect(maskUrl(`https://user:${KEY}@host.example:8443/mcp/AbCdEfGhIjKlMnOpQrStUv123456?key=${OTHER}&v=2`)).toBe(
      'https://<redacted len=39>@host.example:8443/mcp/<redacted len=28>?key=<redacted len=31>&v=2',
    );
  });

  it('leaves an ordinary server URL alone', () => {
    for (const url of ['https://mcp.example.com/mcp', 'https://host.example/sse?format=json', 'http://localhost:3000/api/v1/mcp/', 'https://host.example/a-very-long-path-segment-with-many-words-2']) {
      expect(maskUrl(url)).toBe(url);
    }
  });

  it('is idempotent', () => {
    const once = maskUrl(`https://u:${KEY}@h.example/p?token=${OTHER}`);
    expect(maskUrl(once)).toBe(once);
  });
});

describe('secretsInCommand', () => {
  it('returns the values it masks, as written, for scrubbing them out of other text', () => {
    const found = secretsInCommand('npx', ['--header', '"x-api-key:', `${KEY}"`, `--api-key=${OTHER}`, 'plain']);
    expect(found).toEqual([KEY, OTHER]);
  });
});

describe('maskEntryForDisplay', () => {
  const NOW = '2026-11-19T00:00:00.000Z';
  const stdio: ServerEntry = {
    name: 'local',
    description: 'A local server',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://host.example/mcp', '--header', `x-api-key: ${KEY}`, `--api-key=${OTHER}`, '/Users/someone/project/dist/cli.js'],
      env: { SOME_TOKEN: KEY, NODE_ENV: 'production', PORT: '3000' },
    },
    paramProvider: { command: `eiamcli iamticket --password ${OTHER}`, args: ['--token', KEY], ttl: 60 },
    envHints: { MY_TOKEN: `Mint one with: mint --token ${KEY}` },
    runtime: { mode: 'persistent', idleTimeoutSec: 60 },
    toolCount: 3,
    agents: ['cursor'],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const remote: ServerEntry = {
    name: 'remote',
    transport: {
      type: 'http',
      url: `https://user:${KEY}@host.example/mcp?token=${OTHER}`,
      headers: { 'X-Api-Key': KEY, Authorization: `Bearer ${OTHER}`, 'X-Env': 'production' },
      auth: 'oauth',
      oauth: { clientId: 'public-client-id', clientSecret: OTHER, callbackPort: 8123 },
    },
    toolCount: 1,
    agents: ['cursor'],
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('masks every secret-bearing field of a stdio entry and nothing else', () => {
    const masked = maskEntryForDisplay(stdio);
    expect(masked).toEqual({
      ...stdio,
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://host.example/mcp', '--header', 'x-api-key: <redacted len=34>', '--api-key=<redacted len=31>', '/Users/someone/project/dist/cli.js'],
        env: { SOME_TOKEN: '<redacted len=34>', NODE_ENV: 'production', PORT: '3000' },
      },
      paramProvider: { command: 'eiamcli iamticket --password <redacted len=31>', args: ['--token', '<redacted len=34>'], ttl: 60 },
      envHints: { MY_TOKEN: 'Mint one with: mint --token <redacted len=34>' },
    });
    expect(Object.keys(masked)).toEqual(Object.keys(stdio));
  });

  it('masks every secret-bearing field of an http entry and keeps the auth type and public client id', () => {
    const masked = maskEntryForDisplay(remote);
    expect(masked.transport).toEqual({
      type: 'http',
      url: 'https://<redacted len=39>@host.example/mcp?token=<redacted len=31>',
      headers: { 'X-Api-Key': '<redacted len=34>', Authorization: '<redacted len=38>', 'X-Env': '<redacted len=10>' },
      auth: 'oauth',
      oauth: { clientId: 'public-client-id', clientSecret: '<redacted len=31>', callbackPort: 8123 },
    });
  });

  it('masks a secret in a field the registry may gain later', () => {
    const masked = maskEntryForDisplay({ ...stdio, extra: { apiKey: KEY, note: 'fine' } } as ServerEntry);
    expect((masked as unknown as { extra: unknown }).extra).toEqual({ apiKey: '<redacted len=34>', note: 'fine' });
  });

  it('never mutates its input, and masking a masked entry changes nothing', () => {
    const before = JSON.stringify([stdio, remote]);
    const once = [maskEntryForDisplay(stdio), maskEntryForDisplay(remote)];
    expect(JSON.stringify([stdio, remote])).toBe(before);
    expect(once.map(maskEntryForDisplay)).toEqual(once);
  });

  it('leaves no 8-character piece of any canary in the masked entries', () => {
    const output = JSON.stringify([maskEntryForDisplay(stdio), maskEntryForDisplay(remote)]);
    expect(leaks(output, KEY)).toBe(false);
    expect(leaks(output, OTHER)).toBe(false);
  });
});
