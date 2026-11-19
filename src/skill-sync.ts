import chalk from 'chalk';
import { getGenerator } from './generators/index.js';
import { removeSkillDirectory, stageSkillFile } from './skill-file.js';
import type { StagedSkillFile } from './skill-file.js';
import type { AgentType, GeneratedSkill, GeneratorContext } from './types.js';

export interface ReconcileSkillFilesOptions {
  ctx: GeneratorContext;
  nextAgents: AgentType[];
  previousAgents?: AgentType[];
  dryRun?: boolean;
  logPrefix?: string;
  /** Suppress progress logging (used by background auto-refresh so it never writes to stdout). */
  quiet?: boolean;
}

/** The skill of one agent, generated and not yet written. */
interface PlannedSkill {
  agent: AgentType;
  skill: GeneratedSkill;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write the skills of all agents or none. Every file is first written to a temp file next to its
 * target (this fails early on an unwritable directory or a full disk), and only then are the
 * temp files renamed into place. When anything fails, the staged files are removed and every
 * target that was already replaced is put back as it was, so no agent ends up with a newer skill
 * than the others. The error names the agent that failed.
 */
async function writeAllOrNone(planned: PlannedSkill[]): Promise<void> {
  const staged: Array<PlannedSkill & { file: StagedSkillFile }> = [];
  let failing: PlannedSkill | undefined;
  try {
    for (const plan of planned) {
      failing = plan;
      staged.push({ ...plan, file: await stageSkillFile(plan.skill.filePath, plan.skill.content) });
    }
    for (const entry of staged) {
      failing = entry;
      await entry.file.commit();
    }
  } catch (err) {
    const notRestored: string[] = [];
    for (const entry of staged.reverse()) {
      try {
        await entry.file.revert();
      } catch (revertError) {
        notRestored.push(`${entry.agent} (${entry.skill.filePath}): ${messageOf(revertError)}`);
      }
    }
    const subject = failing ? `the ${failing.agent} skill ${failing.skill.filePath}` : 'a skill file';
    const outcome = notRestored.length === 0
      ? 'No skill file was changed.'
      : `Putting these back failed too, so they may be out of date or half written: ${notRestored.join('; ')}.`;
    throw new Error(`Could not write ${subject}: ${messageOf(err)}. ${outcome}`, { cause: err });
  }
}

export async function reconcileSkillFiles(options: ReconcileSkillFilesOptions): Promise<void> {
  const { ctx, nextAgents, previousAgents = [], dryRun = false, logPrefix = '', quiet = false } = options;
  const previousSet = new Set(previousAgents);
  const nextSet = new Set(nextAgents);

  // Generating also checks the server name, so a bad one throws before anything is written.
  const planned: PlannedSkill[] = [];
  for (const agent of nextAgents) {
    const generate = await getGenerator(agent);
    planned.push({ agent, skill: generate(ctx) });
  }

  if (dryRun) {
    for (const { agent, skill } of planned) {
      console.log(chalk.yellow(`${logPrefix}[dry-run] ${agent}: ${skill.filePath}`));
      console.log(chalk.dim(skill.content.slice(0, 200) + '...'));
      console.log();
    }
  } else {
    await writeAllOrNone(planned);
    if (!quiet) {
      for (const { agent, skill } of planned) console.log(chalk.green(`${logPrefix}✓ ${agent}: ${skill.filePath}`));
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
      if (!quiet) console.log(chalk.green(`${logPrefix}✓ Removed ${agent}: ${skill.filePath}`));
    }
  }
}
