import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Runs before every test file: point HOME at a fresh temporary directory so
 * that nothing under test (the registry, credentials, runtimes, schema cache,
 * skill files, child processes) can read or write the real home directory.
 * Everything in mcpkit resolves its paths through os.homedir(), which honours
 * HOME on POSIX and USERPROFILE on Windows. The original value is never
 * restored: a test file that needs a different home sets its own and puts
 * this one back.
 */
const home = mkdtempSync(join(realpathSync(tmpdir()), 'mch-'));

process.env.HOME = home;
process.env.USERPROFILE = home;
// The only other variable that redirects a path mcpkit uses (Hermes skills).
delete process.env.HERMES_HOME;
// Not a path, but it decides whether skills are written per server or as one guide, for every agent
// and over the settings file, so a shell that exports it must not change a result.
delete process.env.MCPKIT_SKILLS;

if (homedir() !== home) {
  throw new Error(`test isolation failed: os.homedir() is ${homedir()}, expected ${home}`);
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});
