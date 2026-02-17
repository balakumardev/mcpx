import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildParamInline, buildCallCommand } from './index.js';

const CHAR_LIMIT = 6000;

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const lines: string[] = [
    `# ${ctx.serverName} (MCP)`,
    '',
    ctx.description || 'MCP server installed via mcpx.',
    '',
  ];

  for (const tool of ctx.tools) {
    const params = buildParamInline(tool.inputSchema as Record<string, unknown>);
    lines.push(`## ${tool.name}${params}`);
    if (tool.description) lines.push(tool.description);
    lines.push(`\`${buildCallCommand(ctx.serverName, tool.name)}\``);
    lines.push('');
  }

  let content = lines.join('\n');

  if (content.length > CHAR_LIMIT) {
    content = content.slice(0, CHAR_LIMIT - 50) + '\n\n_[Truncated — too many tools. Use `mcpx list` to see all.]_\n';
  }

  const filePath = join(process.cwd(), '.windsurf', 'rules', `mcpx-${ctx.serverName}.md`);

  return {
    agent: 'windsurf',
    filePath,
    content,
    isAppend: false,
  };
}
