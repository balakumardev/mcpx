import { Command } from 'commander';
import chalk from 'chalk';
import { getServer } from '../config.js';
import { callTool } from '../client.js';

export function createCallCommand(): Command {
  return new Command('call')
    .description('Call an MCP tool on a registered server')
    .argument('<server>', 'Server name from registry')
    .argument('<tool>', 'Tool name to invoke')
    .argument('[params]', 'JSON parameters', '{}')
    .action(async (server: string, tool: string, paramsStr: string) => {
      try {
        const entry = await getServer(server);
        if (!entry) {
          console.error(chalk.red(`Server "${server}" not found. Run 'mcpkit list' to see registered servers.`));
          process.exit(1);
        }

        const params = JSON.parse(paramsStr);
        const result = await callTool(entry.transport, tool, params);
        process.stdout.write(result);
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
