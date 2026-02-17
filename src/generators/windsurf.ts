import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildSkillContent } from './index.js';

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const skillDir = `mcpx-${ctx.serverName}`;
  const filePath = ctx.scope === 'global'
    ? join(homedir(), '.codeium', 'windsurf', 'skills', skillDir, 'SKILL.md')
    : join(process.cwd(), '.windsurf', 'skills', skillDir, 'SKILL.md');

  return {
    agent: 'windsurf',
    scope: ctx.scope,
    filePath,
    content: buildSkillContent(ctx),
    isAppend: false,
  };
}
