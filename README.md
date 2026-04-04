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
  -n, --name <name>    Custom server name
  -a, --agent <agent>  Target agent (repeatable: --agent claude-code --agent cursor)
  --scope <scope>      global or project (default: global)
  -e, --env <env>      Environment variables for stdio (repeatable: -e KEY=VALUE)
  -d, --description    Custom skill description (overrides auto-generated)
  --header <header>    HTTP headers (repeatable: --header "Key: Value")
  --auth <type>        Authentication type (oauth)
  --dry-run            Preview generated files without writing
```

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

```bash
mcpkit call filesystem read_file '{"path":"/tmp/example.txt"}'
mcpkit call github search_repositories '{"query":"mcpkit"}'
mcpkit call postman list_collections '{}'   # OAuth tokens applied automatically
```

### `mcpkit list [server]`

List registered servers or tools on a specific server.

```bash
mcpkit list                # Show all registered servers
mcpkit list filesystem     # Show tools on filesystem server
```

### `mcpkit view <name>`

Show full config for a registered server — transport, env vars, headers, auth, and metadata.

```bash
mcpkit view postman            # Formatted output
mcpkit view postman --yaml     # Raw YAML entry
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

### `mcpkit update [name]`

Re-discover tools and regenerate skill files. Handles OAuth re-authentication automatically for servers with `auth: oauth`.

```bash
mcpkit update              # Update all servers
mcpkit update filesystem   # Update one server
```

### `mcpkit sync [name]`

Regenerate missing skill files and re-detect newly installed agents. Unlike `update`, skips servers whose skill files already exist (use `--force` to override).

```bash
mcpkit sync                # Sync all — only regenerates missing skill files
mcpkit sync github         # Sync a specific server
mcpkit sync --force        # Regenerate all skill files
mcpkit sync --dry-run      # Preview what would be synced
```

### `mcpkit remove <name>`

Uninstall a server — deletes skill files and registry entry.

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

OAuth credentials are stored at `~/.mcpkit/credentials.json` with restricted file permissions (mode 0600). Tokens are refreshed automatically when expired. The `call`, `update`, and `install` commands all handle OAuth transparently — if tokens are cached, they're used; if expired, you'll be prompted to re-authorize.

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

1. **Connect** — mcpkit connects to the MCP server using stdio, HTTP, or SSE transport
2. **Discover** — calls `tools/list` to get all available tools with their schemas
3. **Generate** — creates agent-specific skill files with tool docs and `mcpkit call` examples
4. **Register** — saves the server config to `~/.mcpkit/servers.yaml` for future calls

When an agent encounters a task matching a skill, it reads the skill file and runs:

```bash
mcpkit call <server> <tool> '{"param": "value"}'
```

mcpkit looks up the server transport from the registry, connects, calls the tool, and returns the result.

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

## License

MIT
