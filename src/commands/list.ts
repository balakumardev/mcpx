import { Command } from 'commander';
import chalk from 'chalk';
import { listServers, getServer } from '../config.js';
import { discoverTools } from '../client.js';

export function createListCommand(): Command {
  return new Command('list')
    .description('List registered servers or tools on a server')
    .argument('[server]', 'Server name to show tools for')
    .action(async (server?: string) => {
      try {
        if (server) {
          // Show tools for a specific server
          const entry = await getServer(server);
          if (!entry) {
            console.error(chalk.red(`Server "${server}" not found.`));
            process.exit(1);
          }

          console.log(chalk.blue(`Connecting to ${server}...`));
          const tools = await discoverTools(entry.transport);
          console.log(chalk.bold(`\nTools on ${server} (${tools.length}):\n`));

          for (const tool of tools) {
            console.log(`  ${chalk.bold(tool.name)}`);
            if (tool.description) console.log(`    ${chalk.dim(tool.description)}`);
          }
        } else {
          // Show all registered servers
          const servers = await listServers();
          if (servers.length === 0) {
            console.log(chalk.yellow('No servers registered. Run `mcpkit install <server>` to add one.'));
            return;
          }

          console.log(chalk.bold(`\nRegistered servers (${servers.length}):\n`));

          for (const s of servers) {
            const transport = s.transport.type === 'stdio'
              ? `${s.transport.command} ${s.transport.args.join(' ')}`.trim()
              : s.transport.url;
            console.log(`  ${chalk.bold(s.name)} (${s.transport.type})`);
            console.log(`    Tools: ${s.toolCount} | Agents: ${s.agents.join(', ')}`);
            console.log(`    ${chalk.dim(transport)}`);
            console.log();
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
