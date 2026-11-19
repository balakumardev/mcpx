import { Command } from 'commander';
import chalk from 'chalk';
import { getServer } from '../config.js';
import { RuntimeAlreadyRunningError } from '../runtime-claim.js';
import { createRuntimeHostForServer, type RuntimeHost } from '../runtime-host.js';
import {
  getRuntimeStatus,
  listPersistentRuntimeStatuses,
  stopRuntimeDaemons,
} from '../runtime-manager.js';
import { resolveRuntimeConfig, type ResolvedRuntimeConfig } from '../runtime-config.js';
import { isValidServerName, quoteName, serverNameError } from '../server-name.js';

/** A name as it may be printed: a name that cannot be a server name came from a record, so it is shown escaped. */
function printable(name: string): string {
  return isValidServerName(name) ? name : quoteName(name);
}

/** The same, in quotes for use in a sentence. */
function quoted(name: string): string {
  return isValidServerName(name) ? `"${name}"` : quoteName(name);
}

function printRuntimeStatus(
  name: string,
  status: Awaited<ReturnType<typeof getRuntimeStatus>>,
  runtime?: ResolvedRuntimeConfig,
): void {
  console.log(chalk.bold(`\n${printable(name)}\n`));
  if (!status) {
    console.log(`  Running: ${chalk.yellow('no')}`);
    if (runtime) {
      console.log(`  Mode:    ${runtime.mode}`);
      console.log(`  Idle:    ${runtime.idleTimeoutSec}s`);
      console.log(`  Call:    ${runtime.callTimeoutSec}s`);
    }
    console.log();
    return;
  }

  console.log(`  Running: ${status.running ? chalk.green('yes') : chalk.yellow('no')}`);
  console.log(`  PID:     ${status.pid}`);
  console.log(`  Mode:    ${runtime?.mode ?? 'persistent'}`);
  console.log(`  Idle:    ${runtime?.idleTimeoutSec ?? status.idleTimeoutSec}s`);
  if (runtime) {
    console.log(`  Call:    ${runtime.callTimeoutSec}s`);
  }
  console.log(`  Started: ${status.startedAt}`);
  console.log(`  Last:    ${status.lastUsedAt}`);
  console.log(`  Socket:  ${status.socketPath}`);
  console.log(`  Log:     ${status.logPath}`);
  if (status.orphaned) {
    console.log(`  Config:  ${chalk.yellow('orphaned')} (no registered server has this name)`);
  } else if (status.configStatus) {
    console.log(`  Config:  ${status.configStatus}`);
  }
  if (status.otherPids?.length) {
    console.log(chalk.yellow(
      `  Warning: ${status.otherPids.length} more daemon process(es) are recorded for this server (pid ${status.otherPids.join(', ')}). `
      + `Run \`mcpkit runtime stop ${isValidServerName(name) ? name : JSON.stringify(name)}\` to stop them all.`,
    ));
  }
  console.log();
}

export function createRuntimeCommand(): Command {
  const runtime = new Command('runtime')
    .description('Manage persistent stdio runtimes');
  const hostCommand = new Command('_host')
    .argument('<name>', 'Server name to host')
    .action(async (name: string) => {
      let host: RuntimeHost | undefined;
      let stopRequested = false;
      // Registered before the MCP server is started, which can take seconds: a stop that arrives
      // meanwhile has to wind the host down properly, not kill it with the server half started.
      const shutdown = () => {
        stopRequested = true;
        void host?.close();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      try {
        host = await createRuntimeHostForServer(name);
      } catch (error) {
        if (!(error instanceof RuntimeAlreadyRunningError)) throw error;
        // Another host owns this server. It has been left alone; this one has nothing to do.
        console.log(`${new Date().toISOString()} ${error.message} This host is not needed and exits.`);
        process.exit(0);
      }
      if (stopRequested) void host.close();
      await host.waitUntilClosed();
      // Nothing is left to serve. Exit explicitly: when the MCP server died during a call, the SDK
      // keeps that call's timeout timer alive, which would hold this process for up to the call timeout.
      process.exit(0);
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
              // A name that cannot be a server name can still be the one in an orphaned runtime's record.
              const entry = isValidServerName(name) ? await getServer(name) : undefined;
              const status = await getRuntimeStatus(name, entry);
              if (!entry && !status) {
                console.error(chalk.red(
                  isValidServerName(name)
                    ? `Server "${name}" not found and no runtime metadata exists.`
                    : `${serverNameError(name)?.message} No runtime metadata exists under that name either.`,
                ));
                process.exit(1);
              }
              const runtime = entry?.transport.type === 'stdio'
                ? resolveRuntimeConfig(entry.runtime)
                : undefined;
              printRuntimeStatus(name, status && !entry ? { ...status, orphaned: true } : status, runtime);
              return;
            }

            const statuses = await listPersistentRuntimeStatuses();
            if (statuses.length === 0) {
              console.log(chalk.dim('No active persistent runtimes.'));
              return;
            }

            for (const status of statuses) {
              printRuntimeStatus(status.serverName, status);
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
            const { found, daemons, killed } = await stopRuntimeDaemons(name);
            if (!found) {
              if (!isValidServerName(name)) {
                console.error(chalk.red(`${serverNameError(name)?.message} No runtime is recorded under that name either.`));
                process.exit(1);
              }
              console.log(chalk.yellow(`No persistent runtime is active for "${name}".`));
              return;
            }
            // A name that is not a valid one reaches this point only through a record that carries it:
            // the orphaned daemon is stopped by the pid in that record.
            console.log(chalk.green(`✓ Stopped runtime for ${quoted(name)}`));
            if (daemons.length > 1) {
              console.log(chalk.yellow(
                `Warning: ${daemons.length} daemon processes were running for ${quoted(name)} (pid ${daemons.join(', ')}); all of them were stopped.`,
              ));
            }
            if (killed.length > 0) {
              console.log(chalk.yellow(
                `Warning: pid ${killed.join(', ')} did not exit when asked and was killed with its process group.`,
              ));
            }
          } catch (err) {
            console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
            process.exit(1);
          }
        }),
    )
    .addCommand(hostCommand, { hidden: true });

  return runtime;
}
