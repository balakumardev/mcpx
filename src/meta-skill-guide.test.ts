import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createAgentSettings, saveAgentSettings } from './agent-config.js';
import { addServer, updateServer } from './config.js';
import { buildGuideDirectory } from './guide-directory.js';
import {
  buildMetaSkillContent,
  expectedGuideMarker,
  guideIsCurrent,
  readGuideMarker,
  writeMetaSkill,
} from './meta-skill.js';
import { saveSchemaCache } from './schema-store.js';
import { loadSettings, saveSkillMode, withSkillMode } from './settings.js';
import { linkSkillsDirectory } from './skill-fixtures.js';
import type { AgentType, ServerEntry, ToolInfo } from './types.js';

const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo a message', inputSchema: { type: 'object' } }];

function entry(name: string, agents: AgentType[] = ['claude-code'], extra: Partial<ServerEntry> = {}): ServerEntry {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: ['server.js'] },
    toolCount: 1,
    agents,
    agentSelectionMode: 'explicit',
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

/** The sha256 of what `buildMetaSkillContent()` of v0.1.32 returned: the guide text, byte for byte, without the marker line added since. Update it when the guide text itself is edited on purpose. */
const LEGACY_GUIDE_SHA256 = '7af032fd7a200f0eb707b0ed9517e184adb53de9025337918e6201cd32f07c61';

