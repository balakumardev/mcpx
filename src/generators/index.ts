import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentType, GeneratorContext, GeneratedSkill } from '../types.js';

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
 * Build standard agentskills.io SKILL.md content.
 * Shared across all generators since the format is the same.
 */
export function buildSkillContent(ctx: GeneratorContext): string {
  const toolNames = ctx.tools.map(t => t.name).join(', ');
  const lines: string[] = [
    '---',
    `name: mcpkit-${ctx.serverName}`,
    `description: "MCP tools via mcpkit — ${ctx.description || ctx.serverName}. Tools: ${toolNames}"`,
    '---',
    '',
    `# ${ctx.serverName} (MCP Server)`,
    '',
    ctx.description || 'MCP server installed via mcpkit.',
    '',
    `> **Important:** These are NOT native MCP tools. Do NOT call them as \`mcp__${ctx.serverName}__*\` tools.`,
    `> All tools must be invoked via Bash using \`mcpkit call ${ctx.serverName} <tool_name> '<json_params>'\`.`,
    '',
    '## Tools',
    '',
  ];

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

  return agents;
}
