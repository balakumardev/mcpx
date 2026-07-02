import { Command } from 'commander';
import chalk from 'chalk';
import { getServer, listServers } from '../config.js';
import { refreshServer } from '../auto-refresh.js';
import { writeMetaSkill } from '../meta-skill.js';
import type { AgentType } from '../types.js';

export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Re-discover tools and regenerate skill files')
    .argument('[name]', 'Server name (omit to update all)')
    .addHelpText('after', `
Examples:
  $ mcpkit update                Update all servers
  $ mcpkit update github         Update a specific server`)
    .action(async (name?: string) => {
      try {
        const servers = name ? [await getServer(name)].filter(Boolean) : await listServers();

        if (servers.length === 0) {
          if (name) {
            console.error(chalk.red(`Server "${name}" not found. Run 'mcpkit list' to see registered servers.`));
            process.exit(1);
          }
          console.log(chalk.yellow('No servers registered. Run `mcpkit install <server>` to add one.'));
          return;
        }

        const metaAgents = new Set<AgentType>();
        for (const entry of servers) {
          if (!entry) continue;
          console.log(chalk.blue(`Updating ${entry.name}...`));
          const { toolCount, agents } = await refreshServer(entry, { logPrefix: '  ' });
          console.log(`  Found ${toolCount} tool(s)`);
          for (const agent of agents) metaAgents.add(agent);
        }

        // Refresh the mcpkit-cli meta-skill for every agent these servers target.
        if (metaAgents.size > 0) {
          await writeMetaSkill({ agents: [...metaAgents], scope: 'global', logPrefix: '  ' });
        }

        console.log(chalk.green(`\n✓ Updated ${servers.length} server(s)`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
