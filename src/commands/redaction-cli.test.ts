import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `list` and `view` through the real built CLI (dist/cli.js, built once by the
 * vitest global setup) against a throwaway HOME whose registry holds a canary
 * secret in every place a secret can sit: environment values, headers, an
 * inline `--header`, `--api-key=`, a URL's user and password, a query value, a
 * `Bearer` argument and a long token argument. No canary may reach any output
 * in text, JSON or YAML; `view --reveal` is the one way to see them.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');

vi.setConfig({ testTimeout: 30_000 });

const NOW = '2026-11-19T00:00:00.000Z';
const CANARIES = {
  inline: 'sk-INLINEcanary0123456789abcdefABCDEF',
  split: 'sk-SPLITcanary9876543210fedcbaFEDCBA',
  equals: 'EQUALScanary5555aaaaBBBBccccDDDD',
  userinfo: 'USERINFOcanaryPass12345',
  query: 'QUERYcanary-token-7788',
  bearer: 'BEARERcanary0011223344556677',
  long: 'LONGcanaryAbCdEfGhIjKlMnOp0123',
  env: 'ENVcanary-value-abc',
  header: 'HEADERcanary-value-xyz',
  clientSecret: 'CLIENTSECRETcanary-9090',
  provider: 'PROVIDERcanary-token-4242',
  hint: 'HINTcanary-token-3131',
} as const;

const BENIGN = [
  '@modelcontextprotocol/server-filesystem@2025.1.14',
  '/Users/someone/projects/some-long-directory-name-2/dist/cli.js',
  'https://example.com/docs/some/long/path/to/a/page-with-a-long-name',
  '--port=8080',
];

const entry = (name: string, transport: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  name,
  transport,
  toolCount: 2,
  agents: ['cursor'],
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

const REGISTRY = {
  version: 1,
  servers: {
    inline: entry('inline', {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y', 'mcp-remote', 'https://host.example/mcp',
        '--header', `x-api-key: ${CANARIES.inline}`,
        `--api-key=${CANARIES.equals}`,
        `https://user:${CANARIES.userinfo}@host.example/p?token=${CANARIES.query}&format=json`,
        `Bearer ${CANARIES.bearer}`,
        CANARIES.long,
        ...BENIGN,
      ],
      env: { SOME_SECRET: CANARIES.env, NODE_ENV: 'production', PORT: '3000' },
    }, {
      paramProvider: { command: `eiamcli iamticket --token ${CANARIES.provider}` },
      envHints: { SOME_SECRET: `Mint one with: mint --token ${CANARIES.hint}` },
    }),
    split: entry('split', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://host.example/mcp', '--header', '"x-api-key:', `${CANARIES.split}"`],
    }),
    remote: entry('remote', {
      type: 'http',
      url: `https://user:${CANARIES.userinfo}@host.example/mcp?token=${CANARIES.query}`,
      headers: { 'X-Api-Key': CANARIES.header, Authorization: `Bearer ${CANARIES.bearer}` },
      auth: 'oauth',
      oauth: { clientId: 'public-client-id', clientSecret: CANARIES.clientSecret },
    }),
  },
};

