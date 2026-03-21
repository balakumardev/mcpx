import { Command } from 'commander';
import chalk from 'chalk';
import { getServer } from '../config.js';
import { callTool } from '../client.js';
import { authenticateIfNeeded } from '../auth.js';

export function createCallCommand(): Command {
  return new Command('call')
    .description('Call an MCP tool on a registered server')
    .argument('<server>', 'Server name from registry')
    .argument('<tool>', 'Tool name to invoke')
    .argument('[params]', 'JSON parameters', '{}')
    .addHelpText('after', `
Examples:
  $ mcpkit call github list_repos '{"owner":"octocat"}'
  $ mcpkit call weather get_forecast '{"city":"London"}'
  $ mcpkit call postman list_collections '{}'    # OAuth tokens used automatically`)
    .action(async (server: string, tool: string, paramsStr: string) => {
      try {
        const entry = await getServer(server);
        if (!entry) {
          console.error(chalk.red(`Server "${server}" not found. Run 'mcpkit list' to see registered servers.`));
          process.exit(1);
        }

        // If OAuth, authenticate first
        const authProvider = (entry.transport.type === 'http' || entry.transport.type === 'sse') && entry.transport.auth === 'oauth'
          ? await authenticateIfNeeded(entry.transport.url, entry.transport.oauth)
          : undefined;

        const params = JSON.parse(paramsStr);
        const result = await callTool(entry.transport, tool, params, authProvider);
        process.stdout.write(result);
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
