import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realPathOf, sameFileAs } from './same-file.js';

describe('realPathOf and sameFileAs: paths that are one file through a symlink', () => {
  let dir = '';
  let real = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpkit-same-file-'));
    // The temp directory itself can sit behind a link (macOS: /var -> /private/var).
    real = await realpath(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves a linked skills directory, with the part that is not there yet appended', async () => {
    await mkdir(join(dir, 'claude', 'skills'), { recursive: true });
    await mkdir(join(dir, 'codex'));
    await symlink(join(dir, 'claude', 'skills'), join(dir, 'codex', 'skills'));

    expect(await realPathOf(join(dir, 'codex', 'skills', 'mcpkit-cli', 'SKILL.md'))).toBe(join(real, 'claude', 'skills', 'mcpkit-cli', 'SKILL.md'));
    expect(await realPathOf(join(dir, 'claude', 'skills', 'mcpkit-cli', 'SKILL.md'))).toBe(join(real, 'claude', 'skills', 'mcpkit-cli', 'SKILL.md'));
    expect(await realPathOf(join(dir, 'cursor', 'skills', 'mcpkit-cli', 'SKILL.md'))).toBe(join(real, 'cursor', 'skills', 'mcpkit-cli', 'SKILL.md'));
  });

  it('takes a link to a directory that is not created yet for that directory', async () => {
    await mkdir(join(dir, 'codex'));
    await symlink(join(dir, 'claude', 'skills'), join(dir, 'codex', 'skills'));

    expect(await realPathOf(join(dir, 'codex', 'skills', 'mcpkit-a', 'SKILL.md'))).toBe(join(real, 'claude', 'skills', 'mcpkit-a', 'SKILL.md'));
  });

  it('resolves a relative link that is not created yet from the real folder it sits in (stow: ~/.codex -> dotfiles/codex, dotfiles/codex/skills -> ../claude/skills)', async () => {
    await mkdir(join(dir, 'dotfiles', 'codex'), { recursive: true });
    await mkdir(join(dir, 'dotfiles', 'claude'));
    await mkdir(join(dir, 'home'));
    await symlink(join(dir, 'dotfiles', 'codex'), join(dir, 'home', '.codex'));
    await symlink(join(dir, 'dotfiles', 'claude'), join(dir, 'home', '.claude'));
    // Relative, and dotfiles/claude/skills is not there yet: from home/.codex, `..` lexically would be home/.
    await symlink(join('..', 'claude', 'skills'), join(dir, 'dotfiles', 'codex', 'skills'));

    const expected = join(real, 'dotfiles', 'claude', 'skills', 'mcpkit-cli', 'SKILL.md');
    expect(await realPathOf(join(dir, 'home', '.codex', 'skills', 'mcpkit-cli', 'SKILL.md'))).toBe(expected);
    expect(await realPathOf(join(dir, 'home', '.claude', 'skills', 'mcpkit-cli', 'SKILL.md'))).toBe(expected);
  });

  it('leaves a path that cannot be resolved (a loop of links) as it is, so it matches only itself', async () => {
    await symlink(join(dir, 'b'), join(dir, 'a'));
    await symlink(join(dir, 'a'), join(dir, 'b'));

    expect(await realPathOf(join(dir, 'a', 'SKILL.md'))).toBe(join(dir, 'a', 'SKILL.md'));
  });

  it('finds the skill of another agent that is the same file, and none when there is none', async () => {
    await mkdir(join(dir, 'claude', 'skills'), { recursive: true });
    await mkdir(join(dir, 'codex'));
    await symlink(join(dir, 'claude', 'skills'), join(dir, 'codex', 'skills'));
    const claude = { agent: 'claude-code', filePath: join(dir, 'claude', 'skills', 'mcpkit-a', 'SKILL.md') };
    const cursor = { agent: 'cursor', filePath: join(dir, 'cursor', 'skills', 'mcpkit-a', 'SKILL.md') };

    expect(await sameFileAs(join(dir, 'codex', 'skills', 'mcpkit-a', 'SKILL.md'), [cursor, claude])).toBe(claude);
    expect(await sameFileAs(join(dir, 'codex', 'skills', 'mcpkit-b', 'SKILL.md'), [cursor, claude])).toBeUndefined();
    expect(await sameFileAs(cursor.filePath, [])).toBeUndefined();
  });
});
