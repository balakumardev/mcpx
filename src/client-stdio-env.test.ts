import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Capture the params handed to StdioClientTransport so we can assert on the
// child environment mcpkit builds. vi.hoisted keeps the array alive above the
// hoisted vi.mock factory.
const { ctorArgs } = vi.hoisted(() => ({ ctorArgs: [] as any[] }));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(params: any) {
      ctorArgs.push(params);
    }
  },
}));

const { createTransport } = await import('./client.js');

describe('createTransport (stdio) environment inheritance', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    ctorArgs.length = 0;
    process.env.LANG = 'en_IN.UTF-8';
    process.env.TMPDIR = '/tmp/from-parent';
    process.env.MCPKIT_TEST_TOKEN = 'parent-value';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const base = { type: 'stdio' as const, command: 'echo', args: ['hi'] };

  it('inherits the parent environment when the server has no env block', () => {
    createTransport({ ...base });

    const { env } = ctorArgs[0];
    // Regression: this used to be `undefined`, which made the MCP SDK fall back
    // to its 6-var DEFAULT_INHERITED_ENV_VARS allowlist and silently drop LANG,
    // TMPDIR and every other inherited var.
    expect(env).toBeDefined();
    expect(env.LANG).toBe('en_IN.UTF-8');
    expect(env.TMPDIR).toBe('/tmp/from-parent');
    expect(env.MCPKIT_TEST_TOKEN).toBe('parent-value');
  });

  it('inherits the parent environment when the server has an env block', () => {
    createTransport({ ...base, env: { EXTRA: 'configured' } });

    const { env } = ctorArgs[0];
    expect(env.LANG).toBe('en_IN.UTF-8');
    expect(env.EXTRA).toBe('configured');
  });

  it('lets per-server env values override inherited ones', () => {
    createTransport({ ...base, env: { MCPKIT_TEST_TOKEN: 'server-value' } });

    expect(ctorArgs[0].env.MCPKIT_TEST_TOKEN).toBe('server-value');
  });

  it('expands ${VAR} in per-server env values from the parent environment', () => {
    createTransport({ ...base, env: { DERIVED: '${MCPKIT_TEST_TOKEN}-suffix' } });

    expect(ctorArgs[0].env.DERIVED).toBe('parent-value-suffix');
  });

  it('treats an empty env block the same as no env block', () => {
    createTransport({ ...base, env: {} });

    // Previously `{}` was truthy and therefore took the full-inherit branch,
    // while an absent key did not — the two must not diverge.
    expect(ctorArgs[0].env.LANG).toBe('en_IN.UTF-8');
  });
});
