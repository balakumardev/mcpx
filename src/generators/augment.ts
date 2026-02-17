import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildParamTable, buildCallCommand } from './index.js';

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const toolNames = ctx.tools.map(t => t.name).join(', ');
  const lines: string[] = [
    '---',
    `description: "MCP tools via mcpx — ${ctx.description || ctx.serverName}. Tools: ${toolNames}"`,
    'type: agent_requested',
    '---',
    '',
    `# ${ctx.serverName} (MCP Server)`,
    '',
    `${ctx.description || 'MCP server installed via mcpx.'}`,
    '',
  ];

  for (const tool of ctx.tools) {
    lines.push(`## ${tool.name}`);
    lines.push('');
    if (tool.description) lines.push(tool.description);
    lines.push('');
    lines.push(buildParamTable(tool.inputSchema as Record<string, unknown>));
    lines.push('');
    lines.push('```bash');
    lines.push(buildCallCommand(ctx.serverName, tool.name));
    lines.push('```');
    lines.push('');
  }

  const filePath = ctx.scope === 'global'
    ? join(homedir(), '.augment', 'rules', `mcpx-${ctx.serverName}.md`)
    : join(process.cwd(), '.augment', 'rules', `mcpx-${ctx.serverName}.md`);

  return {
    agent: 'augment',
    scope: ctx.scope,
    filePath,
    content: lines.join('\n'),
    isAppend: false,
  };
}
