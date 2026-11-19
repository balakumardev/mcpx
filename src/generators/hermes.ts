import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorContext, GeneratedSkill } from '../types.js';
import { buildSkillContent, skillFilePath } from './index.js';

// Hermes resolves its home from $HERMES_HOME, falling back to ~/.hermes.
// Skills live under <home>/skills and are discovered by recursively walking
// for SKILL.md, so the flat mcpkit-<server> layout (matching the other
// generators) is found just like Hermes's own nested category skills.
function hermesHome(): string {
  return process.env.HERMES_HOME || join(homedir(), '.hermes');
}

export function generate(ctx: GeneratorContext): GeneratedSkill {
  const skillsRoot = ctx.scope === 'global'
    ? join(hermesHome(), 'skills')
    : join(process.cwd(), '.hermes', 'skills');
  const filePath = skillFilePath(skillsRoot, ctx.serverName);

  return {
    agent: 'hermes',
    scope: ctx.scope,
    filePath,
    content: buildSkillContent(ctx),
    isAppend: false,
  };
}
