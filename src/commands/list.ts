import { Command } from 'commander';
import chalk from 'chalk';
import { listServers, getServer } from '../config.js';
import { discoverForEntry } from '../discover.js';
import { trySaveSchemaCache } from '../schema-store.js';
import { loadAgentSettings, resolveServerAgents } from '../agent-config.js';
import { maskCommandLine, maskEntryForDisplay, maskUrl } from '../redact-config.js';
import { scrubSecrets } from '../sandbox/redact.js';
import type { ServerEntry } from '../types.js';

export function createListCommand(): Command {
  return new Command('list')
    .description('List registered servers or tools on a server')
    .argument('[server]', 'Server name to show tools for')
    .option('--json', 'Print JSON instead of text')
    .addHelpText('after', `
Examples:
  $ mcpkit list                  List all registered servers
  $ mcpkit list --json           The same as JSON
  $ mcpkit list github           Show tools for a specific server

Secrets in a server's command, arguments, URL, environment and headers are masked
(<redacted len=N>). Use \`mcpkit view <server> --reveal\` to see one in clear text.`)
    .action(async (server: string | undefined, opts: { json?: boolean }) => {
      // The server whose tools are listed, so that an error never quotes its credentials.
      let registered: ServerEntry | undefined;
      try {
        if (server) {
          // Show tools for a specific server
          const entry = await getServer(server);
          if (!entry) {
            console.error(chalk.red(`Server "${server}" not found. Run 'mcpkit list' to see registered servers.`));
            process.exit(1);
          }
          registered = entry;

          // JSON mode keeps stdout parseable: progress goes to stderr.
          (opts.json ? console.error : console.log)(chalk.blue(`Connecting to ${server}...`));
          const { tools, serverMeta } = await discoverForEntry(entry, { interactiveAuth: true });
          // The live listing is fresh data: keep the offline schema cache in step with it.
          await trySaveSchemaCache(entry.name, tools);
          if (opts.json) {
            console.log(JSON.stringify(tools, null, 2));
            return;
          }
          console.log(chalk.bold(`\nTools on ${serverMeta.name || server} (${tools.length}):\n`));

          for (const tool of tools) {
            console.log(`  ${chalk.bold(tool.name)}`);
            if (tool.description) console.log(`    ${chalk.dim(tool.description)}`);
          }
        } else {
          // Show all registered servers
          const settings = await loadAgentSettings();
          const servers = await listServers();
          if (opts.json) {
            // Entries as `view --json` prints them: the registry's own fields, secrets masked, agents as resolved.
            console.log(JSON.stringify(servers.map((s) => {
              const resolved = resolveServerAgents(s, settings);
              return { ...maskEntryForDisplay(s), agents: resolved.agents, agentSelectionMode: resolved.selectionMode };
            }), null, 2));
            return;
          }
          if (servers.length === 0) {
            console.log(chalk.yellow('No servers registered. Run `mcpkit install <server>` to add one.'));
            return;
          }

          console.log(chalk.bold(`\nRegistered servers (${servers.length}):\n`));

          for (const s of servers) {
            const resolved = resolveServerAgents(s, settings);
            const transport = s.transport.type === 'stdio'
              ? maskCommandLine(s.transport.command, s.transport.args)
              : maskUrl(s.transport.url);
            console.log(`  ${chalk.bold(s.name)} (${s.transport.type})`);
            console.log(`    Tools: ${s.toolCount} | Agents: ${resolved.agents.join(', ')} (${resolved.selectionMode})`);
            console.log(`    ${chalk.dim(transport)}`);
            console.log();
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${registered ? scrubSecrets(registered, message) : message}`));
        process.exit(1);
      }
    });
}
