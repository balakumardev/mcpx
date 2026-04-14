import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentType, GeneratorContext, GeneratedSkill, ToolInfo } from '../types.js';

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
 * Build standard agentskills.io SKILL.md content.
 * Shared across all generators since the format is the same.
 */
export function buildSkillContent(ctx: GeneratorContext): string {
  const description = buildFrontmatterDescription(ctx);
  const serverName = ctx.serverMeta?.name || ctx.serverName;
  const domain = inferDomain(ctx.tools) || serverName;
  const isPersistentCapable = ctx.transport.type === 'stdio';

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

  lines.push('## How to Use mcpkit');
  lines.push('');
  lines.push('List the available tools on this server:');
  lines.push('```bash');
  lines.push(`mcpkit list ${ctx.serverName}`);
  lines.push('```');
  lines.push('');
  lines.push('Inspect the saved server config and transport details:');
  lines.push('```bash');
  lines.push(`mcpkit view ${ctx.serverName}`);
  lines.push('```');
  lines.push('');
  lines.push('Call one tool with JSON params:');
  lines.push('```bash');
  lines.push(`mcpkit call ${ctx.serverName} <tool_name> '{}'`);
  lines.push('```');
  lines.push('');
  lines.push('Chain dependent tool calls in one session:');
  lines.push('```bash');
  lines.push(`mcpkit call ${ctx.serverName} <tool_name> '{}' --chain 'another_tool:{"value":"$prev.someField"}'`);
  lines.push('```');
  lines.push('');
  if (isPersistentCapable) {
    lines.push('This server uses stdio transport, so it can use `mcpkit` persistent runtimes:');
    lines.push('```bash');
    lines.push(`mcpkit edit ${ctx.serverName} --runtime persistent --runtime-idle-timeout 900 --runtime-call-timeout 3600`);
    lines.push(`mcpkit runtime status ${ctx.serverName}`);
    lines.push(`mcpkit runtime stop ${ctx.serverName}`);
    lines.push('```');
    lines.push('');
  }

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
    lines.push(buildCallCommand(ctx.serverName, tool.name));
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

  return agents;
}
