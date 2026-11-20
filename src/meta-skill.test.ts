import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeSkillFile = vi.fn<(filePath: string, content: string) => Promise<void>>();
const homedir = vi.fn<() => string>();

vi.mock('./skill-file.js', () => ({
  writeSkillFile,
  removeSkillDirectory: vi.fn(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir,
  };
});

describe('meta-skill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    homedir.mockReturnValue('/tmp/home');
    writeSkillFile.mockResolvedValue();
    delete process.env.HERMES_HOME;
  });

  it('documents the key mcpkit CLI workflows', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    expect(content).toContain('name: mcpkit-cli');
    expect(content).toContain('## Add / install a new MCP server');
    expect(content).toContain('mcpkit install');
    expect(content).toContain('mcpkit call <server> <tool>');
    expect(content).toContain('--chain');
    expect(content).toContain('## Persistent runtime mode');
    expect(content).toContain('--runtime persistent');
    expect(content).toContain('mcpkit runtime status');
    expect(content).toContain('mcpkit runtime stop');
    expect(content).toContain('mcpkit edit');
    expect(content).toContain('mcpkit sync');
    // Lists hermes among the supported agents
    expect(content).toContain('hermes');
  });

  it('documents the discovery commands, the schema cache and the call exit codes', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    expect(content).toContain('mcpkit search');
    expect(content).toContain('mcpkit describe');
    expect(content).toContain('mcpkit types');
    expect(content).toContain('~/.mcpkit/schemas/<server>.json');
    expect(content).toContain('server-declared, untrusted');
    expect(content).toContain('`--json`');
    expect(content).toContain('**Exit codes:** `0` on success. `1` when');
  });

  it('mentions the SessionStart hook as the way to list servers without per-server skills', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    expect(content).toContain('mcpkit hook install');
    expect(content).toContain('mcpkit hook session-start');
    expect(content).toContain('without per-server skills');
  });

  it('documents exec: the write gate with its three flags, the limits, the envelope and the exit codes', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    expect(content).toContain('## Run a script with `mcpkit exec`');
    expect(content).toContain('**Writes are denied by default.**');
    for (const flag of ['--allow <patterns>', '--allow-writes', '--allow-read-only']) {
      expect(content).toContain(flag);
    }
    expect(content).toContain('trusts what the server declares');
    for (const flag of ['--timeout', '--max-calls', '--max-output', '--memory-mb']) {
      expect(content).toContain(flag);
    }
    expect(content).toContain('{"ok":true,"result":...');
    expect(content).toContain('"kind":"script|tool|blocked|timeout|limit|interrupted|internal"');
    expect(content).toContain('`2` for usage errors');
  });

  it('documents what an unattended script needs to know about call and exec', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    // call: exit codes, omitted parts, the dash terminator, no timeout, OAuth in an unattended run
    expect(content).toContain('`2` when the params (or the params of a `--chain` call) are not a JSON object');
    expect(content).toContain('[omitted: image/png 61969 bytes; use --json or mcpkit exec]');
    expect(content).toContain('`{"content":[...]}` holding the raw parts');
    expect(content).toContain('needs `--` in front of it, and options go before the `--`');
    expect(content).toContain('`call` has no timeout of its own, so a server that freezes blocks it');
    expect(content).toContain('opens the browser and waits for the callback: run `mcpkit auth <name>` first, and use `mcpkit exec` for unattended runs');
    expect(content).toContain('`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`');

    // exec: sessions, timeout, blocked calls, unawaited calls, truncation, non-text parts
    expect(content).toContain('Sessions are per run and are not shared with persistent runtime daemons, so every `exec` pays a cold start of about 1 s per server');
    expect(content).toContain('browser state opened by `mcpkit call` through a daemon is not visible to `exec`');
    expect(content).toContain('`--timeout` is wall-clock and authoritative: the run ends as kind `timeout` whatever the script catches');
    expect(content).toContain('prints a one-line warning on stderr');
    expect(content).toContain('then `ok` can still be `true`, so check `blocked`');
    expect(content).toContain('one that fails or is blocked makes the run fail');
    expect(content).toContain('`truncated` is `true` and the logs end with a marker line');
    expect(content).toContain('comes back as a truncated string, also with `truncated: true`');
    expect(content).toContain('reach the script as the raw `{content:[...]}` parts');

    // search: collapsed twins
    expect(content).toContain('`alsoIn`');
    expect(content).toContain('`--no-collapse` lists every copy');

    // the server-name rule, the reinstall warning, update past failures, invalid registry entries
    expect(content).toContain('`[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and not contain `..`');
    expect(content).toContain('replaces the whole entry; a warning on stderr names the settings the new install does not carry over');
    expect(content).toContain('`update` tries every server: one that cannot be reached keeps its skill files, schema cache and registry entry, and the exit code is 1 if any failed');
    expect(content).toContain('is skipped with a warning and stays in the file');
  });

  it('says how an agent learns about the servers when it has no per-server skills', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    expect(content).toContain('With `mcpkit config skills guide` an agent gets only this guide and no per-server skills');
    expect(content).toContain('the session-start directory above or `mcpkit list`');
  });

  it('documents the behaviours that surprise a script: auto-refresh without a browser, the list cache refresh, update after edit and corrupt files', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    expect(content).toContain('This never opens a browser: if the server needs OAuth and has no stored tokens, the refresh is skipped');
    expect(content).toContain('`mcpkit list <server>` refreshes it too.');
    expect(content).toContain('run `mcpkit update <server>` so the schema cache and the skill files match the new server');
    expect(content).toContain('cannot be parsed is reported as an error and left untouched, never treated as empty');
  });

  it('documents how exec resolves allow patterns, reads read-only hints and treats param providers and unawaited calls', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    expect(content).toContain('`--allow-read-only` reads the hint live from the server, not from the schema cache');
    expect(content).toContain('`--allow` patterns are resolved against the registered server names');
    expect(content).toContain('(server `a.b` with tool `c`, or server `a` with tool `b.c`) is rejected with exit `2`');
    expect(content).toContain('a pattern that matches no registered server prints a warning');
    expect(content).toContain('Parameters from a configured param provider are merged into every call');
    expect(content).toContain('Calls the script started but did not await are waited for');
  });

  it('carries the shared scripting block word for word', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const { SCRIPTING_BLOCK } = await import('./generators/index.js');

    expect(buildMetaSkillContent()).toContain(SCRIPTING_BLOCK);
  });

  it('keeps the frontmatter description on one line without double quotes', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const lines = buildMetaSkillContent().split('\n');
    const description = lines.find((line) => line.startsWith('description: '));

    expect(description).toBeDefined();
    expect(description?.match(/"/g)).toHaveLength(2);
    expect(description).toContain('search and describe tools offline');
  });

  it('writes the meta-skill to each target agent skill directory', async () => {
    const { writeMetaSkill } = await import('./meta-skill.js');
    await writeMetaSkill({ agents: ['claude-code', 'hermes'], scope: 'global' });

    const paths = writeSkillFile.mock.calls.map(([filePath]) => filePath);
    expect(paths).toContain('/tmp/home/.claude/skills/mcpkit-cli/SKILL.md');
    expect(paths).toContain('/tmp/home/.hermes/skills/mcpkit-cli/SKILL.md');
    // Content is the authored meta-skill, not per-server tool boilerplate
    expect(writeSkillFile.mock.calls[0][1]).toContain('name: mcpkit-cli');
  });

  it('does not write anything in dry-run mode', async () => {
    const { writeMetaSkill } = await import('./meta-skill.js');
    await writeMetaSkill({ agents: ['claude-code'], scope: 'global', dryRun: true });

    expect(writeSkillFile).not.toHaveBeenCalled();
  });

  it('dedupes repeated agents', async () => {
    const { writeMetaSkill } = await import('./meta-skill.js');
    await writeMetaSkill({ agents: ['claude-code', 'claude-code'], scope: 'global' });

    expect(writeSkillFile).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no agents are given', async () => {
    const { writeMetaSkill } = await import('./meta-skill.js');
    await writeMetaSkill({ agents: [], scope: 'global' });

    expect(writeSkillFile).not.toHaveBeenCalled();
  });
});
