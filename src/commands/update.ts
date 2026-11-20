import { Command } from 'commander';
import chalk from 'chalk';
import { getServer, listServers } from '../config.js';
import { refreshServer } from '../auto-refresh.js';
import { writeMetaSkill } from '../meta-skill.js';
import { OAuthRequiredError } from '../oauth-required-error.js';
import { scrubSecrets } from '../sandbox/redact.js';
import type { AgentType, ServerEntry } from '../types.js';

/** First line of an error message, without the server's credentials: stack-like detail from a transport would break the one-line-per-server report. */
function summarizeFailure(entry: ServerEntry, err: unknown): string {
  const message = scrubSecrets(entry, err instanceof Error ? err.message : String(err));
  return message.split('\n')[0].trim() || 'unknown error';
}

export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Re-discover tools and regenerate skill files')
    .argument('[name]', 'Server name (omit to update all)')
    .addHelpText('after', `
One server being unreachable does not stop the others: every server is tried, each gets one result
line, and the exit code is 1 when any of them failed. A server that fails keeps the skill files,
schema cache and registry entry it had.

Without a name, update never opens a browser: an OAuth server that has no saved sign-in is skipped
with a note to run \`mcpkit auth <server>\`. A skipped server is not a failure (it does not change the
exit code). With a name, update may open the browser to sign in to that server.

Examples:
  $ mcpkit update                Update all servers
  $ mcpkit update github         Update a specific server`)
    .action(async (name?: string) => {
      try {
        const servers = name ? [await getServer(name)].filter((entry): entry is ServerEntry => entry !== undefined) : await listServers();

        if (servers.length === 0) {
          if (name) {
            console.error(chalk.red(`Server "${name}" not found. Run 'mcpkit list' to see registered servers.`));
            process.exit(1);
          }
          console.log(chalk.yellow('No servers registered. Run `mcpkit install <server>` to add one.'));
          return;
        }

        const metaAgents = new Set<AgentType>();
        const failed: string[] = [];
        const needSignIn: string[] = [];
        for (const entry of servers) {
          console.log(chalk.blue(`Updating ${entry.name}...`));
          try {
            // Discovery happens before anything is written, so a server that cannot be reached
            // leaves its skill files, schema cache and registry entry exactly as they were.
            // A named server is a request to work on that one, so it may sign in through the
            // browser; updating all of them never does.
            const { toolCount, agents } = await refreshServer(entry, { logPrefix: '  ', quiet: true, interactiveAuth: name !== undefined });
            console.log(chalk.green(`  ✓ ${entry.name}: ${toolCount} tool(s)`));
            for (const agent of agents) metaAgents.add(agent);
          } catch (err) {
            if (err instanceof OAuthRequiredError) {
              console.warn(chalk.yellow(`  ⚠ ${entry.name}: needs sign-in (mcpkit auth ${entry.name}); skipped`));
              needSignIn.push(entry.name);
              continue;
            }
            console.error(chalk.red(`  ✗ ${entry.name}: ${summarizeFailure(entry, err)}`));
            failed.push(entry.name);
          }
        }

        // Refresh the mcpkit-cli meta-skill for every agent the refreshed servers target.
        if (metaAgents.size > 0) {
          await writeMetaSkill({ agents: [...metaAgents], scope: 'global', logPrefix: '  ' });
        }

        const skippedNote = needSignIn.length > 0 ? `; ${needSignIn.length} skipped, needs sign-in: ${needSignIn.join(', ')}` : '';
        const updated = servers.length - failed.length - needSignIn.length;
        if (failed.length === 0) {
          console.log(chalk.green(needSignIn.length === 0
            ? `\n✓ Updated ${servers.length} server(s)`
            : `\n✓ Updated ${updated} of ${servers.length} server(s)${skippedNote}`));
          return;
        }
        console.error(chalk.red(`\nUpdated ${updated} of ${servers.length} server(s); ${failed.length} failed: ${failed.join(', ')}${skippedNote}`));
        process.exit(1);
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
