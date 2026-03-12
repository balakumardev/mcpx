import { Command } from 'commander';
import chalk from 'chalk';
import { getServer, addServer, removeServer } from '../config.js';

export function createEditCommand(): Command {
  return new Command('edit')
    .description('Modify config for a registered server')
    .argument('<name>', 'Server name to edit')
    .option('--env <KEY=VALUE>', 'Add/update an env var (stdio only)', collect, [])
    .option('--remove-env <KEY>', 'Remove an env var (stdio only)', collect, [])
    .option('--header <Key: Value>', 'Add/update a header (http/sse only)', collect, [])
    .option('--remove-header <KEY>', 'Remove a header (http/sse only)', collect, [])
    .option('--description <text>', 'Set server description')
    .option('--name <new-name>', 'Rename the server')
    .addHelpText('after', `
Examples:
  $ mcpkit edit github --env GITHUB_TOKEN=ghp_xxx
  $ mcpkit edit github --remove-env GITHUB_TOKEN
  $ mcpkit edit myapi --header "Authorization: Bearer tok_xxx"
  $ mcpkit edit myapi --description "My custom API server"
  $ mcpkit edit github --name gh`)
    .action(async (name: string, opts) => {
      try {
        const entry = await getServer(name);
        if (!entry) {
          console.error(chalk.red(`Server "${name}" not found.`));
          process.exit(1);
        }

        let changed = false;

        // --env KEY=VALUE
        for (const pair of opts.env as string[]) {
          if (!pair.includes('=')) {
            console.error(chalk.red(`Invalid env format "${pair}". Use KEY=VALUE.`));
            process.exit(1);
          }
          if (entry.transport.type !== 'stdio') {
            console.warn(chalk.yellow(`Warning: --env is only for stdio servers. "${name}" uses ${entry.transport.type}.`));
            continue;
          }
          const eqIdx = pair.indexOf('=');
          const key = pair.slice(0, eqIdx);
          const value = pair.slice(eqIdx + 1);
          entry.transport.env = entry.transport.env || {};
          entry.transport.env[key] = value;
          console.log(chalk.green(`✓ Set env ${key}`));
          changed = true;
        }

        // --remove-env KEY
        for (const key of opts.removeEnv as string[]) {
          if (entry.transport.type !== 'stdio') {
            console.warn(chalk.yellow(`Warning: --remove-env is only for stdio servers. "${name}" uses ${entry.transport.type}.`));
            continue;
          }
          if (entry.transport.env && key in entry.transport.env) {
            delete entry.transport.env[key];
            if (Object.keys(entry.transport.env).length === 0) {
              delete entry.transport.env;
            }
            console.log(chalk.green(`✓ Removed env ${key}`));
            changed = true;
          } else {
            console.warn(chalk.yellow(`Env var "${key}" not found.`));
          }
        }

        // --header "Key: Value"
        for (const raw of opts.header as string[]) {
          const colonIdx = raw.indexOf(':');
          if (colonIdx === -1) {
            console.error(chalk.red(`Invalid header format "${raw}". Use "Key: Value".`));
            process.exit(1);
          }
          if (entry.transport.type === 'stdio') {
            console.warn(chalk.yellow(`Warning: --header is only for http/sse servers. "${name}" uses stdio.`));
            continue;
          }
          const key = raw.slice(0, colonIdx).trim();
          const value = raw.slice(colonIdx + 1).trim();
          entry.transport.headers = entry.transport.headers || {};
          entry.transport.headers[key] = value;
          console.log(chalk.green(`✓ Set header ${key}`));
          changed = true;
        }

        // --remove-header KEY
        for (const key of opts.removeHeader as string[]) {
          if (entry.transport.type === 'stdio') {
            console.warn(chalk.yellow(`Warning: --remove-header is only for http/sse servers. "${name}" uses stdio.`));
            continue;
          }
          if (entry.transport.headers && key in entry.transport.headers) {
            delete entry.transport.headers[key];
            if (Object.keys(entry.transport.headers).length === 0) {
              delete entry.transport.headers;
            }
            console.log(chalk.green(`✓ Removed header ${key}`));
            changed = true;
          } else {
            console.warn(chalk.yellow(`Header "${key}" not found.`));
          }
        }

        // --description
        if (opts.description !== undefined) {
          entry.description = opts.description;
          console.log(chalk.green(`✓ Set description`));
          changed = true;
        }

        // --name (rename)
        const newName = opts.name as string | undefined;
        if (newName) {
          const existing = await getServer(newName);
          if (existing) {
            console.error(chalk.red(`Server "${newName}" already exists.`));
            process.exit(1);
          }
          await removeServer(name);
          entry.name = newName;
          entry.updatedAt = new Date().toISOString();
          await addServer(entry);
          console.log(chalk.green(`✓ Renamed "${name}" → "${newName}"`));
          return;
        }

        if (changed) {
          entry.updatedAt = new Date().toISOString();
          await addServer(entry);
        } else {
          console.log(chalk.yellow('No changes specified. Use --help to see options.'));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
