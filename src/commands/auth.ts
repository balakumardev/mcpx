import { Command } from 'commander';
import chalk from 'chalk';
import { getServer } from '../config.js';
import { authenticateIfNeeded, clearCredentials, hasValidTokens } from '../auth.js';

export function createAuthCommand(): Command {
  return new Command('auth')
    .description('Manage OAuth authentication for a server')
    .argument('<name>', 'Server name')
    .option('--status', 'Check authentication status')
    .option('--reset', 'Clear cached tokens and re-authenticate')
    .addHelpText('after', `
Examples:
  $ mcpkit auth linear              # Run OAuth flow
  $ mcpkit auth linear --status     # Check if authenticated
  $ mcpkit auth linear --reset      # Clear tokens and re-authenticate`)
    .action(async (name: string, opts) => {
      try {
        const entry = await getServer(name);
        if (!entry) {
          console.error(chalk.red(`Server "${name}" not found.`));
          process.exit(1);
        }

        if (entry.transport.type === 'stdio') {
          console.error(chalk.red('OAuth is only supported for http/sse servers.'));
          process.exit(1);
        }

        if (entry.transport.auth !== 'oauth') {
          console.error(chalk.red(`Server "${name}" does not have OAuth enabled. Use: mcpkit edit ${name} --auth oauth`));
          process.exit(1);
        }

        const serverUrl = entry.transport.url;

        if (opts.status) {
          const valid = await hasValidTokens(serverUrl);
          if (valid) {
            console.log(chalk.green(`✓ Server "${name}" is authenticated.`));
          } else {
            console.log(chalk.yellow(`Server "${name}" is not authenticated.`));
          }
          return;
        }

        if (opts.reset) {
          await clearCredentials(serverUrl);
          console.log(chalk.green(`✓ Cleared cached tokens for "${name}".`));
        }

        console.log(chalk.blue(`Starting OAuth flow for "${name}"...`));
        console.log(chalk.dim('A browser window will open for authorization.\n'));

        await authenticateIfNeeded(serverUrl);
        console.log(chalk.green(`✓ Successfully authenticated with "${name}".`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
