import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Two paths mcpkit builds for two agents can be one file on disk: a user who links one agent's skills
 * directory to another's (`~/.codex/skills -> ~/.claude/skills`), or one skill folder, or one SKILL.md,
 * has both agents read the same skills. What is written or deleted for one of them is then written or
 * deleted for both, so the places that write or delete skills for some agents only ask this module first.
 */

/** More links than this in a row is a loop. */
const MAX_LINK_HOPS = 40;

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function resolveReal(absolute: string, hops: number): Promise<string> {
  try {
    return await realpath(absolute);
  } catch (err) {
    const parent = dirname(absolute);
    if (!isMissing(err) || parent === absolute || hops > MAX_LINK_HOPS) return absolute;
    let target: string;
    try {
      target = await readlink(absolute);
    } catch {
      // Not a link: a folder or file that is not there yet, under a parent that may be one.
      return join(await resolveReal(parent, hops), basename(absolute));
    }
    // A link to something that is not there yet stands for its target. A relative target starts at the real parent: `..` under a linked parent (stow) is not the lexical one.
    return resolveReal(resolve(await resolveReal(parent, hops), target), hops + 1);
  }
}

/**
 * The real path of `path`: the symlinks of the part that exists resolved, and the rest (a folder or
 * file not created yet) appended as it is. A path that cannot be resolved (a loop of links, a folder
 * that cannot be read) stays as it is, so it is never taken for another agent's path.
 */
export function realPathOf(path: string): Promise<string> {
  return resolveReal(resolve(path), 0);
}

/** The first of `others` whose `filePath` is the same file as `filePath` once symlinks are resolved, or undefined when none is. */
export async function sameFileAs<T extends { filePath: string }>(filePath: string, others: readonly T[]): Promise<T | undefined> {
  const real = await realPathOf(filePath);
  for (const other of others) {
    if (await realPathOf(other.filePath) === real) return other;
  }
  return undefined;
}
