import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTypesCommand } from './gen-types.js';

/** `mcpkit types` with commander's exit turned into a thrown error and its usage output captured. */
async function parse(...args: string[]): Promise<{ stderr: string; error?: { code: string; exitCode: number; message: string } }> {
  let stderr = '';
  const command = createTypesCommand().exitOverride().configureOutput({ writeErr: (text) => { stderr += text; }, writeOut: () => {} });
  try {
    await command.parseAsync(args, { from: 'user' });
    return { stderr };
  } catch (error) {
    return { stderr, error: error as { code: string; exitCode: number; message: string } };
  }
}

describe('mcpkit types --tools', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it.each([
    ['an empty value', ['--tools', '']],
    ['a value of only separators and spaces', ['--tools', ' , ,']],
    ['an empty value among good ones', ['--tools', 'create_issue', '--tools', '']],
    ['an empty value after a server name', ['github', '--tools=']],
  ])('is a usage error with exit code 2 for %s', async (_label, args) => {
    const { error, stderr } = await parse(...args);
    expect(error?.code).toBe('commander.invalidArgument');
    expect(error?.exitCode).toBe(2);
    expect(stderr).toContain('--tools');
    expect(stderr).toMatch(/one or more tool names/);
  });

  it('still accepts names, comma separated and repeated', async () => {
    // No registry exists in the test home, so a valid filter gets as far as the registry lookup and fails there, not as a usage error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error } = await parse('--tools', 'a, b', '--tools', 'c');
    expect(error?.code).not.toBe('commander.invalidArgument');
  });
});
