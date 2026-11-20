# mcpkit

MCP client that turns any MCP server into CLI commands + lightweight agent skills — zero context bloat.

**Supported agents:** Claude Code, Cursor, Windsurf, Augment Code, OpenAI Codex CLI, OpenClaw

## Why

AI coding agents load full MCP tool schemas into context every turn, wasting tokens. mcpkit solves this — it connects to any MCP server, generates on-demand skill files, and gives agents a simple `mcpkit call` CLI to invoke tools. Agents only read the skill when relevant, and call tools through the CLI instead of holding schemas in memory.

## Install

```bash
npm install -g @balakumar.dev/mcpkit
```

Requires Node.js >= 20.

## Quick Start

```bash
# Install from a command string
mcpkit install "npx -y @modelcontextprotocol/server-filesystem /tmp" --name filesystem

# Install from standard JSON format
mcpkit install '{"mcpServers":{"github":{"command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":"..."}}}}'

# Install from a .json file
mcpkit install ./my-servers.json

# Install for specific agents
mcpkit install "npx -y @modelcontextprotocol/server-filesystem /tmp" --name filesystem --agent claude-code --agent cursor

# Install at project level instead of global
mcpkit install "npx -y @modelcontextprotocol/server-filesystem /tmp" --name filesystem --scope project
```

## Commands

### `mcpkit install <server-spec>`

Install MCP server tools as agent skill files.

```
Arguments:
  server-spec          Command string, URL, JSON string, or .json file path

Options:
  -n, --name <name>    Custom server name (must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} and not contain "..")
  -a, --agent <agent>  Target agent (repeatable: --agent claude-code --agent cursor)
  --scope <scope>      global or project (default: global)
  -e, --env <env>      Environment variables for stdio (repeatable: -e KEY=VALUE)
  -d, --description    Custom skill description (overrides auto-generated)
  --header <header>    HTTP headers (repeatable: --header "Key: Value")
  --auth <type>        Authentication type (oauth)
  --dry-run            Preview generated files without writing
```

Installing under a name that is already registered replaces the whole entry; a warning on stderr names the settings (env, headers, runtime, OAuth, ...) the new install does not carry over.

**Input formats:**

| Format | Example |
|--------|---------|
| Command string | `"npx -y @modelcontextprotocol/server-filesystem /tmp"` |
| HTTP URL | `"https://mcp.example.com/api"` |
| SSE URL | `"https://mcp.example.com/sse"` |
| Inline JSON | `'{"mcpServers":{"name":{...}}}'` |
| JSON file | `./servers.json` |

The JSON format supports the standard `mcpServers` structure used by Claude Desktop, Cursor, etc:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

### `mcpkit call <server> <tool> [params]`

Call a tool on a registered server. This is what the generated skill files teach agents to run. For OAuth servers, tokens are used automatically.

By default, `mcpkit call` connects to the server, runs the tool once, prints the result, and disconnects.

- Use `--chain` to run multiple tool calls sequentially in the same MCP session. This is useful when a later tool call depends on data returned by the previous one.
- For `stdio` servers configured with `runtime.mode: persistent`, normal `mcpkit call` automatically starts or reuses a background runtime and returns the tool result immediately. This keeps the agent-facing command shape the same while reusing one long-lived MCP session behind the scenes.
- Use `--keepalive` for a manual blocking session that keeps a stdio server process alive until `Ctrl+C`. This is mainly useful for debugging or one-off manual workflows; it is separate from the automatic background runtime path.

```bash
mcpkit call filesystem read_file '{"path":"/tmp/example.txt"}'
mcpkit call github search_repositories '{"query":"mcpkit"}'
mcpkit call postman list_collections '{}'   # OAuth tokens applied automatically

# Reuse one session for multiple tool calls
mcpkit call myserver login '{}' --chain 'search:{"query":"hello","token":"$prev.token"}'

# Auto-start and reuse a background stdio runtime for future calls
mcpkit install "npx -y @browsermcp/mcp" -n browsermcp --runtime persistent --runtime-idle-timeout 900
mcpkit call browsermcp create_session '{}'
mcpkit call browsermcp browser_snapshot '{}'

# Keep a stdio server process alive after the initial call in the foreground
mcpkit call browsermcp create_session '{}' --keepalive
```

When using `--chain`, values from the previous JSON result can be referenced with `$prev.field`. If the previous result is plain text instead of JSON, it is available as `$prev._text`.

