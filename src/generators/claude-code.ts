import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildParamTable, buildCallCommand } from './index.js';

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const toolNames = ctx.tools.map(t => t.name).join(', ');
  const lines: string[] = [
    '---',
    `name: "mcpx: ${ctx.serverName}"`,
    `description: "MCP tools via mcpx — ${ctx.description || ctx.serverName}. Tools: ${toolNames}"`,
    '---',
    '',
    `# ${ctx.serverName} (MCP Server)`,
    '',
    `${ctx.description || 'MCP server installed via mcpx.'}`,
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

  const filePath = join(homedir(), '.claude', 'skills', `mcpx-${ctx.serverName}`, 'SKILL.md');

  return {
    agent: 'claude-code',
    filePath,
    content: lines.join('\n'),
    isAppend: false,
  };
}
