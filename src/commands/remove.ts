import { Command } from 'commander';
import chalk from 'chalk';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getServer, removeServer, addServer } from '../config.js';
import { getGenerator } from '../generators/index.js';
import type { AgentType } from '../types.js';

export function createRemoveCommand(): Command {
  return new Command('remove')
    .description('Remove an installed MCP server')
    .argument('<name>', 'Server name to remove')
    .option('-a, --agent <agent>', 'Remove only for specific agent')
    .addHelpText('after', `
Examples:
  $ mcpkit remove github              Remove server and all skill files
  $ mcpkit remove github -a cursor    Remove only Cursor skill files`)
    .action(async (name: string, opts) => {
      try {
        const entry = await getServer(name);
        if (!entry) {
          console.error(chalk.red(`Server "${name}" not found.`));
          process.exit(1);
        }

        const agentsToRemove: AgentType[] = opts.agent ? [opts.agent] : entry.agents;
        const ctx = { serverName: name, tools: [], transport: entry.transport, scope: 'global' as const };

        for (const agent of agentsToRemove) {
          const generate = await getGenerator(agent);
          const skill = generate(ctx);

          try {
            // All generators now use SKILL.md in a skill directory — remove the directory
            await rm(dirname(skill.filePath), { recursive: true, force: true });
            console.log(chalk.green(`✓ Removed ${agent} skill: ${dirname(skill.filePath)}`));
          } catch {
            console.log(chalk.dim(`  ${agent}: nothing to remove`));
          }
        }

        if (!opts.agent) {
          await removeServer(name);
          console.log(chalk.green(`✓ Server "${name}" removed from registry`));
        } else {
          entry.agents = entry.agents.filter(a => a !== opts.agent);
          if (entry.agents.length === 0) {
            await removeServer(name);
            console.log(chalk.green(`✓ Server "${name}" removed from registry (no agents left)`));
          } else {
            await addServer(entry);
            console.log(chalk.green(`✓ Removed ${opts.agent} skill for "${name}"`));
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
