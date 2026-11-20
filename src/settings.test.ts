import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  DEFAULT_SKILL_MODE,
  getSettingsPath,
  isExplicitSource,
  loadSettings,
  perServerAgents,
  resolveSkillMode,
  resolveSkillModeSource,
  saveSkillMode,
  skillModeFor,
} from './settings.js';
import type { LoadedSettings } from './settings.js';
import { ALL_AGENTS } from './types.js';

describe('skill settings', () => {
  const originalHome = process.env.HOME;
  const originalEnv = process.env.MCPKIT_SKILLS;
  let home = '';

  const settingsFile = () => join(home, '.mcpkit', 'config.yaml');
  const writeSettings = async (text: string) => {
    await mkdir(join(home, '.mcpkit'), { recursive: true });
    await writeFile(settingsFile(), text, 'utf-8');
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-settings-'));
    process.env.HOME = home;
    delete process.env.MCPKIT_SKILLS;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalEnv === undefined) delete process.env.MCPKIT_SKILLS;
    else process.env.MCPKIT_SKILLS = originalEnv;
    await chmod(home, 0o755).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  it('lives in its own file, not in the registry or the agent defaults', () => {
    expect(getSettingsPath()).toBe(join(home, '.mcpkit', 'config.yaml'));
  });

  describe('defaults', () => {
    it('is the guide (lean) for every agent when there is no file', async () => {
      expect(DEFAULT_SKILL_MODE).toBe('guide');
      for (const agent of ALL_AGENTS) expect(await skillModeFor(agent)).toBe('guide');
      const loaded = await loadSettings();
      expect(loaded.problems).toEqual([]);
      expect(loaded.unusable).toBe(false);
      expect(resolveSkillMode(loaded, 'claude-code')).toEqual({ mode: 'guide', source: 'default' });
    });

    it('is the guide for an empty file and for one without a skills section', async () => {
      await writeSettings('');
      expect(await skillModeFor('claude-code')).toBe('guide');
      await writeSettings('version: 1\n');
      expect(await skillModeFor('claude-code')).toBe('guide');
      expect((await loadSettings()).problems).toEqual([]);
    });

    it('do not create anything when only reading', async () => {
      await skillModeFor('claude-code');
      await loadSettings();
      expect(await readdir(home)).toEqual([]);
    });
  });

  describe('precedence', () => {
    it('is env, then the agent entry, then the default, then the built-in guide', async () => {
      await writeSettings('version: 1\nskills:\n  default: guide\n  agents:\n    claude-code: per-server\n');
      expect(await skillModeFor('claude-code')).toBe('per-server');
      expect(await skillModeFor('cursor')).toBe('guide');

      process.env.MCPKIT_SKILLS = 'guide';
      expect(await skillModeFor('claude-code')).toBe('guide');

      process.env.MCPKIT_SKILLS = 'per-server';
      expect(await skillModeFor('cursor')).toBe('per-server');
    });

    it('says where each answer came from', async () => {
      await writeSettings('version: 1\nskills:\n  default: guide\n  agents:\n    cursor: per-server\n');
      const loaded = await loadSettings();
      expect(resolveSkillMode(loaded, 'cursor')).toMatchObject({ mode: 'per-server', source: 'file', detail: 'agents.cursor' });
      expect(resolveSkillMode(loaded, 'codex')).toMatchObject({ mode: 'guide', source: 'file', detail: 'skills.default' });
      expect(resolveSkillMode(loaded, 'codex', { MCPKIT_SKILLS: 'per-server' })).toMatchObject({ mode: 'per-server', source: 'env', detail: 'MCPKIT_SKILLS' });
    });

    it('lets the env value be written in any case with spaces around it, and ignores an empty or unknown one', async () => {
      await writeSettings('version: 1\nskills:\n  default: guide\n');
      process.env.MCPKIT_SKILLS = ' Per-Server ';
      expect(await skillModeFor('claude-code')).toBe('per-server');
      process.env.MCPKIT_SKILLS = '';
      expect(await skillModeFor('claude-code')).toBe('guide');
      process.env.MCPKIT_SKILLS = 'everything';
      expect(await skillModeFor('claude-code')).toBe('guide');
      expect((await loadSettings()).problems.join('\n')).toContain('MCPKIT_SKILLS');
    });
  });

  describe('a file that cannot be used', () => {
    it.each([
      ['YAML that does not parse', 'skills: [unclosed\n  - : :\n'],
      ['a list at the top', '- guide\n'],
      ['a scalar at the top', 'guide\n'],
      ['a version of a newer mcpkit', 'version: 2\nskills:\n  default: guide\n'],
    ])('falls back to the defaults for %s, never throws, and reports it', async (_label, text) => {
      await writeSettings(text);
      expect(await skillModeFor('claude-code')).toBe('guide');
      const loaded = await loadSettings();
      expect(loaded.unusable).toBe(true);
      expect(loaded.problems.length).toBeGreaterThan(0);
      expect(loaded.problems[0]).toContain(settingsFile());
    });

    it('falls back to the defaults for a file that cannot be read', async () => {
      await mkdir(settingsFile(), { recursive: true });
      expect(await skillModeFor('claude-code')).toBe('guide');
      const loaded = await loadSettings();
      expect(loaded.unusable).toBe(true);
      expect(loaded.problems[0]).toContain('cannot read');
    });

    it('treats only the unknown values as defaults and keeps the valid ones', async () => {
      await writeSettings([
        'version: 1',
        'skills:',
        '  default: sometimes',
        '  agents:',
        '    claude-code: guide',
        '    cursor: maybe',
        '    nonesuch: guide',
        '',
      ].join('\n'));
      expect(await skillModeFor('claude-code')).toBe('guide');
      expect(await skillModeFor('cursor')).toBe('guide');
      expect(await skillModeFor('codex')).toBe('guide');
      const loaded = await loadSettings();
      expect(loaded.unusable).toBe(false);
      expect(loaded.problems).toHaveLength(3);
      expect(loaded.problems.join('\n')).toContain('"sometimes"');
      expect(loaded.problems.join('\n')).toContain('"maybe"');
      expect(loaded.problems.join('\n')).toContain('"nonesuch"');
    });

    it('does not break on a skills section of the wrong type', async () => {
      await writeSettings('version: 1\nskills: guide\n');
      expect(await skillModeFor('claude-code')).toBe('guide');
      expect((await loadSettings()).problems).toHaveLength(1);
    });

    it('is not overwritten by a save, and the file stays as it was', async () => {
      const text = 'skills: [unclosed\n';
      await writeSettings(text);
      await expect(saveSkillMode('guide', 'claude-code')).rejects.toThrow(/Nothing was written/);
      expect(await readFile(settingsFile(), 'utf-8')).toBe(text);
    });
  });

  describe('missing or read-only home', () => {
    it('reads defaults when the home directory does not exist', async () => {
      process.env.HOME = join(home, 'no', 'such', 'dir');
      expect(await skillModeFor('claude-code')).toBe('guide');
      expect((await loadSettings()).problems).toEqual([]);
    });

    it.skipIf(process.getuid?.() === 0)('reads defaults, and a save fails with an error, when the home is read-only', async () => {
      await chmod(home, 0o555);
      expect(await skillModeFor('claude-code')).toBe('guide');
      await expect(saveSkillMode('guide', 'claude-code')).rejects.toThrow();
      await chmod(home, 0o755);
      expect(await readdir(home)).toEqual([]);
    });
  });

  describe('saving', () => {
    it('writes version 1 and the skills section, owner-only, with no temp or lock file left', async () => {
      await saveSkillMode('guide', 'claude-code');

      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { agents: { 'claude-code': 'guide' } } });
      expect((await stat(settingsFile())).mode & 0o777).toBe(0o600);
      expect(await readdir(join(home, '.mcpkit'))).toEqual(['config.yaml']);
      expect(await skillModeFor('claude-code')).toBe('guide');
      expect(await skillModeFor('cursor')).toBe('guide');
    });

    it('sets the default when no agent is given, and keeps the entries of other agents', async () => {
      await saveSkillMode('guide', 'claude-code');
      await saveSkillMode('guide');
      await saveSkillMode('per-server', 'cursor');

      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({
        version: 1,
        skills: { default: 'guide', agents: { 'claude-code': 'guide', cursor: 'per-server' } },
      });
    });

    it('returns what it wrote', async () => {
      const saved = await saveSkillMode('guide', 'codex');
      expect(resolveSkillMode(saved, 'codex', {})).toMatchObject({ mode: 'guide', source: 'file' });
    });

    it('keeps the permissions of an existing file tightened to 0600 and keeps unknown top-level keys', async () => {
      await writeSettings('version: 1\nfuture: {a: 1}\nskills:\n  default: guide\n');
      await chmod(settingsFile(), 0o644);

      await saveSkillMode('per-server', 'cursor');

      const written = parse(await readFile(settingsFile(), 'utf-8')) as Record<string, unknown>;
      expect(written.future).toEqual({ a: 1 });
      expect(written.skills).toEqual({ default: 'guide', agents: { cursor: 'per-server' } });
      expect((await stat(settingsFile())).mode & 0o777).toBe(0o600);
    });

    it('drops the invalid entries it cannot keep, and says nothing else changed', async () => {
      await writeSettings('version: 1\nskills:\n  agents:\n    cursor: maybe\n    codex: guide\n');
      await saveSkillMode('guide', 'claude-code');
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({
        version: 1,
        skills: { agents: { codex: 'guide', 'claude-code': 'guide' } },
      });
    });

    it('does not touch the registry or the agent defaults file', async () => {
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(join(home, '.mcpkit', 'settings.yaml'), 'version: 1\nenabledAgents: [claude-code]\nupdatedAt: x\n', 'utf-8');
      await saveSkillMode('guide', 'claude-code');
      expect(await readFile(join(home, '.mcpkit', 'settings.yaml'), 'utf-8')).toBe('version: 1\nenabledAgents: [claude-code]\nupdatedAt: x\n');
      expect(await readdir(join(home, '.mcpkit'))).toEqual(['config.yaml', 'settings.yaml']);
    });

    it('keeps both writes when two saves race', async () => {
      await Promise.all([saveSkillMode('guide', 'claude-code'), saveSkillMode('guide', 'cursor'), saveSkillMode('guide', 'codex')]);
      expect((parse(await readFile(settingsFile(), 'utf-8')) as { skills: { agents: object } }).skills.agents).toEqual({
        'claude-code': 'guide',
        cursor: 'guide',
        codex: 'guide',
      });
    });
  });

  describe('perServerAgents', () => {
    it('keeps no agent while no setting exists: the built-in default is the guide', async () => {
      expect(await perServerAgents(['claude-code', 'cursor'])).toEqual([]);
    });

    it('keeps the agents that are set to per-server, in order', async () => {
      await saveSkillMode('per-server', 'cursor');
      await saveSkillMode('per-server', 'claude-code');
      expect(await perServerAgents(['cursor', 'claude-code', 'codex'])).toEqual(['cursor', 'claude-code']);
    });

    it('drops the agents in guide mode, in order, for the global scope', async () => {
      await saveSkillMode('per-server');
      await saveSkillMode('guide', 'claude-code');
      expect(await perServerAgents(['cursor', 'claude-code', 'codex'])).toEqual(['cursor', 'codex']);
      expect(await perServerAgents(['claude-code'])).toEqual([]);
    });

    it('keeps every agent for the project scope whatever the setting', async () => {
      await saveSkillMode('guide');
      process.env.MCPKIT_SKILLS = 'guide';
      expect(await perServerAgents(['claude-code', 'cursor'], 'project')).toEqual(['claude-code', 'cursor']);
      expect(await perServerAgents(['claude-code', 'cursor'], 'global')).toEqual([]);
    });
  });

  describe('resolveSkillModeSource', () => {
    const settingsWith = (skills: LoadedSettings['skills']): LoadedSettings => ({ path: '', skills, problems: [], unusable: false, extra: {} });
    const empty = settingsWith({ agents: {} });

    it('says builtin when nothing is configured, and the mode is the built-in default', () => {
      for (const agent of ALL_AGENTS) {
        expect(resolveSkillModeSource(empty, agent, {})).toEqual({ mode: DEFAULT_SKILL_MODE, source: 'builtin' });
      }
    });

    it('says default for skills.default, agent for the agent entry and env for MCPKIT_SKILLS', () => {
      const settings = settingsWith({ default: 'per-server', agents: { cursor: 'guide' } });
      expect(resolveSkillModeSource(settings, 'codex', {})).toEqual({ mode: 'per-server', source: 'default' });
      expect(resolveSkillModeSource(settings, 'cursor', {})).toEqual({ mode: 'guide', source: 'agent' });
      expect(resolveSkillModeSource(settings, 'cursor', { MCPKIT_SKILLS: 'per-server' })).toEqual({ mode: 'per-server', source: 'env' });
      expect(resolveSkillModeSource(settings, 'codex', { MCPKIT_SKILLS: ' GUIDE ' })).toEqual({ mode: 'guide', source: 'env' });
    });

    it('takes the environment before the agent entry, the agent entry before the default, the default before the built-in', () => {
      const both = settingsWith({ default: 'per-server', agents: { cursor: 'guide' } });
      expect(resolveSkillModeSource(both, 'cursor', { MCPKIT_SKILLS: 'per-server' }).source).toBe('env');
      expect(resolveSkillModeSource(both, 'cursor', {}).source).toBe('agent');
      expect(resolveSkillModeSource(both, 'claude-code', {}).source).toBe('default');
      expect(resolveSkillModeSource(empty, 'claude-code', {}).source).toBe('builtin');
    });

    it('does not count an empty or unknown MCPKIT_SKILLS as a source', () => {
      expect(resolveSkillModeSource(empty, 'codex', { MCPKIT_SKILLS: '' }).source).toBe('builtin');
      expect(resolveSkillModeSource(empty, 'codex', { MCPKIT_SKILLS: 'everything' }).source).toBe('builtin');
    });

    it('reads process.env when no environment is given', () => {
      process.env.MCPKIT_SKILLS = 'per-server';
      expect(resolveSkillModeSource(empty, 'codex')).toEqual({ mode: 'per-server', source: 'env' });
    });

    it('is what resolveSkillMode reports, in its older shape: file for agent and default, default for the built-in', () => {
      const settings = settingsWith({ default: 'per-server', agents: { cursor: 'guide' } });
      expect(resolveSkillMode(settings, 'cursor', {})).toEqual({ mode: 'guide', source: 'file', detail: 'agents.cursor' });
      expect(resolveSkillMode(settings, 'codex', {})).toEqual({ mode: 'per-server', source: 'file', detail: 'skills.default' });
      expect(resolveSkillMode(settings, 'codex', { MCPKIT_SKILLS: 'guide' })).toEqual({ mode: 'guide', source: 'env', detail: 'MCPKIT_SKILLS' });
      expect(resolveSkillMode(empty, 'codex', {})).toEqual({ mode: 'guide', source: 'default' });
    });

    it('isExplicitSource is true for env, agent and default, and false for builtin', () => {
      expect(isExplicitSource('env')).toBe(true);
      expect(isExplicitSource('agent')).toBe(true);
      expect(isExplicitSource('default')).toBe(true);
      expect(isExplicitSource('builtin')).toBe(false);
    });
  });
});
