import { Command } from 'commander';
import chalk from 'chalk';
import { getServer, listServers, addServer } from '../config.js';
import { discoverTools } from '../client.js';
import { authenticateIfNeeded } from '../auth.js';
import { loadAgentSettings, resolveServerAgents } from '../agent-config.js';
import { reconcileSkillFiles } from '../skill-sync.js';

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
        const settings = await loadAgentSettings();
        const servers = name ? [await getServer(name)].filter(Boolean) : await listServers();

        if (servers.length === 0) {
          console.log(chalk.yellow(name ? `Server "${name}" not found.` : 'No servers registered.'));
          return;
        }

        for (const entry of servers) {
          if (!entry) continue;
          console.log(chalk.blue(`Updating ${entry.name}...`));

          // If OAuth, authenticate first
          const authProvider = (entry.transport.type === 'http' || entry.transport.type === 'sse') && entry.transport.auth === 'oauth'
            ? await authenticateIfNeeded(entry.transport.url, entry.transport.oauth)
            : undefined;

          const { tools, serverMeta } = await discoverTools(entry.transport, authProvider);
          console.log(`  Found ${tools.length} tool(s)`);
          const resolved = resolveServerAgents(entry, settings);

          const ctx = { serverName: entry.name, tools, transport: entry.transport, description: entry.description, serverMeta, scope: 'global' as const };
          await reconcileSkillFiles({
            ctx,
            nextAgents: resolved.agents,
            previousAgents: entry.agents,
            logPrefix: '  ',
          });

          entry.toolCount = tools.length;
          entry.agents = resolved.agents;
          entry.agentSelectionMode = resolved.selectionMode;
          entry.updatedAt = new Date().toISOString();
          await addServer(entry);
        }

        console.log(chalk.green(`\n✓ Updated ${servers.length} server(s)`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