describe('the mcpkit-cli guide with a directory', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home = '';
  let stdout: string[] = [];

  const guidePath = (agent: '.claude' | '.codex' | '.cursor' = '.claude') => join(home, agent, 'skills', 'mcpkit-cli', 'SKILL.md');
  const readGuide = (agent: '.claude' | '.codex' | '.cursor' = '.claude') => readFile(guidePath(agent), 'utf-8');
  const lastLine = (content: string) => content.trimEnd().split('\n').pop();
  const descriptionOf = (content: string) => (parse(content.split('\n---\n')[0].replace(/^---\n/, '')) as { description: string }).description;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-guide-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.MCPKIT_SKILLS;
    delete process.env.HERMES_HOME;
    stdout = [];
    vi.spyOn(console, 'log').mockImplementation((...parts) => { stdout.push(parts.join(' ')); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await chmod(join(home, '.mcpkit'), 0o755).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  describe('buildMetaSkillContent', () => {
    it('is byte for byte the guide of v0.1.32 when there is no directory, plus the marker line', () => {
      const content = buildMetaSkillContent({ pkgVersion: '1.2.3' });
      const marker = '<!-- mcpkit-guide v1.2.3 dir:none -->\n';

      expect(content.endsWith(marker)).toBe(true);
      expect(createHash('sha256').update(content.slice(0, -marker.length)).digest('hex')).toBe(LEGACY_GUIDE_SHA256);
    });

    it('is the same with an empty directory (no servers) as with none', () => {
      expect(buildMetaSkillContent({ directory: buildGuideDirectory([]), pkgVersion: '1.2.3' })).toBe(buildMetaSkillContent({ pkgVersion: '1.2.3' }));
    });

    it('ends with the marker: the version of the package and dir:none, or the fingerprint of the directory', () => {
      const directory = buildGuideDirectory([{ name: 'demo', description: 'Demo server', tools }]);

      expect(lastLine(buildMetaSkillContent({ pkgVersion: '0.9.0' }))).toBe('<!-- mcpkit-guide v0.9.0 dir:none -->');
      expect(lastLine(buildMetaSkillContent({ directory, pkgVersion: '0.9.0' }))).toBe(`<!-- mcpkit-guide v0.9.0 dir:${directory.fingerprint} -->`);
      expect(readGuideMarker(buildMetaSkillContent({ directory, pkgVersion: '0.9.0' }))).toBe(`<!-- mcpkit-guide v0.9.0 dir:${directory.fingerprint} -->`);
      expect(readGuideMarker('# a guide without a marker\n')).toBeNull();
    });

    it('takes the version of the package by default: the injected one when there is one, and a dev version when the sources run unbundled', () => {
      expect(lastLine(buildMetaSkillContent())).toBe('<!-- mcpkit-guide v0.0.0-dev dir:none -->');
      vi.stubGlobal('__PKG_VERSION__', '7.8.9');
      expect(lastLine(buildMetaSkillContent())).toBe('<!-- mcpkit-guide v7.8.9 dir:none -->');
    });

    it('appends the suffix to the description (one line, valid YAML) and the section after the body, and changes nothing else', () => {
      const directory = buildGuideDirectory([
        { name: 'ticktick', description: 'Tasks "q" and \\ x', tools },
      ]);
      const plain = buildMetaSkillContent({ pkgVersion: '1.0.0' });
      const withDirectory = buildMetaSkillContent({ directory, pkgVersion: '1.0.0' });

      expect(withDirectory.split('\n').filter((line) => line.startsWith('description: '))).toHaveLength(1);
      expect(descriptionOf(withDirectory)).toBe(`${descriptionOf(plain)} ${directory.descriptionSuffix}`);
      // A quote and a backslash of a server text reach the parsed description through the quoting, not around it.
      expect(descriptionOf(withDirectory)).toContain('ticktick (Tasks "q" and \\ x)');

      const body = (text: string) => text.slice(text.indexOf('\n---\n') + 5);
      const plainBody = body(plain).replace(/<!-- mcpkit-guide .* -->\n$/, '');
      expect(body(withDirectory).startsWith(plainBody)).toBe(true);
      expect(body(withDirectory).slice(plainBody.length)).toBe(`\n${directory.bodySection}\n\n<!-- mcpkit-guide v1.0.0 dir:${directory.fingerprint} -->\n`);
      expect(withDirectory).toContain('## MCP servers reachable through mcpkit (live list)');
    });
  });

  describe('writeMetaSkill', () => {
    it('writes the directory of the agent into the guide of an agent in guide mode (the built-in default), and returns the paths', async () => {
      await addServer(entry('ticktick', ['claude-code'], { description: 'Tasks and projects' }));
      await addServer(entry('slack', ['claude-code', 'codex']));
      await addServer(entry('only-cursor', ['cursor']));
      await saveSchemaCache('ticktick', tools);

      const written = await writeMetaSkill({ agents: ['claude-code', 'codex'], scope: 'global', pkgVersion: '1.0.0' });

      expect(written).toEqual([guidePath('.claude'), guidePath('.codex')]);
      const claude = await readGuide('.claude');
      expect(claude).toContain('## MCP servers reachable through mcpkit (live list)');
      expect(claude).toContain('- ticktick (1 tool, 0 read-only): Tasks and projects');
      expect(claude).toContain('- slack');
      expect(claude).not.toContain('only-cursor');
      expect(descriptionOf(claude)).toContain('slack, ticktick (Tasks and projects)');
      expect(descriptionOf(claude).length).toBeLessThan(960);
      // codex serves slack but not ticktick.
      const codex = await readGuide('.codex');
      expect(codex).toContain('- slack');
      expect(codex).not.toContain('ticktick');
      expect(lastLine(claude)).toMatch(/^<!-- mcpkit-guide v1\.0\.0 dir:[0-9a-f]{12} -->$/);
      expect(lastLine(claude)).not.toBe(lastLine(codex));
    });

    it('lists a defaults-mode server in the guide of an agent that was enabled after it was installed, and respects an explicit list', async () => {
      await addServer(entry('later', ['claude-code'], { agentSelectionMode: 'defaults' }));
      await addServer(entry('pinned', ['claude-code']));
      await saveAgentSettings(createAgentSettings(['claude-code', 'cursor'], '2026-01-01T00:00:00.000Z'));

      await writeMetaSkill({ agents: ['claude-code', 'cursor'], scope: 'global', pkgVersion: '1.0.0' });

      const cursor = await readGuide('.cursor');
      expect(cursor).toContain('- later');
      expect(cursor).not.toContain('pinned');
      expect(descriptionOf(cursor)).toContain('later');
      const claude = await readGuide('.claude');
      expect(claude).toContain('- later');
      expect(claude).toContain('- pinned');
    });

    it('writes the generic guide for an agent on per-server skills, and for an empty registry', async () => {
      await addServer(entry('ticktick'));
      await saveSkillMode('per-server', 'claude-code');

      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', pkgVersion: '1.0.0' });
      expect(await readGuide()).toBe(buildMetaSkillContent({ pkgVersion: '1.0.0' }));

      await rm(join(home, '.mcpkit'), { recursive: true, force: true });
      await writeMetaSkill({ agents: ['codex'], scope: 'global', pkgVersion: '1.0.0' });
      expect(await readGuide('.codex')).toBe(buildMetaSkillContent({ pkgVersion: '1.0.0' }));
      expect(lastLine(await readGuide('.codex'))).toBe('<!-- mcpkit-guide v1.0.0 dir:none -->');
    });

    it('follows MCPKIT_SKILLS, which beats the file', async () => {
      await addServer(entry('ticktick'));
      await saveSkillMode('guide', 'claude-code');
      vi.stubEnv('MCPKIT_SKILLS', 'per-server');

      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', pkgVersion: '1.0.0' });

      expect(await readGuide()).toBe(buildMetaSkillContent({ pkgVersion: '1.0.0' }));
    });

    it('uses the settings it is given instead of the file, for a caller that saves the mode after writing the guide', async () => {
      await addServer(entry('ticktick'));
      await saveSkillMode('per-server', 'claude-code');
      const after = withSkillMode(await loadSettings(), 'guide', 'claude-code');

      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', pkgVersion: '1.0.0', settings: after });

      expect(await readGuide()).toContain('- ticktick');
    });

    it('writes no directory into a project-scope guide: the list of servers of the user is not for a repository', async () => {
      const project = join(home, 'project');
      await mkdir(project, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(project);
      await addServer(entry('ticktick'));

      const written = await writeMetaSkill({ agents: ['claude-code'], scope: 'project', pkgVersion: '1.0.0' });

      expect(written).toEqual([join(project, '.claude', 'skills', 'mcpkit-cli', 'SKILL.md')]);
      expect(await readFile(written[0], 'utf-8')).toBe(buildMetaSkillContent({ pkgVersion: '1.0.0' }));
    });

    it('prints what it wrote unless it is quiet, and a dry run prints without writing and returns nothing', async () => {
      await addServer(entry('ticktick'));

      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', logPrefix: '  ' });
      expect(stdout.join('\n')).toContain(`  ✓ mcpkit-cli guide (claude-code): ${guidePath()}`);

      stdout = [];
      const before = await readGuide();
      expect(await writeMetaSkill({ agents: ['codex'], scope: 'global', dryRun: true })).toEqual([]);
      expect(stdout.join('\n')).toContain(`[dry-run] mcpkit-cli guide (codex): ${guidePath('.codex')}`);
      expect(existsSync(guidePath('.codex'))).toBe(false);
      expect(await readGuide()).toBe(before);
    });

    it('prints nothing at all when quiet, on stdout, on console.log and on a dry run, and still returns the paths', async () => {
      await addServer(entry('ticktick'));
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const written = await writeMetaSkill({ agents: ['claude-code', 'codex'], scope: 'global', quiet: true });
      const dry = await writeMetaSkill({ agents: ['cursor'], scope: 'global', quiet: true, dryRun: true });

      expect(written).toEqual([guidePath('.claude'), guidePath('.codex')]);
      expect(dry).toEqual([]);
      expect(stdout).toEqual([]);
      expect(write).not.toHaveBeenCalled();
      expect(existsSync(guidePath('.cursor'))).toBe(false);
      expect(existsSync(guidePath('.claude'))).toBe(true);
    });

    it('writes each agent once and leaves no temp file behind', async () => {
      await addServer(entry('ticktick'));
      const written = await writeMetaSkill({ agents: ['claude-code', 'claude-code'], scope: 'global', quiet: true });

      expect(written).toEqual([guidePath()]);
      expect(await readdir(join(home, '.claude', 'skills', 'mcpkit-cli'))).toEqual(['SKILL.md']);
    });

    it('returns an empty list for no agents', async () => {
      expect(await writeMetaSkill({ agents: [], scope: 'global', quiet: true })).toEqual([]);
    });

    it('leaves an existing guide as it is when the registry cannot be read, and writes a generic one when there is none', async () => {
      await addServer(entry('ticktick'));
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      const good = await readGuide();
      await writeFile(join(home, '.mcpkit', 'servers.yaml'), 'servers: [unclosed', 'utf-8');

      const written = await writeMetaSkill({ agents: ['claude-code', 'codex'], scope: 'global', quiet: true, pkgVersion: '2.0.0' });

      expect(written).toEqual([guidePath('.codex')]);
      expect(await readGuide()).toBe(good);
      expect(await readGuide('.codex')).toBe(buildMetaSkillContent({ pkgVersion: '2.0.0' }));
    });
  });

  describe('one guide file that two agents read: a skills directory shared through a symlink (~/.codex/skills -> ~/.claude/skills)', () => {
    const allThree = ['claude-only', 'both', 'codex-only'];

    beforeEach(async () => {
      await linkSkillsDirectory('codex', 'claude-code');
      await addServer(entry('claude-only', ['claude-code'], { description: 'Only Claude Code' }));
      await addServer(entry('both', ['claude-code', 'codex'], { description: 'Both agents' }));
      await addServer(entry('codex-only', ['codex'], { description: 'Only Codex' }));
    });

    it('writes the file once, with the servers of both agents, and the guide of each is current', async () => {
      const written = await writeMetaSkill({ agents: ['claude-code', 'codex'], scope: 'global', pkgVersion: '1.0.0' });

      expect(written).toEqual([guidePath('.claude')]);
      const guide = await readGuide('.claude');
      expect(await readGuide('.codex')).toBe(guide);
      for (const name of allThree) expect(guide).toContain(`- ${name}`);
      for (const name of allThree) expect(descriptionOf(guide)).toContain(name);
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(true);
      expect(await guideIsCurrent('codex', { pkgVersion: '1.0.0' })).toBe(true);
      expect(stdout.join('\n')).toContain(`✓ mcpkit-cli guide (codex): ${guidePath('.codex')} (the same file as the claude-code guide)`);
    });

    it('writes the servers of both agents whichever one of them it is written for', async () => {
      for (const agent of ['codex', 'claude-code'] as const) {
        await rm(guidePath('.claude'), { force: true });

        await writeMetaSkill({ agents: [agent], scope: 'global', quiet: true, pkgVersion: '1.0.0' });

        const guide = await readGuide('.claude');
        for (const name of allThree) expect(guide, agent).toContain(`- ${name}`);
      }
    });

    it('keeps the servers of the agent in guide mode when the agent on per-server skills writes the file', async () => {
      await saveSkillMode('per-server', 'codex');

      await writeMetaSkill({ agents: ['codex'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });

      const guide = await readGuide('.codex');
      expect(guide).toContain('- claude-only');
      expect(guide).toContain('- both');
      // Codex reads a per-server skill for each of its servers, so its own servers are not added to the list.
      expect(guide).not.toContain('codex-only');
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(true);
    });
  });

  describe('the frontmatter is valid for a strict YAML parser (PyYAML, Ruby), whatever a server wrote', () => {
    // YAML 1.2 c-printable (tab, LF, CR, U+0020 to U+007E, U+0085, U+00A0 to U+D7FF, U+E000 to U+FFFD, U+10000 up),
    // without U+0085, U+2028 and U+2029: YAML 1.1 parsers take those three for line breaks. The `yaml` package
    // accepts anything, which is why this is checked here and not by parsing.
    const STRICT_RAW = /^[\t\n\r\u0020-\u007E\u00A0-\u2027\u202A-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

    const frontmatterOf = (content: string): string => content.slice(content.indexOf('---\n') + 4, content.indexOf('\n---\n'));
    const descriptionLineOf = (content: string): string => {
      const line = frontmatterOf(content).split('\n').find((candidate) => candidate.startsWith('description: '));
      if (line === undefined) throw new Error('the guide has no description line');
      return line;
    };

    function expectStrictlyValid(content: string, label: string): void {
      const frontmatter = frontmatterOf(content);
      for (const char of frontmatter) {
        if (!STRICT_RAW.test(char)) throw new Error(`${label}: U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} is raw in the frontmatter`);
      }
      // One description line, nothing that starts a new line in YAML 1.1, and the scalar closes where it should.
      expect(frontmatter.split('\n').filter((line) => line.startsWith('description: ')), label).toHaveLength(1);
      expect(frontmatter.split('\n'), label).toHaveLength(2);
      expect(descriptionLineOf(content), label).toMatch(/^description: ".*"$/u);
      expect(typeof descriptionOf(content), label).toBe('string');
    }

    const hostileChars = [
      '\uFFFE', '\uFFFF', '\uFDD0', '\uFDEF', '\u0085', '\u2028', '\u2029', '\uD800', '\uDC00', '\u0000', '\u0007', '\u001b', '\u007f', '\u0080', '\u009f',
      '\u202e', '\u2066', '\u200f', '\u200e', '\u061c', '\u{1FFFE}', '\u{10FFFF}', '\u0378', '\u{E0000}', '\ufeff', '\ue000', '\t', '\r', '\n', '"', '\\',
    ];

    it('holds for every hostile character alone and all of them together, in a description, a server name and a tool name', () => {
      const everything = hostileChars.join('');
      const cases = [...hostileChars, everything, `ok ${everything} ok`];
      for (const text of cases) {
        for (const server of [
          { name: 'srv', description: `desc ${text} end`, tools },
          { name: `n${text}n`, description: 'Named oddly', tools },
          { name: 'tooly', description: 'Tool named oddly', tools: [{ name: `t${text}t`, description: 'x', inputSchema: { type: 'object' } }] },
        ]) {
          const directory = buildGuideDirectory([server, { name: 'twin', description: 'Second server', tools }]);
          expectStrictlyValid(buildMetaSkillContent({ directory, pkgVersion: '1.0.0' }), JSON.stringify(text));
        }
      }
    });

    it('holds for a 100 KB description of hostile characters, and for random text over the whole code point range', () => {
      const big = `${hostileChars.join('')} `.repeat(Math.ceil(100_000 / (hostileChars.length + 1))).slice(0, 100_000);
      expect(big.length).toBe(100_000);
      expectStrictlyValid(buildMetaSkillContent({ directory: buildGuideDirectory([{ name: 'big', description: big, tools }]), pkgVersion: '1.0.0' }), '100 KB');

      // A seeded generator: the same text on every run.
      let seed = 0x2f6e2b1;
      const next = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (let round = 0; round < 150; round++) {
        let text = '';
        for (let index = 0; index < 120; index++) {
          // Mostly the whole range (surrogates and noncharacters included), now and then a word, so that something is left to read.
          text += next() < 0.15 ? 'word ' : String.fromCharCode(Math.floor(next() * 0x10000));
          if (next() < 0.1) text += String.fromCodePoint(0x10000 + Math.floor(next() * 0x100000));
        }
        const directory = buildGuideDirectory([{ name: `fuzz${round}`, description: text, tools }, { name: 'plain', description: 'Plain', tools }]);
        expectStrictlyValid(buildMetaSkillContent({ directory, pkgVersion: '1.0.0' }), `round ${round}`);
      }
    });

    it('keeps the text readable: a hostile description still shows its words, and the YAML round trip gives the description back', () => {
      const directory = buildGuideDirectory([{ name: 'work', description: `Mail\uFFFE and\u2028 Calendar\u0085 tools\uFFFF`, tools }]);
      const content = buildMetaSkillContent({ directory, pkgVersion: '1.0.0' });

      expectStrictlyValid(content, 'readable');
      expect(descriptionOf(content)).toBe(`${descriptionOf(buildMetaSkillContent({ pkgVersion: '1.0.0' }))} ${directory.descriptionSuffix}`);
      expect(directory.descriptionSuffix).toContain('work (Mail and Calendar tools)');
    });

    it('writes the three YAML 1.1 line breaks, DEL, the C1 block and the noncharacters as escapes even if one reaches the guide unsanitised, and the parsed description is exact', () => {
      const raw = 'x\u0085y\u2028z\u2029w\u007fv\u0090u\uFFFEt\uFFFFs';
      const directory = { descriptionSuffix: raw, bodySection: '## section', fingerprint: 'abc123' };
      const content = buildMetaSkillContent({ directory, pkgVersion: '1.0.0' });

      expectStrictlyValid(content, 'unsanitised');
      expect(descriptionLineOf(content)).toContain('x\\u0085y\\u2028z\\u2029w\\u007fv\\u0090u\\ufffet\\uffffs');
      expect(descriptionOf(content)).toBe(`${descriptionOf(buildMetaSkillContent({ pkgVersion: '1.0.0' }))} ${raw}`);
    });

    it('changes nothing for text that is printable: quotes, backslashes, accents, CJK and emoji come out as JSON quoting writes them', () => {
      const text = 'Quote " back \\ slash é 中文 😀 — dash';
      const directory = { descriptionSuffix: text, bodySection: '## section', fingerprint: 'abc123' };
      const line = descriptionLineOf(buildMetaSkillContent({ directory, pkgVersion: '1.0.0' }));
      expect(line).toBe(`description: ${JSON.stringify(`${descriptionOf(buildMetaSkillContent({ pkgVersion: '1.0.0' }))} ${text}`)}`);
    });
  });

  describe('expectedGuideMarker and guideIsCurrent', () => {
    it('are false and null where nothing is written yet', async () => {
      expect(await guideIsCurrent('claude-code')).toBe(false);
      expect(await expectedGuideMarker('claude-code', { pkgVersion: '1.0.0' })).toBe('<!-- mcpkit-guide v1.0.0 dir:none -->');
    });

    it('expects the marker a write would put on the guide, for a guide agent and for a per-server agent', async () => {
      await addServer(entry('ticktick', ['claude-code', 'codex'], { description: 'Tasks' }));
      await saveSkillMode('per-server', 'codex');
      await writeMetaSkill({ agents: ['claude-code', 'codex'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });

      expect(await expectedGuideMarker('claude-code', { pkgVersion: '1.0.0' })).toBe(lastLine(await readGuide('.claude')));
      expect(await expectedGuideMarker('codex', { pkgVersion: '1.0.0' })).toBe('<!-- mcpkit-guide v1.0.0 dir:none -->');
      expect(await expectedGuideMarker('codex', { pkgVersion: '1.0.0' })).toBe(lastLine(await readGuide('.codex')));
    });

    it('is true after a write and turns false when a server is added, when a description changes, when the cache changes and when the package version changes', async () => {
      await addServer(entry('ticktick', ['claude-code'], { description: 'Tasks' }));
      await saveSchemaCache('ticktick', tools);
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      const current = () => guideIsCurrent('claude-code', { pkgVersion: '1.0.0' });
      expect(await current()).toBe(true);

      // A server is added.
      await addServer(entry('slack', ['claude-code']));
      expect(await current()).toBe(false);
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      expect(await current()).toBe(true);

      // A description changes.
      await updateServer('ticktick', (server) => { server.description = 'Tasks, projects and habits'; });
      expect(await current()).toBe(false);
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      expect(await current()).toBe(true);

      // A cache changes.
      await saveSchemaCache('ticktick', [...tools, { name: 'more', description: 'More', inputSchema: { type: 'object' } }]);
      expect(await current()).toBe(false);
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      expect(await current()).toBe(true);

      // A newer mcpkit.
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.1' })).toBe(false);
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.1' });
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.1' })).toBe(true);
      expect(await current()).toBe(false);
    });

    it('turns false for a guide that has no marker (written by an older mcpkit) and for a removed server', async () => {
      await addServer(entry('ticktick', ['claude-code']));
      await mkdir(join(home, '.claude', 'skills', 'mcpkit-cli'), { recursive: true });
      await writeFile(guidePath(), buildMetaSkillContent({ pkgVersion: '1.0.0' }).replace(/<!-- mcpkit-guide .* -->\n$/, ''), 'utf-8');
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(false);

      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(true);
      await rm(join(home, '.mcpkit', 'servers.yaml'));
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(false);
    });

    it('cannot tell, and says false and null, when the registry cannot be read', async () => {
      await addServer(entry('ticktick'));
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      await writeFile(join(home, '.mcpkit', 'servers.yaml'), 'servers: [unclosed', 'utf-8');

      expect(await expectedGuideMarker('claude-code', { pkgVersion: '1.0.0' })).toBeNull();
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(false);
    });

    it('is not current for a per-server agent that has moved to guide mode, and is once the guide is rewritten', async () => {
      await addServer(entry('ticktick'));
      await saveSkillMode('per-server', 'claude-code');
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(true);

      await saveSkillMode('guide', 'claude-code');
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(false);
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(true);
    });

    it('is current right after the switch to guide that `config skills guide` does: the guide is written before the mode is saved', async () => {
      await addServer(entry('ticktick'));
      await saveSkillMode('per-server', 'claude-code');
      const after = withSkillMode(await loadSettings(), 'guide', 'claude-code');

      // What the command does: the guide first (with the settings it is about to save), then the setting.
      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0', settings: after });
      await saveSkillMode('guide', 'claude-code');

      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(true);
      expect(await readGuide()).toContain('- ticktick');
    });

    it('would not be current if the guide were written from the mode on disk, which is what passing the settings prevents', async () => {
      await addServer(entry('ticktick'));
      await saveSkillMode('per-server', 'claude-code');

      await writeMetaSkill({ agents: ['claude-code'], scope: 'global', quiet: true, pkgVersion: '1.0.0' });
      await saveSkillMode('guide', 'claude-code');

      expect(await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' })).toBe(false);
    });

    it('reads files only: it neither creates nor changes anything', async () => {
      await addServer(entry('ticktick'));
      const before = await readdir(home, { recursive: true });

      await guideIsCurrent('claude-code', { pkgVersion: '1.0.0' });
      await expectedGuideMarker('claude-code', { pkgVersion: '1.0.0' });

      expect(await readdir(home, { recursive: true })).toEqual(before);
    });
  });
});
