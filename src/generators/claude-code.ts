import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildSkillContent } from './index.js';

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const skillDir = `mcpkit-${ctx.serverName}`;
  const filePath = ctx.scope === 'global'
    ? join(homedir(), '.claude', 'skills', skillDir, 'SKILL.md')
    : join(process.cwd(), '.claude', 'skills', skillDir, 'SKILL.md');

  return {
    agent: 'claude-code',
    scope: ctx.scope,
    filePath,
    content: buildSkillContent(ctx),
    isAppend: false,
  };
}
