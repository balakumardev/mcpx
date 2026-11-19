import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runParamProvider } from '../client.js';

/**
 * A param provider's output and command line may hold credentials, and the
 * error text of a failing provider reaches scripts and agents: it must carry
 * sizes and the exit status only.
 */

const SECRET_STDERR = 'api_key=FAKE-SECRET-0123456789';
const SECRET_STDOUT = 'token=FAKE-STDOUT-SECRET-9876';
const SECRET_ARG = '--token=FAKE-ARG-SECRET-555';

let dir: string;
const script = (name: string, body: string): string => {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpkit-param-provider-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the provider to fail');
}

describe('runParamProvider errors', () => {
  it('says only the exit status and the size of the output when the provider exits non-zero', async () => {
    const file = script('stderr.mjs', `process.stderr.write('warning: refreshed; ${SECRET_STDERR}\\n'); process.exit(1);`);
    const message = await failure(runParamProvider({ command: process.execPath, args: [file, SECRET_ARG] }));
    expect(message).toMatch(/^the param provider failed \(exit code 1, \d+ bytes of output\)$/);
    expect(message).not.toContain('FAKE-');
    expect(message).not.toContain(process.execPath);
  });

  it('does not repeat non-JSON stdout, nor the command line given as one string', async () => {
    const file = script('stdout.mjs', `console.log('${SECRET_STDOUT}');`);
    const message = await failure(runParamProvider({ command: `${process.execPath} ${file} ${SECRET_ARG}` }));
    expect(message).toMatch(/^the param provider returned non-JSON output \(\d+ bytes\)$/);
    expect(message).not.toContain('FAKE-');
  });

  it('names a command that cannot start by its error code, not by its path or arguments', async () => {
    const message = await failure(runParamProvider({ command: join(dir, 'missing-FAKE-helper'), args: [SECRET_ARG] }));
    expect(message).toMatch(/^the param provider failed \(exit code ENOENT, 0 bytes of output\)$/);
  });

  it('prints the command line and the output on the parent stderr only with MCPKIT_DEBUG=1', async () => {
    const file = script('debug.mjs', `process.stderr.write('${SECRET_STDERR}\\n'); process.exit(2);`);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await failure(runParamProvider({ command: process.execPath, args: [file] }));
    expect(stderr).not.toHaveBeenCalled();

    vi.stubEnv('MCPKIT_DEBUG', '1');
    await failure(runParamProvider({ command: process.execPath, args: [file] }));
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain(file);
    expect(written).toContain('FAKE-SECRET-0123456789');
  });

  it('still returns the parsed object of a provider that works, whatever it prints on stderr', async () => {
    const file = script('ok.mjs', `process.stderr.write('${SECRET_STDERR}\\n'); console.log(JSON.stringify({ region: 'eu' }));`);
    expect(await runParamProvider({ command: process.execPath, args: [file] })).toEqual({ region: 'eu' });
  });
});
