import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildSkillContent, skillFilePath } from './index.js';

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const skillsRoot = ctx.scope === 'global'
    ? join(homedir(), '.augment', 'skills')
    : join(process.cwd(), '.augment', 'skills');
  const filePath = skillFilePath(skillsRoot, ctx.serverName);

  return {
    agent: 'augment',
    scope: ctx.scope,
    filePath,
    content: buildSkillContent(ctx),
    isAppend: false,
  };
}
