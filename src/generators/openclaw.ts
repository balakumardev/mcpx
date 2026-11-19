import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildSkillContent, skillFilePath } from './index.js';

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const skillsRoot = ctx.scope === 'global'
    ? join(homedir(), '.openclaw', 'skills')
    : join(process.cwd(), 'skills');
  const filePath = skillFilePath(skillsRoot, ctx.serverName);

  return {
    agent: 'openclaw',
    scope: ctx.scope,
    filePath,
    content: buildSkillContent(ctx),
    isAppend: false,
  };
}
