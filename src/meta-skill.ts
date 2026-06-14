import chalk from 'chalk';
import { getGenerator } from './generators/index.js';
import { writeSkillFile } from './skill-file.js';
import type { AgentType, Scope } from './types.js';

// The meta-skill is written to <agent>/skills/mcpkit-cli/SKILL.md. We reuse the
// per-agent generators to resolve that path (they build `mcpkit-${serverName}`),
// so passing serverName 'cli' yields the `mcpkit-cli` skill directory for free
// and stays correct as agents are added or their paths change.
const META_SKILL_SERVER_NAME = 'cli';

const META_DESCRIPTION =
  'Use this to operate the mcpkit CLI itself — add/install new MCP servers as agent skills, '
  + 'call MCP tools from Bash, run servers as persistent background daemons, and manage '
  + '(list, view, edit, sync, update, remove, auth) registered servers. Use whenever the user '
  + 'wants to add a new MCP server, wire up an MCP tool, or manage existing mcpkit servers.';

/**
 * Build the `mcpkit-cli` meta-skill — a hand-authored SKILL.md that teaches an
 * agent how to drive the mcpkit CLI itself. Identical across every target agent
 * (only the output path differs), so it mirrors `buildSkillContent`'s shape.
 *
 * Lines are single-quoted JS strings on purpose: backticks pass through as
 * literal markdown, and `${VAR}` placeholders are NOT interpolated.
 */
export function buildMetaSkillContent(): string {
  const lines: string[] = [
    '---',
    'name: mcpkit-cli',
    `description: "${META_DESCRIPTION}"`,
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
    '- `-n, --name <name>` — custom server name (otherwise derived from the spec).',
    '- `-a, --agent <agent>` — target agent(s); repeatable. `--exclude-agent <agent>` skips some; `--interactive` picks interactively. Defaults to your saved/detected agents.',
    '- `--scope <global|project>` — where skill files are written (default `global`).',
    '- `-e, --env KEY=VALUE` — env vars for stdio servers (repeatable).',
    '- `--header "Key: Value"` — HTTP headers for http/sse servers (repeatable).',
    '- `-d, --description <text>` — custom skill description used for agent routing.',
    '- `--env-hint "KEY=hint"` — hint shown if a referenced `${KEY}` is missing at call time (repeatable).',
    '- `--dry-run` — show what would be generated without writing files.',
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
    'Then authenticate (opens a browser): `mcpkit auth <name>`. Inspect or reset: `mcpkit auth <name> --status` / `--reset`.',
    '',
    '## Call tools',
    '',
    '```bash',
    'mcpkit call <server> <tool> \'<json_params>\'',
    'mcpkit call github list_repos \'{"owner":"octocat"}\'',
    '```',
    '',
    '- Output is plain text or JSON depending on the tool. Parse JSON with `jq`.',
    '- **Chain** dependent calls in one MCP session with `--chain`, referencing the previous result via `$prev.field` (JSON output) or `$prev._text` (plain text):',
    '  ```bash',
    '  mcpkit call myserver login \'{}\' --chain \'search:{"query":"hi","token":"$prev.token"}\'',
    '  ```',
    '- **Keep a stdio session alive** after the call with `--keepalive` (blocks until Ctrl+C; stdio transports only).',
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
    '- `--runtime-call-timeout <seconds>` — maximum time for a single tool call (default 30m).',
    '',
    'Manage running daemons:',
    '',
    '```bash',
    'mcpkit runtime status [server]   # show running daemons (PID, mode, timeouts, socket, log)',
    'mcpkit runtime stop <server>     # stop a daemon and clear its runtime metadata',
    '```',
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
    'mcpkit update [server]                 # re-discover tools and regenerate skill files',
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
  ];

  return lines.join('\n');
}

export interface WriteMetaSkillOptions {
  agents: AgentType[];
  scope: Scope;
  dryRun?: boolean;
  logPrefix?: string;
}

/**
 * Write the `mcpkit-cli` meta-skill once per command run, to each target agent.
 * Call this from install/sync/update after the per-server skills are written.
 */
export async function writeMetaSkill(options: WriteMetaSkillOptions): Promise<void> {
  const { agents, scope, dryRun = false, logPrefix = '' } = options;
  if (agents.length === 0) return;

  const content = buildMetaSkillContent();
  const seen = new Set<AgentType>();

  for (const agent of agents) {
    if (seen.has(agent)) continue;
    seen.add(agent);

    const generate = await getGenerator(agent);
    const skill = generate({
      serverName: META_SKILL_SERVER_NAME,
      tools: [],
      transport: { type: 'stdio', command: 'mcpkit', args: [] },
      scope,
    });

    if (dryRun) {
      console.log(chalk.yellow(`${logPrefix}[dry-run] mcpkit-cli guide (${agent}): ${skill.filePath}`));
    } else {
      await writeSkillFile(skill.filePath, content);
      console.log(chalk.green(`${logPrefix}✓ mcpkit-cli guide (${agent}): ${skill.filePath}`));
    }
  }
}
