import { Command } from 'commander';
import chalk from 'chalk';
import { rm } from 'node:fs/promises';
import { getServer, removeServer } from '../config.js';
import { getGenerator } from '../generators/index.js';
import type { AgentType } from '../types.js';

export function createRemoveCommand(): Command {
  return new Command('remove')
    .description('Remove an installed MCP server')
    .argument('<name>', 'Server name to remove')
    .option('-a, --agent <agent>', 'Remove only for specific agent')
    .action(async (name: string, opts) => {
      try {
        const entry = await getServer(name);
        if (!entry) {
          console.error(chalk.red(`Server "${name}" not found.`));
          process.exit(1);
        }

        const agentsToRemove: AgentType[] = opts.agent ? [opts.agent] : entry.agents;
        const ctx = { serverName: name, tools: [], transport: entry.transport };

        for (const agent of agentsToRemove) {
          const generate = await getGenerator(agent);
          const skill = generate(ctx);

          try {
            if (skill.isAppend) {
              // For codex: need to remove the section from AGENTS.md
              const { readFile, writeFile } = await import('node:fs/promises');
              const content = await readFile(skill.filePath, 'utf-8');
              const startMarker = `<!-- mcpx:start:${name} -->`;
              const endMarker = `<!-- mcpx:end:${name} -->`;
              const regex = new RegExp(
                `\\n?${startMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
              );
              const updated = content.replace(regex, '\n');
              await writeFile(skill.filePath, updated.trim() + '\n', 'utf-8');
            } else {
              await rm(skill.filePath, { recursive: true, force: true });
            }
            console.log(chalk.green(`✓ Removed ${agent} skill: ${skill.filePath}`));
          } catch {
            console.log(chalk.dim(`  ${agent}: nothing to remove`));
          }
        }

        if (!opts.agent) {
          await removeServer(name);
          console.log(chalk.green(`✓ Server "${name}" removed from registry`));
        } else {
          // Update agents list in registry
          const { addServer } = await import('../config.js');
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