For scripts, `--json` prints the result as exactly one JSON value: the structured content when the tool returns it, else the text parsed as JSON when it is valid JSON, else the text as a JSON string (with `--chain`, an array with one value per call). A result with non-text parts (images, resource links) comes back as `{"content":[...]}` holding the raw parts.

```bash
mcpkit call github list_repos '{"owner":"octocat"}' --json | jq '.[].name'
```

Plain output is the text of the result. Images, audio and resources are not printed: one stderr line per kind, such as `[omitted: image/png 61969 bytes; use --json or mcpkit exec]`, says what was left out.

**Exit codes:** `0` on success. `1` when the server is unknown or unreachable, or the tool reports an error. The message goes to stderr and nothing is printed to stdout. `2` when the params (or the params of a `--chain` call) are not a JSON object; nothing is connected. A `--chain` stops at the first failed call.

A tool name that starts with a dash needs `--` in front of it, and options go before the `--`: `mcpkit call --json github -- --tool '{}'`.

`mcpkit call` has no timeout of its own, so a server that freezes blocks it. On an OAuth server without stored tokens it opens the browser and waits for the callback: run `mcpkit auth <name>` first, and use `mcpkit exec`, which never opens a browser, for unattended runs.

With auto-refresh enabled (`mcpkit edit <name> --auto-refresh`), `mcpkit call` first re-discovers the tools of a server whose skill is older than its TTL. This never opens a browser: if the server needs OAuth and has no stored tokens, the refresh is skipped and the call goes ahead.

### `mcpkit search`, `describe` and `types`

Installing, syncing or updating a server also saves its full tool schemas (input and output schemas, annotations) to `~/.mcpkit/schemas/<server>.json`; `mcpkit remove` deletes the file. These commands read that cache, so they work offline, and connect once to fill it when a server has none.

```bash
mcpkit search create issue                    # ranked "server.tool - summary" lines across servers
mcpkit search pull request --server github --limit 5 --json
mcpkit describe github create_issue           # description, parameter schema, output schema, annotations, a ready call example
mcpkit types github --tools create_issue      # TypeScript declarations (--out api.d.ts to write a file)
```

Servers that expose the identical tool (for example two registrations of one server, which can be different accounts) are collapsed into one hit that names every server equally (`TOOL on server-a, server-b - summary`, then `same tool on N servers: server-a = <start of its registry description>; ...`): choose the server from its description, never by position. `--json` adds `alsoIn` and a `servers` array (`{server, description?}`), and `--no-collapse` shows every copy.

Annotations such as `readOnlyHint` are shown as "server-declared, untrusted": they are claims made by the server. Servers with more than 15 tools get a compact `SKILL.md` with one line per tool; use `mcpkit describe` for the schema of a tool.

### `mcpkit exec [file]`

Run a script that makes several tool calls in one go. The script is the body of an async function (`await` and `return` work, TypeScript annotations are stripped) and sees `mcp["server"].tool(args)`, which resolves to the tool's result and throws when the tool fails. It runs in a sandbox with no file, network, process or timer access and no credentials; mcpkit makes the calls for it. Results with non-text parts (images, resource links) reach the script as the raw `{content:[...]}` parts.

Sessions are per run and are not shared with persistent runtime daemons, so every `exec` pays a cold start of about 1 s per server, even for a server in persistent mode, and browser state opened by `mcpkit call` through a daemon is not visible to `exec`.

```bash
mcpkit exec --allow-read-only script.js
mcpkit exec --allow github.create_issue,github.add_label script.js
mcpkit exec --allow-read-only -c 'return await mcp.docs.search({ query: "mcp" })'
```

Writes are denied by default. A call runs only if it matches `--allow <patterns>` (`server.tool`, `server.*`, `*.tool`, `*`; comma-separated or repeated), or `--allow-writes` is set (everything), or `--allow-read-only` is set and the server marks that tool `readOnlyHint: true`. `--allow-read-only` trusts what the server declares. A blocked call throws in the script, prints a one-line warning on stderr and is listed under `blocked` in the output, even if the script caught the error; the run can then still finish with `ok: true`, so check `blocked`. `--allow-read-only` reads the hint live from the server, not from the schema cache.

`--allow` patterns are resolved against the registered server names. Names may contain dots, so a pattern that could mean two different server/tool pairs (server `a.b` with tool `c`, or server `a` with tool `b.c`) is rejected with exit code 2 and the readings listed, and a pattern that matches no registered server prints a warning.

