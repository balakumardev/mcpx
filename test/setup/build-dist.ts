import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest global setup: build dist/ once for the whole run, because the
 * end-to-end and integration tests drive the real dist/cli.js. The build is
 * skipped when dist/cli.js is newer than every non-test file in src/ and than
 * the build inputs, so a second run costs nothing. No test builds anything.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const tsupCli = join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js');

function newestInputTime(): number {
  const sources = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf-8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => statSync(join(root, 'src', file)).mtimeMs);
  const inputs = ['package.json', 'tsup.config.ts', 'tsconfig.json'].map((file) => statSync(join(root, file)).mtimeMs);
  return Math.max(...sources, ...inputs);
}

function isFresh(): boolean {
  return existsSync(cliPath) && statSync(cliPath).mtimeMs >= newestInputTime();
}

export default function setup(): void {
  // Opt-out for several people editing src/ at once: only one of them should rebuild dist/.
  if (process.env.MCPKIT_TEST_SKIP_BUILD === '1') return;
  if (isFresh()) return;

  // The build runs under a throwaway HOME like everything else in the suite.
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mch-build-'));
  try {
    execFileSync(process.execPath, [tsupCli], {
      cwd: root,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: 'pipe',
    });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`building dist/ failed:\n${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  if (!existsSync(cliPath)) throw new Error(`the build finished but ${cliPath} does not exist`);
}
