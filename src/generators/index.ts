import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentType, GeneratorContext, GeneratedSkill, ToolInfo, ServerRuntimeConfig } from '../types.js';
import { DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC, DEFAULT_RUNTIME_CALL_TIMEOUT_SEC } from '../types.js';

// Build a markdown table from JSON Schema properties
export function buildParamTable(schema: Record<string, unknown>): string {
  const props = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required || []) as string[];
  if (Object.keys(props).length === 0) return '_No parameters_';

  const rows = Object.entries(props).map(([name, prop]) => {
    const type = (prop.type as string) || 'any';
    const req = required.includes(name) ? 'Yes' : 'No';
    const desc = (prop.description as string) || '';
    return `| \`${name}\` | ${type} | ${req} | ${desc} |`;
  });

  return ['| Param | Type | Required | Description |', '|-------|------|----------|-------------|', ...rows].join('\n');
}

// Build mcpkit call command string
export function buildCallCommand(serverName: string, toolName: string): string {
  return `mcpkit call ${serverName} ${toolName} '{}'`;
}

/**
 * Infer the primary domain from tool name prefixes.
 * e.g., tools named browser_navigate, browser_click → "browser"
 */
function inferDomain(tools: ToolInfo[]): string {
  const prefixCounts: Record<string, number> = {};
  for (const tool of tools) {
    const prefix = tool.name.split(/[_-]/)[0];
    if (prefix) prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
  }
  const sorted = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1]);
  // Use dominant prefix if it covers >40% of tools
  if (sorted.length > 0 && sorted[0][1] > tools.length * 0.4) {
    return sorted[0][0];
  }
  return '';
}

/**
 * Build a short capability summary from tool descriptions.
 * Extracts the core action from each description (first clause only).
 * Returns concise phrases like "navigate pages, click elements, type text".
 */
function buildCapabilitySummary(tools: ToolInfo[], maxItems = 6): string {
  const descriptions = tools
    .filter(t => t.description)
    .map(t => {
      const desc = t.description.toLowerCase();
      // Take just the first clause — stop at period, semicolon, or "use this"
      const match = desc.match(/^([^.;!]+?)(?:\.|;|$)/);
      return (match ? match[1] : desc).trim().replace(/\.$/, '');
    })
    // Deduplicate similar descriptions
    .filter((desc, i, arr) => arr.indexOf(desc) === i);

  if (descriptions.length === 0) return '';

  return descriptions.slice(0, maxItems).join(', ');
}

/**
 * Build the frontmatter description — the critical line agents see in skill listings.
 *
 * Priority:
 *   1. User-provided description (--description flag)
 *   2. MCP server instructions (from initialize response)
 *   3. npm package description (for npx-based servers)
 *   4. Auto-generated from tool descriptions
 */