Parameters from a configured param provider are merged into every call, as they are for `mcpkit call`, so a tool that echoes its arguments returns them to the script. Calls the script started but did not await are waited for: they count in `calls`, and one that fails or is blocked makes the run fail.

Limits: `--timeout <ms>` (default 120000), `--max-calls <n>` (200), `--max-output <bytes>` (102400), `--memory-mb <n>` (256). `--timeout` is wall-clock and authoritative: the run ends as kind `timeout` whatever the script catches, and the child processes are killed promptly. Logs over `--max-output` are cut: `truncated` is `true` and the logs end with a marker line. A result over `--max-output` comes back as a truncated string, also with `truncated: true`.

stdout is one line of JSON, `{"ok":true,"result":...,"logs":[...],"calls":N,"blocked":[...],"truncated":false}` or `{"ok":false,"error":{"kind":"script|tool|blocked|timeout|limit|interrupted|internal","message":"..."},...}`. A `"warnings":[...]` array is added only when something the script did could not be honoured, for example a call made after the script returned (it is not run). Every call the write gate blocks is also named on stderr, even when the script caught the error; then `ok` can be `true`, so check `blocked`. Exit codes: `0` ok, `1` the script failed, `2` usage error.

### SessionStart hook (no per-server skills needed)

`mcpkit hook session-start` prints a short, always-current directory of the registered servers, so an agent knows from the first message which MCP servers it can reach through `mcpkit` without a `SKILL.md` per server. It reads only `servers.yaml` and the schema caches: it never contacts a server, starts a process or writes a file, so it adds little to the CLI's own start-up (about 0.14 s in all for 13 servers of 60 tools each, measured).

```bash
mcpkit hook install                  # preview: the entry it would add and a diff; writes nothing
mcpkit hook install --write          # backs up ~/.claude/settings.json, then merges the hook in
mcpkit hook uninstall --write        # removes only the entry it added
mcpkit hook session-start --format text   # the same text, raw: paste it into CLAUDE.md / AGENTS.md
```

