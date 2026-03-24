import chalk from 'chalk';
import { getGenerator } from './generators/index.js';
import { removeSkillDirectory, writeSkillFile } from './skill-file.js';
import type { AgentType, GeneratorContext } from './types.js';

export interface ReconcileSkillFilesOptions {
  ctx: GeneratorContext;
  nextAgents: AgentType[];
  previousAgents?: AgentType[];
  dryRun?: boolean;
  logPrefix?: string;
}

export async function reconcileSkillFiles(options: ReconcileSkillFilesOptions): Promise<void> {
  const { ctx, nextAgents, previousAgents = [], dryRun = false, logPrefix = '' } = options;
  const previousSet = new Set(previousAgents);
  const nextSet = new Set(nextAgents);

  for (const agent of nextAgents) {
    const generate = await getGenerator(agent);
    const skill = generate(ctx);

    if (dryRun) {
      console.log(chalk.yellow(`${logPrefix}[dry-run] ${agent}: ${skill.filePath}`));
      console.log(chalk.dim(skill.content.slice(0, 200) + '...'));
      console.log();
    } else {
      await writeSkillFile(skill.filePath, skill.content);
      console.log(chalk.green(`${logPrefix}✓ ${agent}: ${skill.filePath}`));
    }
  }

  for (const agent of previousSet) {
    if (nextSet.has(agent)) continue;

    const generate = await getGenerator(agent);
    const skill = generate(ctx);

    if (dryRun) {
      console.log(chalk.yellow(`${logPrefix}[dry-run] remove ${agent}: ${skill.filePath}`));
    } else {
      await removeSkillDirectory(skill.filePath);
      console.log(chalk.green(`${logPrefix}✓ Removed ${agent}: ${skill.filePath}`));
    }
  }
}
