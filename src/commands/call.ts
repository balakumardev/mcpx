import { Command } from 'commander';
import chalk from 'chalk';
import { getServer } from '../config.js';
import { callTool, callToolsChained } from '../client.js';
import { authenticateIfNeeded } from '../auth.js';

export function createCallCommand(): Command {
  return new Command('call')
    .description('Call an MCP tool on a registered server')
    .argument('<server>', 'Server name from registry')
    .argument('<tool>', 'Tool name to invoke')
    .argument('[params]', 'JSON parameters', '{}')
    .option('--chain <calls...>', 'Chain additional tool calls in the same session. Format: "tool_name:{}" or "tool_name:{\\"key\\":\\"val\\"}". Use $prev.field to reference previous result fields.')
    .addHelpText('after', `
Examples:
  $ mcpkit call github list_repos '{"owner":"octocat"}'
  $ mcpkit call weather get_forecast '{"city":"London"}'
  $ mcpkit call postman list_collections '{}'    # OAuth tokens used automatically

Chained calls (single persistent session — useful for servers requiring session-based auth):
  $ mcpkit call myserver login '{}' --chain 'search:{"query":"hello","token":"$prev.token"}'

  $prev.field references are substituted with values from the previous call's JSON output.
  Non-JSON output is available as $prev._text.`)
    .action(async (server: string, tool: string, paramsStr: string, opts: { chain?: string[] }) => {
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

        if (opts.chain && opts.chain.length > 0) {
          // Build chain of calls — all in one session
          const calls: Array<{ toolName: string; params: Record<string, unknown> }> = [
            { toolName: tool, params },
          ];

          for (const chainArg of opts.chain) {
            const colonIdx = chainArg.indexOf(':');
            if (colonIdx === -1) {
              calls.push({ toolName: chainArg, params: {} });
            } else {
              const chainTool = chainArg.slice(0, colonIdx);
              const chainParams = JSON.parse(chainArg.slice(colonIdx + 1));
              calls.push({ toolName: chainTool, params: chainParams });
            }
          }

          const results = await callToolsChained(entry.transport, calls, authProvider);
          // Print each result separated by newline
          for (const r of results) {
            if (r) process.stdout.write(r + '\n');
          }
        } else {
          const result = await callTool(entry.transport, tool, params, authProvider);
          process.stdout.write(result);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