`install --write` copies the original settings to `<settings>.mcpkit-bak-<yyyymmddhhmmss>` (owner-only), then writes atomically, keeping every other key, every other hook and the key order; a missing file and its folders are created. It adds `{"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"mcpkit hook session-start 2>/dev/null || true"}]}` under `hooks.SessionStart`. The `2>/dev/null || true` means the hook can never show an error: an `mcpkit` that is not on the `PATH` of the shell the agent starts hooks with, or an older one that has no `hook` command, simply adds no context. Installing twice changes nothing; an entry written earlier (any hook command that starts with `mcpkit hook session-start`) is updated in place to the current command, not duplicated, and `uninstall` removes every such entry. It refuses (exit 1, nothing written) a file that is not valid JSON or whose `hooks` or `hooks.SessionStart` has an unexpected type. `--settings <path>` edits another file (for example a project's `.claude/settings.json`); `--matcher <regex>` changes the sources (the default leaves out `fork`). Only Claude Code is supported by `install`; for Codex, Cursor, Windsurf and Augment, `--agent <name> --format text` prints the text to inject where that agent allows startup context.

What a session sees (about 3000 characters at most; `--max-chars` changes that, with a floor of 600):

```
mcpkit: 4 MCP servers are available through the mcpkit CLI (run it with Bash). Use it for anything these servers cover; otherwise do not.

- github (2 tools, 1 read-only): GitHub issues and pull requests
- personal (3 tools, 2 read-only): Composio MCP (PERSONAL account)
- work (3 tools, 2 read-only): Composio MCP (WORK account)
Same tool set on personal, work: pick by the account in the descriptions above.

Find tools: mcpkit search <words> [--server <name>]. Schema: mcpkit describe <server> <tool>.
...three more lines: exec, call, the write gate and checking an output shape first
```

Servers that list `agents` serve only those agents; a server with none serves every agent. A server with no registry description shows its first six tool names. A server without a usable schema cache (none yet, or unreadable, empty, corrupt or of another version) is still listed from the registry alone, as `- <name>: <description> (not cached; run mcpkit update <name>)`. When the list does not fit, descriptions are cut to 80 characters, then the tool counts are dropped, then the alphabetically last servers fold into one `+n more` line; the header, the workflow and servers that share a tool set are never dropped, so a very small budget can still be exceeded. Everything that comes from the registry or a cache is untrusted text that goes into every session, so control characters, ANSI escapes, line breaks, angle brackets, backticks and runs of dashes are neutralised first, and no transport, command, URL, header or environment value is ever printed.

Fail-silent contract: on an unreadable or corrupt registry, on any internal error (an unwritable stdout included), when no server serves the agent, and when `MCPKIT_HOOK_DISABLE=1` is set, it prints nothing and exits 0, and an empty stdout adds no context to the session. One server's bad schema cache is not such an error: that server stays in the list as "not cached" and the others are unaffected. Only a bad flag exits 2. The JSON the agent pipes to a hook is read only when stdin is not a terminal, for at most 200 ms, and ignored: the same text is printed for `startup`, `resume`, `clear` and `compact`.

Hook context may not reach subagents. Keep a one-line pointer in the agent's `CLAUDE.md` as a fallback, for example: "MCP tools are reached with `mcpkit search <words>`, `mcpkit describe <server> <tool>` and `mcpkit exec`."

### Skill modes (per-server skills or one guide)

By default mcpkit writes one skill per registered server for each agent. With many servers that is many routing descriptions in every session. A setting turns the per-server skills off for the agents you choose and keeps only the generic `mcpkit-cli` guide for them; the agent then learns which servers exist from the [SessionStart hook](#sessionstart-hook-no-per-server-skills-needed) (or a pointer line in `CLAUDE.md` / `AGENTS.md`) and finds tools with `mcpkit search` and `mcpkit describe`.

```bash
mcpkit config                                              # the mode of every agent, where it comes from, and the settings path
mcpkit config skills                                       # the same, for skills only
mcpkit config skills guide --agent claude-code --dry-run   # preview: what is created, backed up and removed; writes nothing
mcpkit config skills guide --agent claude-code             # only the guide for Claude Code
mcpkit config skills per-server --agent claude-code        # rollback: one skill per server again
mcpkit config skills guide                                 # the default for every agent in use (no --agent)
```

- **Modes.** `per-server` (the default) and `guide`. The mode of an agent is, in order: `MCPKIT_SKILLS=guide|per-server` (applies to every agent and beats the file), the agent's own entry, the default entry, then `per-server`. With nothing set, mcpkit behaves exactly as before.
- **Where it is stored.** `~/.mcpkit/config.yaml` (`version: 1`, `skills: {default, agents: {<agent>: <mode>}}`, written atomically, owner-only). It is a file of its own on purpose: `servers.yaml` and `settings.yaml` (the default agents) are rewritten by an mcpkit that does not know the setting. A missing, unreadable or invalid file means the defaults, and `mcpkit config` says what is wrong with it.
- **Switching an agent to `guide`** writes the `mcpkit-cli` guide first, then copies every per-server skill mcpkit generated for that agent to `~/.mcpkit/skill-backups/<yyyymmddhhmmss>/<agent>/<skill dir>/` (owner-only, printed when done), then saves the setting, then removes them. A failed backup changes nothing but the guide, and running the command again finishes an interrupted switch. Only a skill that mcpkit generated is removed: its frontmatter names its own directory and its body carries mcpkit's "NOT native MCP tools" header. The `mcpkit-cli` guide, a skill you wrote yourself under a name like `mcpkit-notes`, a directory with other files in it and a symlink are left alone, and so are the skills of every other agent. `--dry-run` prints exactly this and writes nothing, not even the setting.
- **Switching back to `per-server`** saves the setting, then regenerates that agent's skills like `mcpkit sync --force` does (this connects to each server). To restore one skill from a backup, copy its directory back. Without `--agent`, the command applies to the agents your registered servers use whose mode actually changes, and leaves an agent that has its own entry alone.
- **What follows the mode.** `install`, `sync`, `update` and auto-refresh write no per-server skill for an agent in `guide` mode (they still discover tools, refresh the schema cache and keep the registry, and the guide is written or refreshed); `remove` still removes whatever exists. `--scope project` installs are explicit, so their skill is always written: the mode governs global skills only.
- **Prerequisite.** The guide alone does not name your servers. For Claude Code run `mcpkit hook install --write`, or add a pointer line to `CLAUDE.md` (the warning looks for the hook in `~/.claude/settings.json` only, so a hook kept in `settings.local.json` or in a project file still gets it). Codex, Cursor, Windsurf, Augment, OpenClaw and Hermes have no session hook mcpkit can install, so they get only the guide unless you paste `mcpkit hook session-start --agent <agent> --format text` into their instructions file. Switching an agent to `guide` warns about this (exit code 0) when it applies.
- **Older mcpkit.** A build that does not know the setting ignores it and regenerates the per-server skills on its next `sync` or `update`. That is harmless; run `mcpkit config skills guide --agent <agent>` again to back them up and remove them.

### `mcpkit runtime <subcommand>`

Inspect or stop persistent stdio runtimes managed by `mcpkit`.

```bash
mcpkit runtime status
mcpkit runtime status browsermcp
mcpkit runtime stop browsermcp
```

### `mcpkit list [server]`

List registered servers or tools on a specific server.

```bash
mcpkit list                # Show all registered servers
mcpkit list filesystem     # Show tools on filesystem server
mcpkit list --json         # Machine-readable (secrets masked)
```

`mcpkit list <server>` also refreshes that server's schema cache with the tools it fetches.

Secrets are masked in everything `list` prints: env values, header values, inline `--header` / `--api-key` arguments, URL credentials and long token-like arguments show as `<redacted len=N>`. The stored registry is unchanged.

### `mcpkit view <name>`

Show full config for a registered server — transport, env vars, headers, auth, and metadata. Secrets are masked by default, in text, `--yaml` and `--json` output alike.

```bash
mcpkit view postman            # Formatted output, secrets masked
mcpkit view postman --yaml     # YAML entry, secrets masked
mcpkit view postman --json     # JSON entry, secrets masked
mcpkit view postman --reveal   # Raw values (prints a warning: the output contains secrets)
```

### `mcpkit edit <name>`

Modify config for a registered server without reinstalling.

```
Options:
  --env <KEY=VALUE>          Add/update env var (stdio only, repeatable)
  --remove-env <KEY>         Remove env var (stdio only, repeatable)
  --header <Key: Value>      Add/update header (http/sse only, repeatable)
  --remove-header <KEY>      Remove header (http/sse only, repeatable)
  --auth <type>              Set auth type (oauth or none)
  --description <text>       Set server description
  --name <new-name>          Rename the server
```

```bash
mcpkit edit myapi --auth oauth              # Enable OAuth on existing server
mcpkit edit myapi --auth none               # Remove OAuth
mcpkit edit myapi --header "X-Custom: val"  # Add a header
mcpkit edit github --env GITHUB_TOKEN=ghp_xxx
mcpkit edit github --name gh                # Rename
```

After `mcpkit edit` changes a server's command or URL, run `mcpkit update <name>` so the schema cache and the skill files match the new server.

### `mcpkit update [name]`

Re-discover tools and regenerate skill files. `mcpkit update <name>` may open the browser to sign in to that server; `mcpkit update` without a name never does (see [OAuth](#oauth)).

```bash
mcpkit update              # Update all servers
mcpkit update filesystem   # Update one server
```

A server that cannot be reached does not stop the others: every server is tried, a failed one keeps its skill files, schema cache and registry entry, and the exit code is 1 if any failed. An OAuth server that needs sign-in is skipped, not failed: it does not change the exit code.

### `mcpkit sync [name]`

Regenerate missing skill files and re-detect newly installed agents. Unlike `update`, skips servers whose skill files already exist (use `--force` to override).

```bash
mcpkit sync                # Sync all — only regenerates missing skill files
mcpkit sync github         # Sync a specific server
mcpkit sync --force        # Regenerate all skill files
mcpkit sync --dry-run      # Preview what would be synced
```

`mcpkit sync` without a name never opens a browser: an OAuth server that needs sign-in is skipped with a note, the other servers are still synced, and the exit code is unchanged (see [OAuth](#oauth)).

### `mcpkit remove <name>`

Uninstall a server — deletes skill files, the schema cache and the registry entry.

```bash
mcpkit remove filesystem
mcpkit remove filesystem --agent cursor   # Remove only from Cursor
```

### `mcpkit auth <name>`

Manage OAuth authentication for a server.

```bash
mcpkit auth postman             # Run OAuth flow
mcpkit auth postman --status    # Check if authenticated
mcpkit auth postman --reset     # Clear tokens and re-authenticate
```

## Upgrading from 0.1.29 or earlier

There is no auto-update and no first-run message: `npm i -g @balakumar.dev/mcpkit@latest`, then nothing is printed. Your registry (`~/.mcpkit/servers.yaml`) and credentials (`~/.mcpkit/credentials.json`) keep their format, so `list`, `view`, `call`, `exec` and OAuth calls work at once and a rollback is just `npm i -g @balakumar.dev/mcpkit@0.1.29` (the old `sync` and `update` rewrite the skills and the guide and ignore `~/.mcpkit/config.yaml`; they leave that file and `schemas/` alone).

Nothing refreshes your generated files for you. After upgrading, run:

```bash
mcpkit update            # re-discovers every server: refreshes per-server skills, the schema caches and the mcpkit-cli guide
mcpkit list              # look for "skipping server" warnings (see "Server names" below)
mcpkit hook install --write                                  # optional: the SessionStart hook for Claude Code
mcpkit config skills guide --agent claude-code --dry-run     # optional: preview dropping the per-server skills for one agent
```

Use `update`, not `sync`: `sync` only writes skills that are missing, so it refreshes the `mcpkit-cli` guide but leaves existing per-server skills as they were (they still work, they just lack the code-mode text) and creates no schema cache. Until a server has a cache, `search` without `--server` names it as "not searched" and the hook lists it as "not cached"; `describe`, `types` and `search --server` fetch the cache on first use. A persistent runtime started by the old version is replaced by the first `call` and loses its in-memory session state.

What behaves differently from 0.1.29:

- **`call`.** A tool that reports an error now exits `1` with the message on stderr (0.1.29 exited `0` and printed it to stdout). Params that are not a JSON object exit `2`. `--json` is new on `call`, `list` and `view`.
- **Secrets are masked.** `list` and `view` (also `--yaml`) print every env and header value as `<redacted len=N>`; `--reveal` shows them. A script that copied values out of `view --yaml` now gets the placeholders.
- **Server names.** A name may only contain letters, digits, `.`, `_` and `-`, must start with a letter or digit, and is at most 64 characters, because it becomes a directory and a file name. An older registry may hold a name outside that rule (`_x`, `my server`): such an entry is skipped with a warning and stays in the file. Rename its key in `servers.yaml`, then run `mcpkit update <name>`.
- **File modes.** New files are owner-only. A `servers.yaml` written by an old version keeps its mode and can hold env values in clear text: run `chmod 600 ~/.mcpkit/servers.yaml`.

## Authentication

### Env Var Expansion

Headers and stdio env values support `${VAR_NAME}` syntax. Variables are stored as-is in the registry and resolved at call time from your environment:

```bash
mcpkit install https://api.example.com --header "Authorization: Bearer \${MY_API_KEY}"
# servers.yaml stores: Authorization: Bearer ${MY_API_KEY}
# At call time: resolves to the actual value from process.env
```

### OAuth

For MCP servers that require OAuth (e.g., Postman, Linear, Vercel), use the `--auth oauth` flag:

```bash
# Install with OAuth — browser opens for authorization during install
mcpkit install https://mcp.postman.com/mcp --auth oauth -n postman

# Tools are discovered after auth, and calls use cached tokens automatically
mcpkit call postman list_collections '{}'
```

**Add OAuth to an existing server:**

```bash
# If you already installed a server without --auth, enable it later
mcpkit edit postman --auth oauth
mcpkit auth postman
```

**Manage OAuth tokens:**

```bash
mcpkit auth postman --status    # Check if authenticated
mcpkit auth postman --reset     # Clear tokens and re-authenticate
mcpkit auth postman             # Run OAuth flow (re-auth or first-time)
```

OAuth credentials are stored at `~/.mcpkit/credentials.json` with restricted file permissions (mode 0600). Tokens are refreshed automatically when expired.

**Which commands may open a browser.** Only a command aimed at one server: `mcpkit auth <name>`, `mcpkit install`, `mcpkit call`, and `mcpkit update`, `sync` or `list` given a server name. Everything that covers all servers or runs unattended never does: `mcpkit update` and `mcpkit sync` without a name, auto-refresh, `exec`, `search`, `describe`, `types` and the SessionStart hook. They use the saved tokens, refreshing them when they have expired. A server that needs sign-in and has no usable tokens is skipped with `⚠ <server>: needs sign-in (mcpkit auth <server>); skipped`, the other servers are still processed, and the skip does not by itself change the exit code. Run `mcpkit auth <server>` once to sign in.

## Scope: Global vs Project

| Scope | Flag | Behavior |
|-------|------|----------|
| Global | `--scope global` (default) | User-level, applies to all projects |
| Project | `--scope project` | Per-project, checked into repo |

### Where skills go

All agents use the [agentskills.io](https://agentskills.io) open standard — a `SKILL.md` file inside a skill directory.

| Agent | Global | Project |
|-------|--------|---------|
| Claude Code | `~/.claude/skills/mcpkit-<name>/SKILL.md` | `.claude/skills/mcpkit-<name>/SKILL.md` |
| Cursor | `~/.cursor/skills/mcpkit-<name>/SKILL.md` | `.cursor/skills/mcpkit-<name>/SKILL.md` |
| Windsurf | `~/.codeium/windsurf/skills/mcpkit-<name>/SKILL.md` | `.windsurf/skills/mcpkit-<name>/SKILL.md` |
| Augment | `~/.augment/skills/mcpkit-<name>/SKILL.md` | `.augment/skills/mcpkit-<name>/SKILL.md` |
| Codex CLI | `~/.codex/skills/mcpkit-<name>/SKILL.md` | `.agents/skills/mcpkit-<name>/SKILL.md` |
| OpenClaw | `~/.openclaw/skills/mcpkit-<name>/SKILL.md` | `skills/mcpkit-<name>/SKILL.md` |

## Why not just use tool search?

Tool search exists in Claude Code but the problem is reliability. It uses regex/BM25 to find tools on demand and it misses things. Tool calls just don't happen because the search didn't match the right tool name.

The setup that works: keep essential MCPs (the ones you use every session) always-on in your MCP config. Stuff you need on the fly like browser automation, google workspace etc, install through mcpkit as skills. A skill puts ~2 lines in the system prompt with a clear description of when to use it. The agent sees it every turn and triggers it reliably. No searching involved.

The other thing is tool search is Claude Code only. If you use Cursor or Codex or Windsurf you don't have it at all. mcpkit generates skills for all of them from the same install.

So it's not competing with tool search. It's more like: keep your core MCPs as MCPs, and use mcpkit for the rest so they're lightweight and available across agents without bloating your context.

## How It Works

1. **Resolve** — mcpkit loads the saved server config from `~/.mcpkit/servers.yaml`
2. **Connect** — for one-shot servers, mcpkit connects directly using stdio, HTTP, or SSE; for persistent stdio servers, it auto-starts or reuses a local background runtime
3. **Discover** — calls `tools/list` to get all available tools with their schemas
4. **Generate** — creates agent-specific skill files with tool docs and `mcpkit call` examples
5. **Register** — saves the server config to `~/.mcpkit/servers.yaml` for future calls
6. **Cache** — saves the full tool schemas to `~/.mcpkit/schemas/<server>.json` for `search`, `describe` and `types` (`exec` only uses it for name suggestions and reads read-only hints live from the server)

When an agent encounters a task matching a skill, it reads the skill file and runs:

```bash
mcpkit call <server> <tool> '{"param": "value"}'
```

mcpkit looks up the server transport from the registry, then either makes a one-shot connection or forwards the call to a configured persistent runtime, and returns the result.

## Agent Auto-Detection

If no `--agent` flag is provided, mcpkit detects which agents are installed by checking for their config directories (`~/.claude/`, `.cursor/`, `~/.codex/`, `.windsurf/`, `~/.augment/`, `~/.openclaw/`). Falls back to `claude-code` if none detected.

## Registry

Server configs are stored in `~/.mcpkit/servers.yaml`:

```yaml
version: 1
servers:
  filesystem:
    name: filesystem
    transport:
      type: stdio
      command: npx
      args:
        - -y
        - "@modelcontextprotocol/server-filesystem"
        - /tmp
    toolCount: 14
    agents:
      - claude-code
    createdAt: "2025-01-01T00:00:00.000Z"
    updatedAt: "2025-01-01T00:00:00.000Z"
  postman:
    name: postman
    transport:
      type: http
      url: https://mcp.postman.com/mcp
      auth: oauth
    toolCount: 126
    agents:
      - claude-code
    createdAt: "2025-01-01T00:00:00.000Z"
    updatedAt: "2025-01-01T00:00:00.000Z"
```

A `servers.yaml` or `credentials.json` that cannot be parsed is reported as an error and left untouched, never treated as empty. An entry in `servers.yaml` that is not valid, such as one whose name breaks the server-name rule, is skipped with a warning and stays in the file for you to fix or delete.

## License

MIT
