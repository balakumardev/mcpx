import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { Command, InvalidArgumentError, Option } from 'commander';
import type { CommanderError } from 'commander';
import { loadRegistry } from '../config.js';
import {
  DEFAULT_MATCHER,
  HOOK_COMMAND,
  SettingsRefusal,
  backupFile,
  installHook,
  uninstallHook,
  unifiedDiff,
  writeSettings,
} from '../hook-settings.js';
import type { SettingsEdit } from '../hook-settings.js';
import { loadSchemaCache } from '../schema-store.js';
import { jsonLine } from '../search-index.js';
import { DEFAULT_MAX_CHARS, MIN_MAX_CHARS, buildSessionContext } from '../session-context.js';
import type { DirectoryServer } from '../session-context.js';

const HOOK_AGENTS = ['claude-code', 'codex', 'cursor', 'windsurf', 'augment'] as const;
type HookAgent = typeof HOOK_AGENTS[number];

const FORMATS = ['json', 'text'] as const;
type HookFormat = typeof FORMATS[number];

/** How long the hook waits for the JSON the agent pipes in before it stops listening. */
const STDIN_CAP_MS = 200;
/** The most of stdin it reads: it never uses the content, it only empties the pipe. */
const STDIN_MAX_BYTES = 1024 * 1024;

/** What `drainStdin` needs of a stream: a terminal flag, the events, and a way to let go. */
export interface HookInput {
  isTTY?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  destroy(): unknown;
}

/** Everything the hook touches outside the files it reads, so a test can supply it. */
export interface HookIo {
  /** The hook's stdin; undefined when there is none. */
  stdin: HookInput | undefined;
  env: NodeJS.ProcessEnv;
  /** Writes to stdout and resolves when the text has been handed over. */
  write(text: string): Promise<void>;
}

function defaultIo(): HookIo {
  // A reader that went away is not a failure of a hook that must stay silent.
  process.stdout.on('error', () => {});
  let stdin: HookInput | undefined;
  try {
    stdin = process.stdin;
  } catch {
    stdin = undefined;
  }
  return {
    stdin,
    env: process.env,
    write: (text) => new Promise((done) => {
      process.stdout.write(text, () => done());
    }),
  };
}

/**
 * Read what the agent pipes to a hook until it ends, for at most `capMs` and `STDIN_MAX_BYTES`, and
 * throw it all away: the agent writes a JSON object (session_id, source, cwd, ...) that the output
 * does not depend on, and reading it only keeps the writer from a broken pipe. A terminal is never
 * read. The stream is destroyed at the end, because a pipe that stays open would keep the process
 * alive. Never rejects and never waits longer than the cap.
 */
export function drainStdin(input: HookInput, capMs: number = STDIN_CAP_MS): Promise<void> {
  if (input.isTTY) return Promise.resolve();
  return new Promise((done) => {
    let finished = false;
    let bytes = 0;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        input.destroy();
      } catch {
        // Nothing left to release.
      }
      done();
    };
    const timer = setTimeout(finish, capMs);
    input.on('data', (chunk: Buffer | string) => {
      bytes += chunk.length;
      if (bytes > STDIN_MAX_BYTES) finish();
    });
    input.on('end', finish);
    input.on('close', finish);
    input.on('error', finish);
  });
}

/** `task` with `console.warn` silenced: loading the registry warns about entries it skips, and a hook says nothing. */
async function withoutWarnings<T>(task: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await task();
  } finally {
    console.warn = warn;
  }
}

/**
 * The servers the directory lists for `agent`, read from the registry and the schema caches only:
 * nothing is started, contacted or written. A server whose entry lists no agents, or an empty
 * list, serves every agent. A server without a usable schema cache (none yet, unreadable, empty,
 * corrupt or of another version) is still listed, from its registry entry alone: one bad cache
 * must not hide the other servers.
 */
export async function loadDirectoryServers(agent: HookAgent): Promise<DirectoryServer[]> {
  const registry = await withoutWarnings(loadRegistry);
  const entries = Object.values(registry.servers)
    .filter((entry) => entry.agents === undefined || entry.agents.length === 0 || entry.agents.includes(agent));
  return Promise.all(entries.map(async (entry) => {
    const cache = await loadSchemaCache(entry.name);
    return {
      name: entry.name,
      // A hand-edited registry can hold anything here; only text is a description.
      description: typeof entry.description === 'string' ? entry.description : undefined,
      ...(cache === null ? {} : { tools: cache.tools }),
    };
  }));
}

export interface SessionStartOptions {
  agent: HookAgent;
  format: HookFormat;
  maxChars: number;
}

/**
 * Print the session-start text: the Claude Code hook protocol (one JSON line with
 * hookSpecificOutput.additionalContext) or, with the text format, the text itself. A hook must never
 * get in the way of a session, so on any failure, and when there is nothing to say, it prints
 * nothing and the exit code stays 0: an empty stdout adds no context, which is the one safe answer.
 */
