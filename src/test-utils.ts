import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** `file://` URL of a source file in this repository, for importing it from a script run by `runModuleScript`. */
export function sourceUrl(relativePath: string): string {
  return pathToFileURL(resolve(process.cwd(), relativePath)).href;
}

/**
 * Run `body` as an ES module in a separate Node process (the repository's
 * TypeScript sources import fine through tsx) with HOME set to `home`, to
 * exercise real cross-process behaviour. Resolves with stdout; rejects with the
 * stderr when the process exits non-zero.
 */
export async function runModuleScript(
  dir: string,
  fileName: string,
  body: string,
  home: string,
  args: string[] = [],
): Promise<string> {
  const scriptPath = join(dir, fileName);
  await writeFile(scriptPath, body, 'utf-8');

  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(new Error(`${fileName} exited with code ${code}: ${stderr}`));
      }
    });
  });
}
