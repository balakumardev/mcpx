import chalk from 'chalk';
import { access, readFile } from 'node:fs/promises';
import { loadDirectoryServersChecked } from './directory.js';
import type { DirectorySource } from './directory-snapshot.js';
import { SCRIPTING_BLOCK, getGenerator } from './generators/index.js';
import { buildGuideDirectory } from './guide-directory.js';
import type { GuideDirectory } from './guide-directory.js';
import { realPathOf } from './same-file.js';
import type { DirectoryServer } from './session-context.js';
import { loadSettings, resolveSkillModeSource } from './settings.js';
import type { LoadedSettings } from './settings.js';
import { writeSkillFile } from './skill-file.js';
import { ALL_AGENTS } from './types.js';
import type { AgentType, Scope } from './types.js';

// The meta-skill is written to <agent>/skills/mcpkit-cli/SKILL.md. We reuse the
// per-agent generators to resolve that path (they build `mcpkit-${serverName}`),
// so passing serverName 'cli' yields the `mcpkit-cli` skill directory for free
// and stays correct as agents are added or their paths change.
const META_SKILL_SERVER_NAME = 'cli';

const META_DESCRIPTION =
  'Use this to operate the mcpkit CLI itself — add/install new MCP servers as agent skills, '
  + 'call MCP tools from Bash, search and describe tools offline, script several calls with exec, '
  + 'run servers as persistent background daemons, and manage '
  + '(list, view, edit, sync, update, remove, auth) registered servers. Use whenever the user '
  + 'wants to add a new MCP server, wire up an MCP tool, or manage existing mcpkit servers.';

export interface BuildMetaSkillOptions {
  /** The live server directory to put in the guide (its description and its body); without one the guide is the generic text. */
  directory?: GuideDirectory;
  /** The version written into the trailing marker; the version of this mcpkit by default. */
  pkgVersion?: string;
}

/** The version of this mcpkit: injected at build time, and not defined when the sources run unbundled (a test, tsx). */
export function defaultPkgVersion(): string {
  return typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0-dev';
}

/**
 * Characters that may not stand raw in a YAML double-quoted scalar for a strict parser (PyYAML, Ruby's
 * Psych): the YAML 1.2 printable set (tab, space to `~`, U+00A0 to U+D7FF, U+E000 to U+FFFD, the astral
 * planes) without U+0085, U+2028 and U+2029, which YAML 1.1 parsers take for line breaks. Everything else
 * (controls, DEL, the C1 block, U+FFFE and U+FFFF) is not printable in either version.
 */
