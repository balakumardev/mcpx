# mcpkit

Universal MCP-to-Agent Skill Installer. Auto-discovers tools from any MCP server and installs lightweight skill/rule files into your AI coding agent.

**Supported agents:** Claude Code, Cursor, Windsurf, Augment Code, OpenAI Codex CLI

## Why

AI coding agents can use MCP servers, but loading all tool schemas into context every turn wastes tokens. Each agent has its own skill/instruction system that loads context on-demand. `mcpkit` bridges these — auto-discovering MCP tools and installing skill files into whichever agent you use.

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
  --header <header>    HTTP headers (repeatable: --header "Key: Value")
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

Call a tool on a registered server. This is what the generated skill files teach agents to run.

```bash
mcpkit call filesystem read_file '{"path":"/tmp/example.txt"}'
mcpkit call github search_repositories '{"query":"mcpkit"}'
```

### `mcpkit list [server]`

List registered servers or tools on a specific server.

```bash
mcpkit list                # Show all registered servers
mcpkit list filesystem     # Show tools on filesystem server
```

### `mcpkit update [name]`

Re-discover tools and regenerate skill files.

```bash
mcpkit update              # Update all servers
mcpkit update filesystem   # Update one server
```

### `mcpkit remove <name>`

Uninstall a server — deletes skill files and registry entry.

```bash
mcpkit remove filesystem
mcpkit remove filesystem --agent cursor   # Remove only from Cursor
```

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

If no `--agent` flag is provided, mcpkit detects which agents are installed by checking for their config directories (`~/.claude/`, `.cursor/`, `~/.codex/`, `.windsurf/`, `~/.augment/`). Falls back to `claude-code` if none detected.

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
```

## License

MIT
