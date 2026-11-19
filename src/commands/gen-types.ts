import { writeFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { loadRegistry } from '../config.js';
import { getToolsForServer } from '../discover.js';
import { listSchemaCaches } from '../schema-store.js';
import { generateMcpTypes } from '../codegen/mcp-types.js';
import type { ServerTools } from '../codegen/mcp-types.js';
import { escapeControlChars, nearestNames, registeredServer, unknownServerMessage } from '../search-index.js';

/**
 * Collect the names of one `--tools` value. A value that names no tool, such as
 * `''` or `,`, is a usage error (exit 2): taken as an empty filter it would
 * print a declaration of nothing and look like success.
 */
function collectToolNames(value: string, previous: string[] = []): string[] {
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) {
    const error = new InvalidArgumentError('Expected one or more tool names, comma-separated, e.g. --tools create_issue,list_issues.');
    error.exitCode = 2;
    throw error;
  }
  return [...previous, ...names];
}

export function createTypesCommand(): Command {
  return new Command('types')
    .description('Print TypeScript declarations for the tools of registered servers')
    .argument('[server...]', 'Servers to include (default: every registered server that has a schema cache)')
    .option('--tools <names>', 'Only these tools, comma-separated (repeatable)', collectToolNames)
    .option('--out <file>', 'Write the declarations to a file instead of stdout')
    .addHelpText('after', `
Prints one .d.ts that declares \`mcp\`: mcp["<server>"].<tool>(args) returns a
Promise of the tool's output type (unknown when the tool declares no outputSchema).
This is the API available to scripts run with \`mcpkit exec\`.

Examples:
  $ mcpkit types github
  $ mcpkit types github --tools create_issue,list_issues
  $ mcpkit types --out mcp.d.ts`)
    .action(async (serverArgs: string[], options: { tools?: string[]; out?: string }) => {
      try {
        const registry = await loadRegistry();
        const registered = Object.keys(registry.servers);
        const explicit = [...new Set(serverArgs)];

        const unknown = explicit.filter((name) => !registeredServer(registry.servers, name));
        if (unknown.length > 0) {
          for (const name of unknown) console.error(chalk.red(unknownServerMessage(name, registered)));
          process.exitCode = 1;
          return;
        }

        let servers: ServerTools[] = [];
        if (explicit.length > 0) {
          for (const name of explicit) {
            try {
              servers.push({ server: name, tools: (await getToolsForServer(registry.servers[name])).tools });
            } catch (err) {
              console.error(chalk.red(`Could not load the tools of "${escapeControlChars(name)}": ${err instanceof Error ? err.message : err}`));
              process.exitCode = 1;
              return;
            }
          }
        } else {
          // Never connect to a server unasked: only cached schemas are used here.
          const caches = new Map((await listSchemaCaches()).map((cache) => [cache.server, cache]));
          const uncached: string[] = [];
          for (const name of registered) {
            const cache = caches.get(name);
            if (cache) servers.push({ server: name, tools: cache.tools });
            else uncached.push(name);
          }
          if (uncached.length > 0) {
            console.error(chalk.dim(
              `Not included, no schema cache: ${uncached.join(', ')}. Run \`mcpkit update <server>\` or name the server explicitly.`,
            ));
          }
          if (servers.length === 0) {
            console.error(chalk.red(registered.length === 0
              ? 'No servers registered. Run `mcpkit install <server>` to add one.'
              : 'No server has a schema cache. Run `mcpkit update <server>` to fetch one, or name a server explicitly.'));
            process.exitCode = 1;
            return;
          }
        }

        if (options.tools) {
          const wanted = new Set(options.tools);
          const available = servers.flatMap((entry) => entry.tools.map((tool) => tool.name));
          const missing = [...wanted].filter((name) => !available.includes(name));
          if (missing.length > 0) {
            for (const name of missing) {
              const nearest = nearestNames(name, [...new Set(available)]);
              console.error(chalk.red(`Tool "${escapeControlChars(name)}" not found.${nearest.length > 0 ? ` Nearest: ${nearest.map(escapeControlChars).join(', ')}.` : ''}`));
            }
            process.exitCode = 1;
            return;
          }
          servers = servers
            .map((entry) => ({ server: entry.server, tools: entry.tools.filter((tool) => wanted.has(tool.name)) }))
            .filter((entry) => entry.tools.length > 0);
        }

        const declarations = generateMcpTypes(servers);
        if (options.out) {
          await writeFile(options.out, declarations, 'utf-8');
          const toolCount = servers.reduce((sum, entry) => sum + entry.tools.length, 0);
          console.error(chalk.dim(`Wrote ${toolCount} tool declarations for ${servers.length} server(s) to ${options.out}`));
          return;
        }
        console.log(declarations.trimEnd());
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exitCode = 1;
      }
    });
}
