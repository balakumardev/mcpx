import { describe, expect, it } from 'vitest';
import {
  MAX_SERVER_NAME_LENGTH,
  assertServerName,
  isSkillDirName,
  isValidServerName,
  quoteName,
  serverNameError,
  skillDirName,
} from './server-name.js';

/** Every name registered on a real machine so far: none of them may ever start failing the rule. */
const REAL_NAMES = [
  'cloudinary',
  'ticktick',
  'obsidian-search',
  'chrome-devtools',
  'reddit',
  'mailmodo',
  'cloakbrowser',
  'composio',
  'composio-personal',
  'xcodebuildmcp',
  'slack-me',
  'postman',
  'mysql-prod',
];

const HOSTILE_NAMES: Array<[string, string]> = [
  ['dot-dot', '..'],
  ['single dot', '.'],
  ['traversal', 'x/../../../victim'],
  ['forward slash', 'a/b'],
  ['backslash', 'a\\b'],
  ['leading dot', '.hidden'],
  ['leading dash', '-flag'],
  ['leading underscore', '_private'],
  ['NUL byte', 'a\0b'],
  ['newline', 'a\nb'],
  ['trailing newline', 'ok\n'],
  ['100 characters', 'a'.repeat(100)],
  ['empty', ''],
  ['space', 'my server'],
  ['dot-dot inside a name', 'a..b'],
  ['non-ASCII', 'café'],
  ['colon', 'a:b'],
  ['at sign', 'bar@1.2.3'],
];

describe('server names', () => {
  it.each(REAL_NAMES)('accepts the real name "%s"', (name) => {
    expect(isValidServerName(name)).toBe(true);
    expect(serverNameError(name)).toBeNull();
    expect(assertServerName(name)).toBe(name);
  });

  it('accepts dots and underscores inside a name, and exactly the longest allowed length', () => {
    for (const name of ['a.b', 'a_b', 'a-b', 'A1', '9lives', 'constructor', 'toString', 'a'.repeat(MAX_SERVER_NAME_LENGTH)]) {
      expect(isValidServerName(name), name).toBe(true);
    }
  });

  it.each(HOSTILE_NAMES)('rejects %s', (_label, name) => {
    expect(isValidServerName(name)).toBe(false);
    expect(() => assertServerName(name)).toThrow(/Invalid server name/);
  });

  it('rejects names that are not strings', () => {
    for (const name of [undefined, null, 42, {}, ['a']]) {
      expect(isValidServerName(name)).toBe(false);
    }
  });

  it('explains the rule in the message', () => {
    expect(serverNameError('a/b')?.message).toContain('letters, digits');
    expect(serverNameError('')?.message).toContain('must not be empty');
    expect(serverNameError('a'.repeat(65))?.message).toContain('at most 64 characters');
    expect(serverNameError('a..b')?.message).toContain('".."');
  });

  it('quotes a hostile name without letting control characters or a huge name through', () => {
    expect(quoteName('a\0b')).toBe('"a\\u0000b"');
    expect(quoteName('\u001b[31mred')).not.toContain('\u001b');
    expect(quoteName('a\u0085b\u007fc\u009fd\u2028e\u2029f')).toBe('"a\\u0085b\\u007fc\\u009fd\\u2028e\\u2029f"');
    expect(quoteName('x'.repeat(10_000)).length).toBeLessThan(60);
    expect(serverNameError('x/'.repeat(5_000))?.message.length).toBeLessThan(200);
  });

  it('builds skill directory names only for valid names', () => {
    expect(skillDirName('github')).toBe('mcpkit-github');
    expect(skillDirName('cli')).toBe('mcpkit-cli');
    expect(() => skillDirName('x/../..')).toThrow(/Invalid server name/);
  });

  it('recognises the directory names mcpkit writes and nothing else', () => {
    expect(isSkillDirName('mcpkit-github')).toBe(true);
    expect(isSkillDirName('mcpkit-cli')).toBe(true);
    for (const dir of ['victim', 'mcpkit-', 'mcpkit-..', 'mcpkit-a/b', 'mcpkit-.hidden', 'skills', '']) {
      expect(isSkillDirName(dir), dir).toBe(false);
    }
  });
});