export async function runSessionStart(options: SessionStartOptions, io: HookIo): Promise<void> {
  if (io.env.MCPKIT_HOOK_DISABLE === '1') return;
  try {
    const [servers] = await Promise.all([loadDirectoryServers(options.agent), io.stdin ? drainStdin(io.stdin) : undefined]);
    const text = buildSessionContext(servers, options.maxChars);
    if (text === '') return;
    await io.write(
      options.format === 'text'
        ? `${text}\n`
        : `${jsonLine({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`,
    );
  } catch {
    // Fail silent, by contract.
  }
}

interface SettingsOptions {
  agent: HookAgent;
  settings?: string;
  write?: boolean;
  matcher?: string;
}

async function readSettings(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function matcherOf(entry: unknown): string {
  const matcher = typeof entry === 'object' && entry !== null ? (entry as { matcher?: unknown }).matcher : undefined;
  return typeof matcher === 'string' ? jsonLine(matcher) : '(none)';
}

/** The preview of a change that `--write` would make, and the call to action when it was not asked for. */
function printPreview(action: 'install' | 'uninstall', path: string, before: string | undefined, edit: SettingsEdit): void {
  console.log('Preview only: nothing was written.');
  console.log(`Settings file: ${path} (${before === undefined ? 'does not exist yet; it would be created' : 'exists'})`);
  console.log('');
  if (action === 'uninstall') {
    console.log('Hook entries removed from hooks.SessionStart (those whose command starts with `mcpkit hook session-start`):');
    console.log((edit.entry as unknown[]).map(pretty).join('\n'));
  } else if (edit.replaced?.length) {
    console.log('Entry updated in place under hooks.SessionStart; it replaces the earlier command(s) of ours (duplicates are removed):');
    console.log(edit.replaced.map((command) => `  was: ${jsonLine(command)}`).join('\n'));
    console.log(pretty(edit.entry));
  } else {
    console.log('Entry added under hooks.SessionStart:');
    console.log(pretty(edit.entry));
  }
  console.log('');
  console.log('Diff:');
  console.log(unifiedDiff(path, before, edit.text));
  console.log('');
  console.log(before === undefined
    ? 'Run it again with --write to apply this.'
    : `Run it again with --write to apply this. The original is backed up first, to ${path}.mcpkit-bak-<timestamp>.`);
}

async function editSettings(action: 'install' | 'uninstall', options: SettingsOptions): Promise<void> {
  try {
    if (options.agent !== 'claude-code') {
      console.error(chalk.red(
        `mcpkit hook ${action} only supports claude-code. For ${options.agent}, run \`mcpkit hook session-start --agent ${options.agent} --format text\``
        + ' and paste its output, or inject it, where that agent supports startup context.',
      ));
      process.exitCode = 1;
      return;
    }

    const path = resolve(options.settings ?? join(homedir(), '.claude', 'settings.json'));
    const before = await readSettings(path);
    const edit = action === 'install' ? installHook(before, options.matcher ?? DEFAULT_MATCHER) : uninstallHook(before);

    if (!edit.changed) {
      console.log(action === 'install'
        ? `The SessionStart hook is already installed in ${path} (matcher ${matcherOf(edit.entry)}). Nothing to change.`
        : `The SessionStart hook is not installed in ${path}. Nothing to change.`);
      return;
    }
    if (!options.write) {
      printPreview(action, path, before, edit);
      return;
    }

    if (before !== undefined) console.log(`Backed up the original to ${await backupFile(path)}`);
    await writeSettings(path, edit.text);
    console.log(action === 'install'
      ? `${edit.replaced?.length ? 'Updated' : 'Installed'} the SessionStart hook in ${path}: new sessions run \`${HOOK_COMMAND}\`. Undo with: mcpkit hook uninstall --write`
      : `Removed the SessionStart hook from ${path}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${message}${err instanceof SettingsRefusal ? '. Nothing was written.' : ''}`));
    process.exitCode = 1;
  }
}

/** A usage error is exit 2, as for `exec`; `--help` still exits 0. */
function exitOnUsageError(error: CommanderError): never {
  process.exit(error.exitCode === 0 ? 0 : 2);
}

function nonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('expected a non-negative integer');
  return Number(value);
}

function matcherPattern(value: string): string {
  try {
    if (value === '') throw new Error('empty');
    new RegExp(value);
  } catch {
    throw new InvalidArgumentError('expected a non-empty regular expression');
  }
  return value;
}

const agentOption = (): Option => new Option('--agent <agent>', 'agent the hook is for').choices(HOOK_AGENTS).default('claude-code');

const settingsOption = (): Option => new Option('--settings <path>', 'settings file to edit (default: ~/.claude/settings.json)');

const writeOption = (): Option => new Option('--write', 'apply the change; without it the change is only printed');

