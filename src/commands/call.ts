import { Command } from 'commander';
import chalk from 'chalk';
import { getServer } from '../config.js';
import { callTool, callToolsChained, connectToolSession } from '../client.js';
import type { ToolCall } from '../client.js';
import { authenticateIfNeeded } from '../auth.js';
import { isPersistentRuntimeEntry } from '../runtime-config.js';
import { callPersistentRuntime } from '../runtime-manager.js';

const KEEPALIVE_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type SignalSource = Pick<NodeJS.Process, 'on' | 'off'>;
type StderrWriter = Pick<NodeJS.WriteStream, 'write'>;

function buildCalls(tool: string, params: Record<string, unknown>, chainArgs?: string[]): ToolCall[] {
  const calls: ToolCall[] = [{ toolName: tool, params }];
  if (!chainArgs || chainArgs.length === 0) return calls;

  for (const chainArg of chainArgs) {
    const colonIdx = chainArg.indexOf(':');
    if (colonIdx === -1) {
      calls.push({ toolName: chainArg, params: {} });
    } else {
      const chainTool = chainArg.slice(0, colonIdx);
      const chainParams = JSON.parse(chainArg.slice(colonIdx + 1)) as Record<string, unknown>;
      calls.push({ toolName: chainTool, params: chainParams });
    }
  }

  return calls;
}

function writeResults(results: string[], isChained: boolean): void {
  if (isChained) {
    for (const result of results) {
      if (result) process.stdout.write(result + '\n');
    }
    return;
  }

  process.stdout.write(results[0] ?? '');
}

export async function waitForKeepAliveShutdown(
  close: () => Promise<void>,
  options: {
    signalSource?: SignalSource;
    stderr?: StderrWriter;
  } = {},
): Promise<void> {
  const signalSource = options.signalSource ?? process;
  const stderr = options.stderr ?? process.stderr;
  stderr.write('Persistent stdio session active. Press Ctrl+C to stop.\n');

  let closing: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => {
    closing ??= Promise.resolve().then(close);
    return closing;
  };

  return new Promise<void>((resolve, reject) => {
    const onSignal = () => {
      unregister();
      closeOnce().then(resolve, reject);
    };

    const unregister = () => {
      for (const signal of KEEPALIVE_SIGNALS) {
        signalSource.off(signal, onSignal);
      }
    };

    for (const signal of KEEPALIVE_SIGNALS) {
      signalSource.on(signal, onSignal);
    }
  });
}

export function createCallCommand(): Command {
  return new Command('call')
    .description('Call a tool on a registered MCP server')
    .argument('<server>', 'Registered server name')
    .argument('<tool>', 'Tool name exposed by that server')
    .argument('[params]', 'Tool arguments as a JSON object', '{}')
    .option('--chain <calls...>', 'Run additional tool calls in the same MCP session. Format: "tool_name:{}" or "tool_name:{\\"key\\":\\"val\\"}". Use $prev.field to reference fields from the previous JSON result.')
    .option('--keepalive', 'Keep a stdio server session alive after the call until interrupted with Ctrl+C')
    .addHelpText('after', `
Examples:
  Basic calls:
  $ mcpkit call github list_repos '{"owner":"octocat"}'
  $ mcpkit call weather get_forecast '{"city":"London"}'
  $ mcpkit call postman list_collections '{}'    # OAuth tokens used automatically

Session notes:
  By default, each call connects, runs the tool, prints the result, and disconnects.
  Servers configured with runtime mode "persistent" are auto-started and reused in the background.
  Use --chain to run multiple tool calls in one CLI session.
  Use --keepalive to leave a stdio server running after the call as a manual blocking session.

Chained calls (single session, useful for login/session-based servers):
  $ mcpkit call myserver login '{}' --chain 'search:{"query":"hello","token":"$prev.token"}'

Persistent stdio session (leaves the local MCP server process running until Ctrl+C):
  $ mcpkit call browsermcp create_session '{}' --keepalive

  $prev.field references are substituted with values from the previous call's JSON output.
  Non-JSON output is available as $prev._text.`)
    .action(async (server: string, tool: string, paramsStr: string, opts: { chain?: string[]; keepalive?: boolean }) => {
      try {
        const entry = await getServer(server);
        if (!entry) {
          console.error(chalk.red(`Server "${server}" not found. Run 'mcpkit list' to see registered servers.`));
          process.exit(1);
        }

        if (opts.keepalive && entry.transport.type !== 'stdio') {
          throw new Error('--keepalive is only supported for stdio transports');
        }

        // If OAuth, authenticate first
        const authProvider = (entry.transport.type === 'http' || entry.transport.type === 'sse') && entry.transport.auth === 'oauth'
          ? await authenticateIfNeeded(entry.transport.url, entry.transport.oauth)
          : undefined;

        const params = JSON.parse(paramsStr) as Record<string, unknown>;
        const calls = buildCalls(tool, params, opts.chain);
        const isChained = calls.length > 1;

        if (opts.keepalive) {
          const session = await connectToolSession(entry.transport, authProvider, entry.paramProvider);
          try {
            const results = isChained
              ? await session.callToolsChained(calls)
              : [await session.callTool(tool, params)];
            writeResults(results, isChained);
            await waitForKeepAliveShutdown(() => session.close());
          } finally {
            await session.close();
          }
        } else if (isPersistentRuntimeEntry(entry)) {
          const results = await callPersistentRuntime(server, entry, calls);
          writeResults(results, isChained);
        } else if (isChained) {
          const results = await callToolsChained(entry.transport, calls, authProvider, entry.paramProvider);
          writeResults(results, true);
        } else {
          const result = await callTool(entry.transport, tool, params, authProvider, entry.paramProvider);
          writeResults([result], false);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
