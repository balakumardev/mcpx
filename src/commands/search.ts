import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { loadRegistry } from '../config.js';
import { getToolsForServer } from '../discover.js';
import { listSchemaCaches } from '../schema-store.js';
import { JSON_DESCRIPTION_MAX, firstSentence, formatHit, hitServers, jsonLine, registeredServer, searchTools, unknownServerMessage } from '../search-index.js';
import type { IndexedTool } from '../search-index.js';

const DEFAULT_LIMIT = 15;

function parseLimit(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return Number(value);
}

export function createSearchCommand(): Command {
  return new Command('search')
    .description('Search tools across registered servers (offline, from the schema cache)')
    .argument('<query...>', 'Keywords to look for in tool names, titles and descriptions')
    .option('--server <name>', 'Only search this server (fetches and caches its tools if needed)')
    .option('--limit <n>', 'Maximum number of results', parseLimit, DEFAULT_LIMIT)
    .option('--no-collapse', 'List the same tool on several servers separately instead of once')
    .option('--json', 'Print the results as JSON')
    .addHelpText('after', `
Results are "server.tool - summary" lines, best match first. A tool name given
exactly (any case, "get_task", "getTask", "ticktick.get_task") always comes first.
Words match their other forms (uploading finds upload) and, from three letters,
the start of longer words. Without --server only servers with a schema cache
are searched (mcpkit install/update fill it).

A tool that several servers have identically (same name, description and schema)
is listed once and names every one of those servers equally:
  GMAIL_GET_PROFILE on work, personal - Get the profile of the account.
    same tool on 2 servers: work = <start of its description>; personal = ...
Two registrations of one MCP server can be different accounts: pick the server
from its description, never by position. --json adds "alsoIn" and a "servers"
array ({server, description?}) to such hits. Use --no-collapse to list every copy.

Examples:
  $ mcpkit search create issue
  $ mcpkit search pull request --server github --limit 5
  $ mcpkit describe github create_issue   Then read the full schema of a hit`)
    .action(async (queryWords: string[], options: { server?: string; limit: number; collapse: boolean; json?: boolean }) => {
      try {
        const registry = await loadRegistry();
        const registered = Object.keys(registry.servers);
        const entries: IndexedTool[] = [];

        if (options.server) {
          const entry = registeredServer(registry.servers, options.server);
          if (!entry) {
            console.error(chalk.red(unknownServerMessage(options.server, registered)));
            process.exitCode = 1;
            return;
          }
          const { tools } = await getToolsForServer(entry);
          entries.push(...tools.map((tool) => ({ server: options.server as string, tool })));
        } else {
          const caches = new Map((await listSchemaCaches()).map((cache) => [cache.server, cache]));
          const uncached: string[] = [];
          for (const name of registered) {
            const cache = caches.get(name);
            if (cache) entries.push(...cache.tools.map((tool) => ({ server: name, tool })));
            else uncached.push(name);
          }
          if (uncached.length > 0) {
            console.error(chalk.dim(
              `Not searched, no schema cache: ${uncached.join(', ')}. Run \`mcpkit update <server>\` or search with --server <name>.`,
            ));
          }
        }

        const hits = searchTools(entries, queryWords.join(' '), options.limit, { collapse: options.collapse });
        if (options.json) {
          console.log(jsonLine(hits.map((hit) => ({
            server: hit.server,
            tool: hit.tool.name,
            score: hit.score,
            summary: firstSentence(hit.tool.description),
            ...(hit.alsoIn.length > 0 ? { alsoIn: hit.alsoIn, servers: hitServers(hit, registry.servers, JSON_DESCRIPTION_MAX) } : {}),
          }))));
          return;
        }
        for (const hit of hits) for (const line of formatHit(hit, registry.servers)) console.log(line);
        if (hits.length === 0) console.error(chalk.dim('No tools matched.'));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exitCode = 1;
      }
    });
}