export function createHookCommand(io?: HookIo): Command {
  const sessionStart = new Command('session-start')
    .description('Print the SessionStart context: a directory of the registered servers (read offline, nothing is started)')
    .addOption(agentOption())
    .addOption(new Option('--format <format>', 'json is the Claude Code hook protocol; text is the same text, raw').choices(FORMATS).default('json'))
    .addOption(new Option('--max-chars <n>', `size to fit the text in; a smaller value than ${MIN_MAX_CHARS} counts as ${MIN_MAX_CHARS}`).argParser(nonNegativeInteger).default(DEFAULT_MAX_CHARS))
    .addHelpText('after', `
Reads the server registry and the schema caches and nothing else: it never contacts a
server, starts a process or writes a file. It lists each server of the agent (a server
with no agents listed counts for every agent) with its tool counts and registry
description, names servers that have an identical tool set, and ends with the five-line
workflow for search, describe, exec and call. When the list does not fit --max-chars,
descriptions are cut to 80 characters, then the tool counts are dropped, then the
alphabetically last servers are folded into one "+n more" line. The header, the workflow
and servers with an identical tool set are never dropped, so a budget of ${MIN_MAX_CHARS} can still be
exceeded. Text from the registry and the caches is cleaned before it is printed.

Fail-silent contract: on an unreadable or corrupt registry, on any internal error, when no
server serves the agent, and when MCPKIT_HOOK_DISABLE=1 is set, it prints nothing and exits 0.
A server whose schema cache is missing, unreadable, empty, corrupt or of another version is
not an error: it is listed as "(not cached; run mcpkit update <name>)" and the others stay.
An empty stdout adds no context to the session. Only a bad flag exits 2. Stdin is read for at
most 200 ms, only when it is not a terminal, and ignored.

Examples:
  $ mcpkit hook session-start                       The Claude Code hook protocol (JSON)
  $ mcpkit hook session-start --format text         Plain text, to paste into CLAUDE.md or AGENTS.md
  $ mcpkit hook session-start --agent codex --format text --max-chars 1500`)
    .exitOverride(exitOnUsageError)
    .action(async (options: SessionStartOptions) => {
      await runSessionStart(options, io ?? defaultIo());
    });

  const install = new Command('install')
    .description('Add the SessionStart hook to the Claude Code settings (a preview unless --write)')
    .addOption(agentOption())
    .addOption(settingsOption())
    .addOption(writeOption())
    .addOption(new Option('--matcher <regex>', 'SessionStart sources the hook runs for').argParser(matcherPattern).default(DEFAULT_MATCHER))
    .addHelpText('after', `
Without --write it prints the entry it would add under hooks.SessionStart and a diff, and
writes nothing. With --write it first copies the original settings to
<settings>.mcpkit-bak-<yyyymmddhhmmss> (owner-only), then writes the merged file atomically,
keeping every other key, every other hook and the key order; a missing file and its
folders are created. The command it installs is \`${HOOK_COMMAND}\`: an
mcpkit that is missing, or too old to have this command, never shows an error. Installing twice
changes nothing, and an earlier entry of ours (any command that starts with
\`mcpkit hook session-start\`) is updated in place, not duplicated. It refuses a file that is not valid
JSON or whose hooks or hooks.SessionStart have an unexpected type (exit 1, nothing written).
Only claude-code is supported; for other agents use \`session-start --format text\`.
The default matcher omits "fork": add it with --matcher if you fork sessions.

Examples:
  $ mcpkit hook install                       Preview
  $ mcpkit hook install --write               Apply to ~/.claude/settings.json
  $ mcpkit hook install --settings ./.claude/settings.json --write`)
    .exitOverride(exitOnUsageError)
    .action(async (options: SettingsOptions) => {
      await editSettings('install', options);
    });

  const uninstall = new Command('uninstall')
    .description('Remove the SessionStart hook from the Claude Code settings (a preview unless --write)')
    .addOption(agentOption())
    .addOption(settingsOption())
    .addOption(writeOption())
    .addHelpText('after', `
Removes only hook entries whose command starts with \`mcpkit hook session-start\`, plus the groups,
the SessionStart list and the hooks object that removal leaves empty. Everything else stays.
Same preview, backup and refusal rules as install.

Examples:
  $ mcpkit hook uninstall                     Preview
  $ mcpkit hook uninstall --write`)
    .exitOverride(exitOnUsageError)
    .action(async (options: SettingsOptions) => {
      await editSettings('uninstall', options);
    });

  return new Command('hook')
    .description('Give an agent a live directory of the registered servers at session start, with no per-server skills')
    .addCommand(sessionStart)
    .addCommand(install)
    .addCommand(uninstall)
    .addHelpText('after', `
Wire it in with \`mcpkit hook install --write\` (Claude Code) or paste \`mcpkit hook session-start
--format text\` into CLAUDE.md / AGENTS.md. Hook context may not reach subagents: keep a
one-line pointer to \`mcpkit search\` in the agent's instructions as a fallback.`)
    .exitOverride(exitOnUsageError);
}
