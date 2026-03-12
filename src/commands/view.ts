import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { stringify } from 'yaml';
import { getServer, getRegistryPath } from '../config.js';

export function createViewCommand(): Command {
  return new Command('view')
    .description('Show full config for a registered server')
    .argument('<name>', 'Server name to view')
    .option('--yaml', 'Output raw YAML for the entry')
    .addHelpText('after', `
Examples:
  $ mcpkit view github
  $ mcpkit view github --yaml`)
    .action(async (name: string, opts) => {
      try {
        const entry = await getServer(name);
        if (!entry) {
          console.error(chalk.red(`Server "${name}" not found.`));
          process.exit(1);
        }

        if (opts.yaml) {
          const content = await readFile(getRegistryPath(), 'utf-8');
          const registry = parse(content);
          console.log(stringify({ [name]: registry.servers[name] }).trim());
          return;
        }

        // Formatted output
        console.log(chalk.bold(`\n${name}\n`));

        if (entry.description) {
          console.log(`  ${chalk.dim(entry.description)}\n`);
        }

        // Transport
        console.log(chalk.blue('Transport'));
        console.log(`  Type:    ${entry.transport.type}`);

        if (entry.transport.type === 'stdio') {
          console.log(`  Command: ${entry.transport.command}`);
          if (entry.transport.args.length > 0) {
            console.log(`  Args:    ${entry.transport.args.join(' ')}`);
          }

          if (entry.transport.env && Object.keys(entry.transport.env).length > 0) {
            console.log(chalk.blue('\nEnv Vars'));
            for (const [key, value] of Object.entries(entry.transport.env)) {
              console.log(`  ${key}=${value}`);
            }
          }
        } else {
          console.log(`  URL:     ${entry.transport.url}`);

          if (entry.transport.headers && Object.keys(entry.transport.headers).length > 0) {
            console.log(chalk.blue('\nHeaders'));
            for (const [key, value] of Object.entries(entry.transport.headers)) {
              console.log(`  ${key}: ${value}`);
            }
          }
        }

        // Metadata
        console.log(chalk.blue('\nMetadata'));
        console.log(`  Tools:   ${entry.toolCount}`);
        console.log(`  Agents:  ${entry.agents.join(', ')}`);
        console.log(`  Created: ${entry.createdAt}`);
        console.log(`  Updated: ${entry.updatedAt}`);
        console.log();
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
