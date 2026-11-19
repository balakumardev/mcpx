import { mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { stageFileAtomic, writeFileAtomic } from './atomic-file.js';
import { isSkillDirName } from './server-name.js';

/**
 * The last line of defence against a path that was built wrongly: skills are only ever written to,
 * or deleted from, `<some skills directory>/mcpkit-<valid server name>/SKILL.md`. The generators
 * already build such paths only from validated names; this check is what stops a bug or a hostile
 * registry from turning a write or a recursive delete into one outside that shape. The path must be
 * absolute and free of `..`, so it is the directory it appears to be.
 */
function assertSkillFilePath(filePath: string): void {
  const wellFormed = isAbsolute(filePath)
    && !filePath.split(/[\\/]/).includes('..')
    && basename(filePath) === 'SKILL.md'
    && isSkillDirName(basename(dirname(filePath)));
  if (!wellFormed) {
    throw new Error(`Refusing to touch "${filePath}": a skill file must be <skills dir>/mcpkit-<server>/SKILL.md.`);
  }
}

export async function writeSkillFile(filePath: string, content: string): Promise<void> {
  assertSkillFilePath(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  // Replaced in one step: an interrupted refresh leaves the old skill, never a truncated one.
  await writeFileAtomic(filePath, content);
}

/** A skill file written to a temp file beside its target, so that several can be put in place together. */
export interface StagedSkillFile {
  /** Replace the skill file with the staged content. */
  commit(): Promise<void>;
  /**
   * Undo what staging and `commit` did: drop the staged copy, or after a successful `commit`
   * put the previous content back (remove the file when there was none), and remove the
   * directories made for it that are empty again. Safe to call in any state.
   */
  revert(): Promise<void>;
}

/** The content of `filePath`, or undefined when there is no such file. */
async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Remove `dir` and its parents up to `topmost` for as long as they are empty. */
async function removeEmptyDirectories(dir: string, topmost: string): Promise<void> {
  for (let current = dir; current !== dirname(current); current = dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    if (current === topmost) return;
  }
}

/**
 * The first half of `writeSkillFile`: create the directory and write the new content beside the
 * skill file, changing nothing that exists. Throws, leaving no trace, when the directory cannot
 * be made or the file cannot be written, and when the current skill file cannot be read (it is
 * kept in memory so that `revert` can put it back).
 */
export async function stageSkillFile(filePath: string, content: string): Promise<StagedSkillFile> {
  assertSkillFilePath(filePath);
  const dir = dirname(filePath);
  const previous = await readIfPresent(filePath);
  const firstDirectoryMade = await mkdir(dir, { recursive: true });
  const dropMadeDirectories = async () => {
    if (previous === undefined && firstDirectoryMade !== undefined) await removeEmptyDirectories(dir, firstDirectoryMade);
  };

  let staged: Awaited<ReturnType<typeof stageFileAtomic>>;
  try {
    staged = await stageFileAtomic(filePath, content);
  } catch (err) {
    await dropMadeDirectories();
    throw err;
  }

  let committed = false;
  return {
    async commit() {
      await staged.commit();
      committed = true;
    },
    async revert() {
      if (!committed) {
        await staged.discard();
      } else if (previous === undefined) {
        await rm(filePath, { force: true });
      } else {
        await writeFileAtomic(filePath, previous);
      }
      await dropMadeDirectories();
    },
  };
}

export async function removeSkillDirectory(filePath: string): Promise<void> {
  assertSkillFilePath(filePath);
  await rm(dirname(filePath), { recursive: true, force: true });
}
