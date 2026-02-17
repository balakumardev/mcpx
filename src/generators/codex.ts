import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildParamTable, buildCallCommand } from './index.js';

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const lines: string[] = [
    `<!-- mcpx:start:${ctx.serverName} -->`,
    `## mcpx: ${ctx.serverName}`,
    '',
    `${ctx.description || 'MCP server installed via mcpx.'}`,
    '',
  ];

  for (const tool of ctx.tools) {
    lines.push(`### ${tool.name}`);
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

  lines.push(`<!-- mcpx:end:${ctx.serverName} -->`);

  const filePath = join(homedir(), '.codex', 'AGENTS.md');

  return {
    agent: 'codex',
    filePath,
    content: lines.join('\n'),
    isAppend: true,
  };
}
