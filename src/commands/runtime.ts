import { Command } from 'commander';
import chalk from 'chalk';
import { getServer } from '../config.js';
import { createRuntimeHostForServer } from '../runtime-host.js';
import {
  getRuntimeStatus,
  listPersistentRuntimeStatuses,
  stopRuntime,
} from '../runtime-manager.js';
import { resolveRuntimeConfig } from '../runtime-config.js';

function printRuntimeStatus(name: string, status: Awaited<ReturnType<typeof getRuntimeStatus>>, configuredMode?: string): void {
  console.log(chalk.bold(`\n${name}\n`));
  if (!status) {
    console.log(`  Running: ${chalk.yellow('no')}`);
    if (configuredMode) {
      console.log(`  Mode:    ${configuredMode}`);
    }
    console.log();
    return;
  }

  console.log(`  Running: ${status.running ? chalk.green('yes') : chalk.yellow('no')}`);
  console.log(`  PID:     ${status.pid}`);
  console.log(`  Mode:    ${configuredMode ?? 'persistent'}`);
  console.log(`  Idle:    ${status.idleTimeoutSec}s`);
  console.log(`  Started: ${status.startedAt}`);
  console.log(`  Last:    ${status.lastUsedAt}`);
  console.log(`  Socket:  ${status.socketPath}`);
  console.log(`  Log:     ${status.logPath}`);
  if (status.configStatus) {
    console.log(`  Config:  ${status.configStatus}`);
  }
  console.log();
}

export function createRuntimeCommand(): Command {
  const runtime = new Command('runtime')
    .description('Manage persistent stdio runtimes');
  const hostCommand = new Command('_host')
    .argument('<name>', 'Server name to host')
    .action(async (name: string) => {
      const host = await createRuntimeHostForServer(name);
      const shutdown = () => {
        void host.close();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await host.waitUntilClosed();
    });

  runtime
    .addCommand(
      new Command('status')
        .description('Show status for one or all persistent runtimes')
        .argument('[name]', 'Server name to inspect')
        .addHelpText('after', `
Examples:
  $ mcpkit runtime status
  $ mcpkit runtime status browsermcp`)
        .action(async (name?: string) => {
          try {
            if (name) {
              const entry = await getServer(name);
              const status = await getRuntimeStatus(name, entry);
              if (!entry && !status) {
                console.error(chalk.red(`Server "${name}" not found and no runtime metadata exists.`));
                process.exit(1);
              }
              const mode = entry?.transport.type === 'stdio'
                ? resolveRuntimeConfig(entry.runtime).mode
                : undefined;
              printRuntimeStatus(name, status, mode);
              return;
            }

            const statuses = await listPersistentRuntimeStatuses();
            if (statuses.length === 0) {
              console.log(chalk.dim('No active persistent runtimes.'));
              return;
            }

            for (const status of statuses) {
              printRuntimeStatus(status.serverName, status, 'persistent');
            }
          } catch (err) {
            console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
            process.exit(1);
          }
        }),
    )
    .addCommand(
      new Command('stop')
        .description('Stop a persistent runtime and remove its runtime metadata')
        .argument('<name>', 'Server name to stop')
        .addHelpText('after', `
Examples:
  $ mcpkit runtime stop browsermcp`)
        .action(async (name: string) => {
          try {
            const stopped = await stopRuntime(name);
            if (!stopped) {
              console.log(chalk.yellow(`No persistent runtime is active for "${name}".`));
              return;
            }
            console.log(chalk.green(`✓ Stopped runtime for "${name}"`));
          } catch (err) {
            console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
            process.exit(1);
          }
        }),
    )
    .addCommand(hostCommand, { hidden: true });

  return runtime;
}