function buildFrontmatterDescription(ctx: GeneratorContext): string {
  // 1. User-provided description takes priority
  if (ctx.description) {
    return ctx.description;
  }

  const serverName = ctx.serverMeta?.name || ctx.serverName;
  const domain = inferDomain(ctx.tools) || serverName;
  const capabilities = buildCapabilitySummary(ctx.tools);

  // 2. MCP server instructions
  if (ctx.serverMeta?.instructions) {
    const instructions = ctx.serverMeta.instructions.replace(/\n/g, ' ').trim();
    return `${serverName} via mcpkit — ${instructions}`;
  }

  // 3. npm package description — enrich with capabilities
  if (ctx.serverMeta?.packageDescription) {
    const npmDesc = ctx.serverMeta.packageDescription;
    if (capabilities) {
      return `${npmDesc} via mcpkit — ${capabilities}. Use this when you need to work with ${domain}.`;
    }
    return `${npmDesc} via mcpkit. Use this when you need to work with ${domain}.`;
  }

  // 4. Auto-generated from tool metadata
  if (capabilities) {
    return `${capitalize(domain)} tools via mcpkit — ${capabilities}. Use this when you need to work with ${domain}.`;
  }

  return `${capitalize(domain)} tools via mcpkit. Use this when you need to work with ${domain}.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build a minimal example JSON with placeholder values for required params.
 * Returns '{}' if no required params exist.
 */
function buildExampleParams(schema: Record<string, unknown>): string {
  const props = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required || []) as string[];
  if (required.length === 0) return '{}';

  const entries: string[] = [];
  for (const name of required) {
    const prop = props[name];
    if (!prop) continue;
    const type = prop.type as string;
    switch (type) {
      case 'string':
        entries.push(`"${name}": "<${name}>"`);
        break;
      case 'number':
      case 'integer':
        entries.push(`"${name}": 0`);
        break;
      case 'boolean':
        entries.push(`"${name}": true`);
        break;
      case 'array':
        entries.push(`"${name}": []`);
        break;
      case 'object':
        entries.push(`"${name}": {}`);
        break;
      default:
        entries.push(`"${name}": "<${name}>"`);
    }
  }
  return entries.length > 0 ? `{${entries.join(', ')}}` : '{}';
}

function formatTimeout(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Build standard agentskills.io SKILL.md content.
 * Shared across all generators since the format is the same.
 */
export function buildSkillContent(ctx: GeneratorContext): string {
  const description = buildFrontmatterDescription(ctx);
  const serverName = ctx.serverMeta?.name || ctx.serverName;
  const domain = inferDomain(ctx.tools) || serverName;
  const isStdio = ctx.transport.type === 'stdio';
  const isPersistentEnabled = ctx.runtime?.mode === 'persistent';

  const lines: string[] = [
    '---',
    `name: mcpkit-${ctx.serverName}`,
    `description: "${description}"`,
    '---',
    '',
    `# ${serverName} (MCP Server)`,
    '',
    ctx.description || ctx.serverMeta?.instructions || ctx.serverMeta?.packageDescription || `${capitalize(domain)} tools installed via mcpkit.`,
    '',
    `> **Important:** These are NOT native MCP tools. Do NOT call them as \`mcp__${ctx.serverName}__*\` tools.`,
    `> All tools must be invoked via Bash using \`mcpkit call ${ctx.serverName} <tool_name> '<json_params>'\`.`,
    '',
    '## When to Use',
    '',
    `Use this skill when you need to:`,
  ];

  // Build "When to use" bullets from tool descriptions
  for (const tool of ctx.tools) {
    if (tool.description) {
      lines.push(`- ${tool.description}`);
    }
  }
  lines.push('');

  // --- How to Use section ---
  lines.push('## How to Use mcpkit');
  lines.push('');

  // Basic call syntax with a concrete example
  lines.push('### Calling a tool');
  lines.push('');
  lines.push('```bash');
  lines.push(`mcpkit call ${ctx.serverName} <tool_name> '<json_params>'`);
  lines.push('```');
  lines.push('');

  // Find a tool with required params to build a real example
  const exampleTool = ctx.tools.find(t => {
    const schema = t.inputSchema as Record<string, unknown>;
    return ((schema.required as string[]) || []).length > 0;
  });
  if (exampleTool) {
    const exParams = buildExampleParams(exampleTool.inputSchema as Record<string, unknown>);
    lines.push('Example:');
    lines.push('```bash');
    lines.push(`mcpkit call ${ctx.serverName} ${exampleTool.name} '${exParams}'`);
    lines.push('```');
    lines.push('');
  }

  lines.push('Output is plain text or JSON depending on the tool. Parse JSON output with `jq` if needed.');
  lines.push('');

  // Chaining
  lines.push('### Chaining multiple calls');
  lines.push('');
  lines.push('Run dependent tool calls in one session using `--chain`. Reference previous output with `$prev.fieldName` (JSON output) or `$prev._text` (plain text):');
  lines.push('');
  lines.push('```bash');
  lines.push(`mcpkit call ${ctx.serverName} <tool_a> '{}' --chain '<tool_b>:{"input":"$prev.someField"}'`);
  lines.push('```');
  lines.push('');

  // Param provider info
  if (ctx.paramProvider) {
    lines.push('### Auto-injected parameters');
    lines.push('');
    lines.push(`This server has a param provider configured (\`${ctx.paramProvider.command}\`) that automatically injects parameters (e.g., auth credentials) into every tool call. You do **not** need to pass these params manually.`);
    lines.push('');
  }

  // Persistent runtime section — context-aware
  if (isStdio) {
    if (isPersistentEnabled) {
      const idle = ctx.runtime?.idleTimeoutSec ?? DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC;
      const call = ctx.runtime?.callTimeoutSec ?? DEFAULT_RUNTIME_CALL_TIMEOUT_SEC;
      lines.push('### Persistent runtime (enabled)');
      lines.push('');
      lines.push(`This server runs as a **persistent background daemon**. The MCP server process stays alive between tool calls, so:`);
      lines.push('- No reconnect overhead on each call');
      lines.push('- Session state (browser windows, in-memory data, etc.) persists across calls');
      lines.push(`- The daemon auto-starts on first \`mcpkit call\` — no manual startup needed`);
      lines.push(`- Idle timeout: **${formatTimeout(idle)}** — daemon shuts down after ${formatTimeout(idle)} of inactivity`);
      lines.push(`- Call timeout: **${formatTimeout(call)}** — maximum time for a single tool call`);
      lines.push('');
      lines.push('Manage the runtime:');
      lines.push('```bash');
      lines.push(`mcpkit runtime status ${ctx.serverName}   # Check if daemon is running`);
      lines.push(`mcpkit runtime stop ${ctx.serverName}     # Stop the daemon`);
      lines.push('```');
      lines.push('');
      lines.push('Change timeout settings:');
      lines.push('```bash');
      lines.push(`mcpkit edit ${ctx.serverName} --runtime-idle-timeout <seconds> --runtime-call-timeout <seconds>`);
      lines.push('```');
    } else {
      lines.push('### Persistent runtime (available)');
      lines.push('');
      lines.push('This server uses stdio transport and supports persistent runtimes. When enabled, the MCP server process stays alive between calls — useful for servers that maintain session state (browsers, databases, etc.).');
      lines.push('');
      lines.push('Enable persistent runtime:');
      lines.push('```bash');
      lines.push(`mcpkit edit ${ctx.serverName} --runtime persistent --runtime-idle-timeout 900 --runtime-call-timeout 3600`);
      lines.push('```');
    }
    lines.push('');

    // Keepalive flag
    lines.push('### Keep-alive sessions');
    lines.push('');
    lines.push('Use `--keepalive` to hold a stdio session open after a call (useful for interactive exploration):');
    lines.push('```bash');
    lines.push(`mcpkit call ${ctx.serverName} <tool_name> '{}' --keepalive`);
    lines.push('```');
    lines.push('');
  }

  // Discovery commands
  lines.push('### Discovery');
  lines.push('');
  lines.push('```bash');
  lines.push(`mcpkit list ${ctx.serverName}   # List available tools on this server`);
  lines.push(`mcpkit view ${ctx.serverName}   # Show server config: transport, runtime mode, param provider, timeouts`);
  lines.push('```');
  lines.push('');

  // --- Tools section ---
  lines.push('## Tools');
  lines.push('');

  for (const tool of ctx.tools) {
    lines.push(`### ${tool.name}`);
    lines.push('');
    if (tool.description) lines.push(tool.description);
    lines.push('');
    lines.push('**Parameters:**');
    lines.push('');
    lines.push(buildParamTable(tool.inputSchema as Record<string, unknown>));
    lines.push('');
    lines.push('**Usage:**');
    lines.push('```bash');
    const exParams = buildExampleParams(tool.inputSchema as Record<string, unknown>);
    lines.push(`mcpkit call ${ctx.serverName} ${tool.name} '${exParams}'`);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// Import generators lazily
export async function getGenerator(agent: AgentType): Promise<(ctx: GeneratorContext) => GeneratedSkill> {
  switch (agent) {
    case 'claude-code': return (await import('./claude-code.js')).generate;
    case 'cursor': return (await import('./cursor.js')).generate;
    case 'codex': return (await import('./codex.js')).generate;
    case 'windsurf': return (await import('./windsurf.js')).generate;
    case 'augment': return (await import('./augment.js')).generate;
    case 'openclaw': return (await import('./openclaw.js')).generate;
    case 'hermes': return (await import('./hermes.js')).generate;
  }
}

// Detect which agents are installed on the system
export function detectAgents(): AgentType[] {
  const agents: AgentType[] = [];
  const home = homedir();

  if (existsSync(join(home, '.claude'))) agents.push('claude-code');
  if (existsSync(join(process.cwd(), '.cursor')) || existsSync(join(home, '.cursor'))) agents.push('cursor');
  if (existsSync(join(home, '.codex')) || existsSync(join(home, '.agents'))) agents.push('codex');
  if (existsSync(join(process.cwd(), '.windsurf')) || existsSync(join(home, '.codeium'))) agents.push('windsurf');
  if (existsSync(join(home, '.augment')) || existsSync(join(process.cwd(), '.augment'))) agents.push('augment');
  if (existsSync(join(home, '.openclaw'))) agents.push('openclaw');
  if (existsSync(process.env.HERMES_HOME || join(home, '.hermes'))) agents.push('hermes');

  return agents;
}