const NOT_RAW_IN_YAML = /[^\t\u0020-\u007E\u00A0-\u2027\u202A-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/**
 * `text` as a YAML double-quoted scalar on one line. JSON quoting is one (so a quote or a backslash in
 * server text cannot break the line), but it leaves some characters raw that a strict YAML parser rejects
 * or reads as a line break; those are written as `\uXXXX` escapes, which every parser decodes to the same
 * text. The text from servers is cleaned before it gets here (`neutralize`), so this changes nothing for it:
 * it keeps the frontmatter valid whatever reaches it.
 */
function yamlQuoted(text: string): string {
  return JSON.stringify(text).replace(NOT_RAW_IN_YAML, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`);
}

const GUIDE_MARKER_LINE = /^<!-- mcpkit-guide v\S+ dir:\S+ -->$/;

/**
 * The last line of every guide: which mcpkit wrote it and a fingerprint of the directory in it
 * (`none` when it has none). A guide whose marker equals the one a fresh write would produce is
 * current, and nothing needs to be rewritten.
 */
function guideMarker(pkgVersion: string, directory: GuideDirectory | undefined): string {
  return `<!-- mcpkit-guide v${pkgVersion} dir:${directory === undefined ? 'none' : directory.fingerprint} -->`;
}

/** The marker line a guide ends with, or null when `content` has none. */
export function readGuideMarker(content: string): string | null {
  const last = content.trimEnd().split('\n').pop() ?? '';
  return GUIDE_MARKER_LINE.test(last) ? last : null;
}

/**
 * Build the `mcpkit-cli` meta-skill — a hand-authored SKILL.md that teaches an
 * agent how to drive the mcpkit CLI itself. Identical across every target agent
 * (only the output path differs), so it mirrors `buildSkillContent`'s shape.
 *
 * Lines are single-quoted JS strings on purpose: backticks pass through as
 * literal markdown, and `${VAR}` placeholders are NOT interpolated.
 */
export function buildMetaSkillContent(options: BuildMetaSkillOptions = {}): string {
  const directory = options.directory !== undefined && options.directory.bodySection !== '' ? options.directory : undefined;
  const description = directory === undefined ? META_DESCRIPTION : `${META_DESCRIPTION} ${directory.descriptionSuffix}`;
  const lines: string[] = [
    '---',
    'name: mcpkit-cli',
    // A valid YAML double-quoted scalar on one line, whatever the server text holds.
    `description: ${yamlQuoted(description)}`,
    '---',
    '',
    '# mcpkit CLI',
    '',
    'mcpkit turns any MCP server into Bash-callable CLI commands plus lightweight SKILL.md files for AI coding agents. Use this skill to drive mcpkit itself: add new MCP servers, call their tools, run them as persistent daemons, and manage what is installed.',
    '',
    '> **Important:** mcpkit-installed tools are NOT native MCP tools. Never call them as `mcp__<server>__*`. Always invoke via Bash: `mcpkit call <server> <tool> <json>`.',
    '',
    '## Add / install a new MCP server',
    '',
    '`mcpkit install <server-spec>` accepts several spec formats:',
    '',
    '```bash',
    '# npm package / command string (stdio)',
    'mcpkit install "@modelcontextprotocol/server-github" -n github',
    'mcpkit install "npx -y @browsermcp/mcp" -n browsermcp',
    '',
    '# remote HTTP or SSE URL',
    'mcpkit install https://mcp.example.com/sse -n example',
    '',
    '# inline JSON (Claude-style mcpServers wrapper, or a single {command|url} object)',
    'mcpkit install \'{"mcpServers":{"gh":{"command":"npx","args":["-y","@modelcontextprotocol/server-github"]}}}\'',
    '',
    '# a .json file path',
    'mcpkit install ./servers.json',
    '```',
    '',
    'Common flags:',
    '- `-n, --name <name>` — custom server name (otherwise derived from the spec). A name must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and not contain `..`.',
    '- `-a, --agent <agent>` — target agent(s); repeatable. `--exclude-agent <agent>` skips some; `--interactive` picks interactively. Defaults to your saved/detected agents.',
    '- `--scope <global|project>` — where skill files are written (default `global`).',
    '- `-e, --env KEY=VALUE` — env vars for stdio servers (repeatable).',
    '- `--header "Key: Value"` — HTTP headers for http/sse servers (repeatable).',
    '- `-d, --description <text>` — custom skill description used for agent routing.',
    '- `--env-hint "KEY=hint"` — hint shown if a referenced `${KEY}` is missing at call time (repeatable).',
    '- `--dry-run` — show what would be generated without writing files.',
    '',
    'Installing under a name that is already registered replaces the whole entry; a warning on stderr names the settings the new install does not carry over.',
    '',
    'Env and header values support `${VAR_NAME}` expansion, resolved from your shell environment at call time — keep secrets out of the registry and reference them by variable.',
    '',
    '### OAuth servers',
    '',
    '```bash',
    '# dynamic client registration',
    'mcpkit install https://mcp.postman.com/mcp --auth oauth -n postman',
    '# pre-registered client id',
    'mcpkit install https://mcp.slack.com/mcp --auth oauth --oauth-client-id <id> --oauth-callback-port 3118 -n slack',
    '```',
    '',
    'Then authenticate (opens a browser): `mcpkit auth <name>`. Inspect or reset: `mcpkit auth <name> --status` / `--reset`. Do this before any unattended run: `mcpkit call` on an OAuth server without stored tokens opens the browser and waits for the callback, while `mcpkit exec` never opens a browser.',
    '',
    '## Call tools',
    '',
    '```bash',
    'mcpkit call <server> <tool> \'<json_params>\'',
    'mcpkit call github list_repos \'{"owner":"octocat"}\'',
    '```',
    '',
    '- Output is plain text or JSON depending on the tool. Parse JSON with `jq`. Plain output is the text of the result: images, audio and resources are not printed, and one stderr line per kind, `[omitted: image/png 61969 bytes; use --json or mcpkit exec]`, says what was left out.',
    '- `--json` prints the result as exactly one JSON value (the structured content if the tool returns it, else the text parsed as JSON when it is valid JSON, else the text as a JSON string). A result with non-text parts (images, resource links) comes back as `{"content":[...]}` holding the raw parts. With `--chain` it is a JSON array with one value per call.',
    '- **Exit codes:** `0` on success. `1` when the server is unknown or unreachable, or the tool reports an error: the message goes to stderr and nothing is printed to stdout, so a script can rely on `$?`. `2` when the params (or the params of a `--chain` call) are not a JSON object; nothing is connected. A `--chain` stops at the first failed call.',
    '- A tool name that starts with a dash needs `--` in front of it, and options go before the `--`: `mcpkit call --json <server> -- <tool> \'{}\'`.',
    '- `call` has no timeout of its own, so a server that freezes blocks it. On an OAuth server without stored tokens it opens the browser and waits for the callback: run `mcpkit auth <name>` first, and use `mcpkit exec` for unattended runs.',
    '- **Chain** dependent calls in one MCP session with `--chain`, referencing the previous result via `$prev.field` (JSON output) or `$prev._text` (plain text):',
    '  ```bash',
    '  mcpkit call myserver login \'{}\' --chain \'search:{"query":"hi","token":"$prev.token"}\'',
    '  ```',
    '- **Keep a stdio session alive** after the call with `--keepalive` (blocks until Ctrl+C; stdio transports only).',
    '- With auto-refresh enabled (`mcpkit edit <server> --auto-refresh`), `call` first re-discovers the tools of a server whose skill is older than its TTL. This never opens a browser: if the server needs OAuth and has no stored tokens, the refresh is skipped and the call goes ahead.',
    '- A `servers.yaml` or `credentials.json` that cannot be parsed is reported as an error and left untouched, never treated as empty. An entry in `servers.yaml` that is not valid (a bad server name, for example) is skipped with a warning and stays in the file.',
    '',
    '## Persistent runtime mode (stdio servers)',
    '',
    'By default each `mcpkit call` connects, runs the tool, prints the result, and disconnects. For stdio servers that hold session state (browsers, databases, logins), run them as a **persistent background daemon** that stays alive between calls:',
    '',
    '```bash',
    '# enable at install time...',
    'mcpkit install "npx -y @browsermcp/mcp" -n browsermcp --runtime persistent --runtime-idle-timeout 900 --runtime-call-timeout 3600',
    '# ...or on an existing server',
    'mcpkit edit browsermcp --runtime persistent --runtime-idle-timeout 900 --runtime-call-timeout 3600',
    'mcpkit edit browsermcp --runtime ephemeral      # back to the default per-call mode',
    '```',
    '',
    '- The daemon **auto-starts on the first `mcpkit call`** — no manual startup needed.',
    '- Session state (browser windows, in-memory data, logins) persists across calls; no reconnect overhead.',
    '- `--runtime-idle-timeout <seconds>` — daemon shuts down after this much inactivity (default 15m).',
    '- `--runtime-call-timeout <seconds>` — maximum time for a single tool call (default 30m); it applies inside the daemon, so a call is cut off at this limit.',
    '- If the server process behind a daemon exits, the daemon notices, `runtime status` shows it as not running, and the next `mcpkit call` starts a fresh one.',
    '- `mcpkit exec` does not use these daemons: it opens its own sessions per run, so browser state opened by `mcpkit call` through a daemon is not visible to `exec`.',
    '',
    'Manage running daemons:',
    '',
    '```bash',
    'mcpkit runtime status [server]   # show running daemons (PID, mode, timeouts, socket, log)',
    'mcpkit runtime stop <server>     # stop a daemon and clear its runtime metadata',
    '```',
    '',
    '## Find tools without loading schemas',
    '',
    'Installing, syncing or updating a server saves its full tool schemas (input and output schemas, annotations) to `~/.mcpkit/schemas/<server>.json`; `mcpkit remove` deletes the file. `mcpkit list <server>` refreshes it too. These commands read that cache, so they work offline. If a server has no cache they connect once and fill it (`search` only does this with `--server`; without it, servers lacking a cache are skipped and named on stderr).',
    '',
    '```bash',
    'mcpkit search create issue [--server github] [--limit 15] [--json]   # ranked "server.tool - summary" lines',
    'mcpkit describe github create_issue [--json]   # description, parameter JSON Schema, output schema, annotations, a ready `mcpkit call` example',
    'mcpkit types github [--tools create_issue,list_repos] [--out api.d.ts]   # TypeScript declarations: declare const mcp: { "github": { create_issue(args): Promise<...> } }',
    '```',
    '',
    '- Identical tools on several servers (for example two registrations of one server, which can be different accounts) are listed once by `search`: `TOOL on server-a, server-b - summary`, then a line `same tool on N servers: server-a = <start of its description>; ...`. Choose the server from that description, never by position. `--json` adds `alsoIn` and a `servers` array (`{server, description?}`); `--no-collapse` lists every copy.',
    '- Servers with more than 15 tools get a compact `SKILL.md` (one line per tool). Use `mcpkit describe <server> <tool>` for the schema of a tool before calling it.',
    '- `describe` prints annotations as "server-declared, untrusted": they are claims made by the server, not guarantees.',
    '- `describe` on an unknown tool exits 1 and lists the nearest names.',
    '- To list every registered server in an agent\'s context at session start without per-server skills, run `mcpkit hook install` (a preview; add `--write` to apply it), after which the agent runs `mcpkit hook session-start`, which prints a short offline directory of the servers; `mcpkit hook session-start --format text` prints the same text to paste into CLAUDE.md or AGENTS.md.',
    '',
    SCRIPTING_BLOCK,
    '',
    '## Run a script with `mcpkit exec`',
    '',
    '```bash',
    'mcpkit exec --allow-read-only script.js          # or: mcpkit exec -c \'<js>\'   or: ... | mcpkit exec -',
    'mcpkit exec --allow github.create_issue,github.add_label script.js',
    '```',
    '',
    '- The script is the body of an async function: `await` and `return` work, and TypeScript annotations are stripped. It sees `mcp`: `mcp["server"].tool(args)` (or `mcp.server.tool(args)`) calls a registered MCP tool and resolves to its result (structured content, else the text, parsed as JSON when it is JSON). A failed tool call throws. `console.log/info/warn/error` are captured.',
    '- It runs in a sandbox with no file, network, process or timer access, and no credentials: mcpkit makes the calls for it, and only the tools you allow. Results with non-text parts (images, resource links) reach the script as the raw `{content:[...]}` parts.',
    '- Sessions are per run and are not shared with persistent runtime daemons, so every `exec` pays a cold start of about 1 s per server, even for a server in persistent mode.',
    '- **Writes are denied by default.** A call runs only if it matches `--allow <patterns>` (`server.tool`, `server.*`, `*.tool` or `*`; comma-separated and/or repeated), or `--allow-writes` is set (everything), or `--allow-read-only` is set and the server marks that tool `readOnlyHint: true`. `--allow-read-only` trusts what the server declares; a tool with no hint is not treated as read-only. A blocked call throws inside the script and prints a one-line warning on stderr, and the output lists it under `blocked` even if the script caught the error; then `ok` can still be `true`, so check `blocked`. `--allow-read-only` reads the hint live from the server, not from the schema cache.',
    '- `--allow` patterns are resolved against the registered server names. Names may contain dots, so a pattern that could mean two different server/tool pairs (server `a.b` with tool `c`, or server `a` with tool `b.c`) is rejected with exit `2` and the readings listed; a pattern that matches no registered server prints a warning.',
    '- Parameters from a configured param provider are merged into every call (as in `mcpkit call`), so a tool that echoes its arguments returns them to the script. Calls the script started but did not await are waited for: they count in `calls`, and one that fails or is blocked makes the run fail.',
    '- Limits: `--timeout <ms>` (default 120000, whole run), `--max-calls <n>` (default 200), `--max-output <bytes>` (default 102400, applied to the result and to the logs separately), `--memory-mb <n>` (default 256).',
    '- `--timeout` is wall-clock and authoritative: the run ends as kind `timeout` whatever the script catches, and the child processes are killed promptly.',
    '- Logs over `--max-output` are cut: `truncated` is `true` and the logs end with a marker line. A result over `--max-output` comes back as a truncated string, also with `truncated: true`.',
    '- stdout is ONE line of JSON: `{"ok":true,"result":...,"logs":[...],"calls":N,"blocked":[...],"truncated":false}` or `{"ok":false,"error":{"kind":"script|tool|blocked|timeout|limit|interrupted|internal","message":"...","tool":"server.tool"},"logs":[...],"calls":N,"blocked":[...]}`.',
    '- **Exit codes:** `0` only when `ok` is true; `1` when the script ran and failed (any error kind); `2` for usage errors (nothing is printed on stdout).',
    '',
    '## Auto-injected parameters (param provider)',
    '',
    'Attach a command whose JSON stdout is merged into every tool call\'s params (e.g. minting an auth token) — the agent never passes those params manually:',
    '',
    '```bash',
    'mcpkit install <spec> --param-provider "eiamcli iamticket"',
    'mcpkit edit <server> --param-provider "<command>"   # or --remove-param-provider',
    '```',
    '',
    '## Manage installed servers',
    '',
    '```bash',
    'mcpkit list                            # list all registered servers',
    'mcpkit list <server>                   # list tools on one server',
    'mcpkit view <server> [--yaml]          # full config: transport, runtime, param provider, timeouts, agents',
    'mcpkit update [server]                 # re-discover tools; regenerate skill files and the schema cache',
    'mcpkit sync [server] [--force]         # regenerate missing skill files from saved agent prefs',
    'mcpkit remove <server> [-a <agent>]    # remove a server (or just one agent\'s skill files)',
    '```',
    '',
    'Edit config with `mcpkit edit <server> ...`:',
    '- `--env KEY=VALUE` / `--remove-env KEY` (stdio)',
    '- `--header "Key: Value"` / `--remove-header KEY` (http/sse)',
    '- `--auth oauth|none`, `--oauth-client-id <id>`, `--oauth-callback-port <port>`',
    '- `--runtime <mode>`, `--runtime-idle-timeout <s>`, `--runtime-call-timeout <s>` (plus `--remove-runtime-idle-timeout` / `--remove-runtime-call-timeout`)',
    '- `--param-provider <command>` / `--remove-param-provider`',
    '- `--env-hint KEY=hint` / `--remove-env-hint KEY`',
    '- `--description <text>`, `--name <new-name>` (rename)',
    '- `--add-agent <agent>` / `--remove-agent <agent>` / `--use-defaults`',
    '',
    'After `edit` changes a server\'s command or URL, run `mcpkit update <server>` so the schema cache and the skill files match the new server.',
    '',
    '`update` tries every server: one that cannot be reached keeps its skill files, schema cache and registry entry, and the exit code is 1 if any failed.',
    '',
    '## Agents & scope',
    '',
    'mcpkit writes a `SKILL.md` per server into each target agent\'s skills directory. Supported agents: `claude-code`, `cursor`, `codex`, `windsurf`, `augment`, `openclaw`, `hermes`. Agents are auto-detected by their home directory (e.g. `~/.claude`, `~/.hermes`).',
    '',
    '```bash',
    'mcpkit agents               # show Supported / Detected / Defaults',
    'mcpkit agents --configure   # interactively set the default target agents',
    '```',
    '',
    '`--scope global` writes to the agent\'s home directory (e.g. `~/.claude/skills/`); `--scope project` writes into the current repository.',
    '',
    'With `mcpkit config skills guide` an agent gets only this guide and no per-server skills: it learns which servers exist from the session-start directory above or `mcpkit list`, and finds tools with `mcpkit search`.',
    '',
  ];

  const text = lines.join('\n');
  const marker = guideMarker(options.pkgVersion ?? defaultPkgVersion(), directory);
  // The directory, when there is one, goes after the guide proper; the marker is always the last line.
  return directory === undefined ? `${text}${marker}\n` : `${text}\n${directory.bodySection}\n\n${marker}\n`;
}

export interface WriteMetaSkillOptions {
  agents: AgentType[];
  scope: Scope;
  dryRun?: boolean;
  logPrefix?: string;
  /** Print nothing; the paths written are the result. */
  quiet?: boolean;
  /**
   * The settings that decide each agent's skills mode, for a caller that is about to save a mode and
   * writes the guide first (the default is the settings file as it is on disk).
   */
  settings?: LoadedSettings;
  /** The version written into the guide's marker (default: this mcpkit's). */
  pkgVersion?: string;
  /** Where the directory of an agent comes from (default: the registry and the schema caches, read for each agent); a caller that writes several guides reads them once and passes that. */
  directory?: DirectorySource;
}

async function guidePathOf(agent: AgentType, scope: Scope): Promise<string> {
  const generate = await getGenerator(agent);
  return generate({
    serverName: META_SKILL_SERVER_NAME,
    tools: [],
    transport: { type: 'stdio', command: 'mcpkit', args: [] },
    scope,
  }).filePath;
}

/**
 * The agents whose guide (in `scope`) is the same file as the guide of `agent` once symlinks are
 * resolved, `agent` among them: a skills directory linked to another agent's (`~/.codex/skills ->
 * ~/.claude/skills`) makes their two guides one file.
 */
async function guideReaders(agent: AgentType, scope: Scope): Promise<AgentType[]> {
  const own = await realPathOf(await guidePathOf(agent, scope));
  const readers: AgentType[] = [];
  for (const other of ALL_AGENTS) {
    if (other === agent || await realPathOf(await guidePathOf(other, scope)) === own) readers.push(other);
  }
  return readers;
}

interface GuidePlan {
  path: string;
  content: string;
  /** The marker `content` ends with. */
  marker: string;
  /** The agent is in guide mode but the registry cannot be read, so `content` has no directory and says nothing about the servers. */
  registryUnreadable: boolean;
}

/**
 * What the guide of `agent` is to say: the one place that decides it, for writing the guide and for
 * telling whether the one on disk is current. An agent in guide mode gets the directory of its
 * servers in the guide itself; so does nothing else: an agent with per-server skills, a project
 * scope guide (the user's server list is not for a repository) and an empty registry get the
 * generic guide. A guide file that other agents read too (a shared skills directory) lists the
 * servers of every one of them in guide mode, whichever of them it is written for.
 */
async function planGuide(agent: AgentType, scope: Scope, settings: LoadedSettings, pkgVersion: string, source: DirectorySource = loadDirectoryServersChecked): Promise<GuidePlan> {
  let directory: GuideDirectory | undefined;
  let registryUnreadable = false;
  if (scope === 'global') {
    // The union of the servers of the agents that read this file: written for one of them alone, it would drop the servers of the others.
    const servers = new Map<string, DirectoryServer>();
    for (const reader of await guideReaders(agent, scope)) {
      if (resolveSkillModeSource(settings, reader).mode !== 'guide') continue;
      const listed = await source(reader);
      if (!listed.ok) registryUnreadable = true;
      for (const server of listed.servers) if (!servers.has(server.name)) servers.set(server.name, server);
    }
    if (!registryUnreadable && servers.size > 0) directory = buildGuideDirectory([...servers.values()]);
  }
  const content = buildMetaSkillContent({ directory, pkgVersion });
  return { path: await guidePathOf(agent, scope), content, marker: readGuideMarker(content) ?? '', registryUnreadable };
}

export interface GuideCheckOptions {
  /** Settings to resolve the mode from (default: the settings file). */
  settings?: LoadedSettings;
  /** The version to expect in the marker (default: this mcpkit's). */
  pkgVersion?: string;
  /** Where the directory of an agent comes from (default: the registry and the schema caches, read for each call). */
  directory?: DirectorySource;
}

/**
 * The marker line the global guide of `agent` would end with if it were written now, or null when that
 * cannot be told because the registry cannot be read. Reads the settings, the registry and the schema
 * caches only: nothing is started, contacted or written.
 */
export async function expectedGuideMarker(agent: AgentType, options: GuideCheckOptions = {}): Promise<string | null> {
  const plan = await planGuide(agent, 'global', options.settings ?? await loadSettings(), options.pkgVersion ?? defaultPkgVersion(), options.directory);
  return plan.registryUnreadable ? null : plan.marker;
}

/** Whether the global guide of `agent` exists and ends with the marker a fresh write would produce. */
export async function guideIsCurrent(agent: AgentType, options: GuideCheckOptions = {}): Promise<boolean> {
  const plan = await planGuide(agent, 'global', options.settings ?? await loadSettings(), options.pkgVersion ?? defaultPkgVersion(), options.directory);
  if (plan.registryUnreadable) return false;
  try {
    return readGuideMarker(await readFile(plan.path, 'utf-8')) === plan.marker;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the `mcpkit-cli` meta-skill once per command run, to each target agent, and return the paths
 * written. Call this from install/sync/update after the per-server skills are written, so the
 * directory in the guide of an agent in guide mode lists the server that was just added. A guide that
 * several of the agents read (a shared skills directory) is written once, for the first of them.
 *
 * A guide for an agent in guide mode carries the live directory of its servers. When the registry
 * exists but cannot be read, an existing guide is left as it is (rewriting it would replace its
 * directory with an empty one) and a missing one is written without a directory.
 */
export async function writeMetaSkill(options: WriteMetaSkillOptions): Promise<string[]> {
  const { agents, scope, dryRun = false, logPrefix = '', quiet = false } = options;
  const written: string[] = [];
  if (agents.length === 0) return written;

  const say = (text: string): void => {
    if (!quiet) console.log(text);
  };
  const settings = options.settings ?? await loadSettings();
  const pkgVersion = options.pkgVersion ?? defaultPkgVersion();
  const seen = new Set<AgentType>();
  // The real path of each guide written so far: an agent whose guide is the same file (a shared skills directory) has it already.
  const writtenTo = new Map<string, AgentType>();

  for (const agent of agents) {
    if (seen.has(agent)) continue;
    seen.add(agent);

    if (dryRun) {
      say(chalk.yellow(`${logPrefix}[dry-run] mcpkit-cli guide (${agent}): ${await guidePathOf(agent, scope)}`));
      continue;
    }

    const path = await guidePathOf(agent, scope);
    const real = await realPathOf(path);
    const first = writtenTo.get(real);
    if (first !== undefined) {
      say(chalk.green(`${logPrefix}✓ mcpkit-cli guide (${agent}): ${path} (the same file as the ${first} guide)`));
      continue;
    }

    const plan = await planGuide(agent, scope, settings, pkgVersion, options.directory);
    if (plan.registryUnreadable && await exists(plan.path)) {
      say(chalk.dim(`${logPrefix}mcpkit-cli guide (${agent}): left as it is, the registry cannot be read: ${plan.path}`));
      continue;
    }
    await writeSkillFile(plan.path, plan.content);
    written.push(plan.path);
    writtenTo.set(real, agent);
    say(chalk.green(`${logPrefix}✓ mcpkit-cli guide (${agent}): ${plan.path}`));
  }
  return written;
}