let home: string;
let registryPath: string;
let registryBytes: string;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(...args: string[]): CliResult {
  const run = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: '',
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** True when any 8 consecutive characters of `canary` appear in `output`: a prefix, a suffix or the middle. */
function leaks(output: string, canary: string): boolean {
  for (let start = 0; start + 8 <= canary.length; start++) {
    if (output.includes(canary.slice(start, start + 8))) return true;
  }
  return false;
}

function expectNoCanary(output: string, label: string): void {
  for (const [name, canary] of Object.entries(CANARIES)) {
    expect(leaks(output, canary), `${label} leaks the ${name} canary`).toBe(false);
  }
}

beforeAll(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'mcpkit-redaction-cli-'));
  mkdirSync(join(home, '.mcpkit'), { recursive: true });
  registryPath = join(home, '.mcpkit', 'servers.yaml');
  writeFileSync(registryPath, stringify(REGISTRY), 'utf-8');
  registryBytes = readFileSync(registryPath, 'utf-8');
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('mcpkit list', () => {
  it('prints no secret, and masks the inline header the way the user would read it', () => {
    const { code, stdout, stderr } = cli('list');
    expect(code, stderr).toBe(0);
    expectNoCanary(stdout + stderr, 'list');
    expect(stdout).toContain('npx -y mcp-remote https://host.example/mcp --header x-api-key: <redacted len=37> --api-key=<redacted len=32>');
    expect(stdout).toContain('npx -y mcp-remote https://host.example/mcp --header "x-api-key: <redacted len=36>"');
    expect(stdout).toContain('https://<redacted len=');
  });

  it('keeps what is not secret readable', () => {
    const { stdout } = cli('list');
    for (const benign of BENIGN) expect(stdout, benign).toContain(benign);
    expect(stdout).toContain('format=json');
    expect(stdout).toContain('Bearer <redacted len=');
  });

  it('prints no secret as JSON either, with every entry present and the structure intact', () => {
    const { code, stdout, stderr } = cli('list', '--json');
    expect(code, stderr).toBe(0);
    expectNoCanary(stdout, 'list --json');
    const entries = JSON.parse(stdout) as Array<{ name: string; transport: { type: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; oauth?: Record<string, unknown> } }>;
    expect(entries.map((item) => item.name)).toEqual(['inline', 'split', 'remote']);
    expect(entries[0].transport.args).toContain('x-api-key: <redacted len=37>');
    expect(entries[0].transport.env).toEqual({ SOME_SECRET: '<redacted len=19>', NODE_ENV: 'production', PORT: '3000' });
    expect(entries[2].transport.headers).toEqual({ 'X-Api-Key': '<redacted len=22>', Authorization: '<redacted len=35>' });
    expect(entries[2].transport.oauth).toEqual({ clientId: 'public-client-id', clientSecret: '<redacted len=23>' });
  });

  it('has no --reveal: a listing never prints a secret', () => {
    const { code, stdout, stderr } = cli('list', '--reveal');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown option '--reveal'/);
    expectNoCanary(stdout + stderr, 'list --reveal');
  });
});

describe('mcpkit view', () => {
  const NAMES = ['inline', 'split', 'remote'];

  it.each(NAMES)('prints no secret of %s in text, JSON or YAML', (name) => {
    for (const flags of [[], ['--json'], ['--yaml']]) {
      const { code, stdout, stderr } = cli('view', name, ...flags);
      expect(code, `${name} ${flags.join(' ')}: ${stderr}`).toBe(0);
      expectNoCanary(stdout + stderr, `view ${name} ${flags.join(' ')}`);
    }
  });

  it('shows the masked environment, headers and parameters in text, with settings readable', () => {
    const { stdout } = cli('view', 'inline');
    expect(stdout).toContain('SOME_SECRET=<redacted len=19>');
    expect(stdout).toContain('NODE_ENV=production');
    expect(stdout).toContain('PORT=3000');
    expect(stdout).toContain('eiamcli iamticket --token <redacted len=25>');
    expect(stdout).toContain('mint --token <redacted len=21>');
    expect(cli('view', 'remote').stdout).toContain('X-Api-Key: <redacted len=22>');
  });

  it('masks the YAML the same way, with the stored structure', () => {
    const { stdout } = cli('view', 'remote', '--yaml');
    expect(stdout).toContain('X-Api-Key: <redacted len=22>');
    expect(stdout).toContain('auth: oauth');
    expect(stdout).toContain('clientId: public-client-id');
    expect(stdout).toContain('clientSecret: <redacted len=23>');
  });

  it('prints the secrets as stored with --reveal, and warns once on stderr', () => {
    for (const [name, canaries] of [
      ['inline', [CANARIES.inline, CANARIES.equals, CANARIES.userinfo, CANARIES.query, CANARIES.bearer, CANARIES.long, CANARIES.env, CANARIES.provider, CANARIES.hint]],
      ['split', [CANARIES.split]],
      ['remote', [CANARIES.header, CANARIES.userinfo]],
    ] as const) {
      for (const flags of [[], ['--json'], ['--yaml']]) {
        const { code, stdout, stderr } = cli('view', name, '--reveal', ...flags);
        expect(code, stderr).toBe(0);
        for (const canary of canaries) expect(stdout, `view ${name} --reveal ${flags.join(' ')}`).toContain(canary);
        // The text view has never printed OAuth settings; the structured formats carry them.
        if (name === 'remote' && flags.length > 0) expect(stdout).toContain(CANARIES.clientSecret);
        expect(stdout).not.toContain('<redacted');
        expect(stderr.trim().split('\n')).toHaveLength(1);
        expect(stderr).toMatch(/^Warning: --reveal prints secrets in clear text/);
      }
    }
  });

  it('does not warn when nothing is revealed', () => {
    expect(cli('view', 'inline').stderr).toBe('');
  });
});

describe('the registry file', () => {
  it('is byte for byte what it was after every command above', () => {
    expect(readFileSync(registryPath, 'utf-8')).toBe(registryBytes);
  });
});
