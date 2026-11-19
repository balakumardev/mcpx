import { Command } from 'commander';
import chalk from 'chalk';
import { getServer } from '../config.js';
import { callTool, callToolsChained, connectToolSession } from '../client.js';
import type { ToolCall, ToolCallOutput } from '../client.js';
import { authenticateIfNeeded } from '../auth.js';
import { isPersistentRuntimeEntry } from '../runtime-config.js';
import { callPersistentRuntime } from '../runtime-manager.js';
import { maybeAutoRefresh } from '../auto-refresh.js';
import { escapeControlChars } from '../search-index.js';

const KEEPALIVE_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type SignalSource = Pick<NodeJS.Process, 'on' | 'off'>;
type StderrWriter = Pick<NodeJS.WriteStream, 'write'>;

/** The command line is wrong (exit status 2), as opposed to the server or the tool failing (exit status 1). */
class UsageError extends Error {}

const PARAMS_USAGE = `Usage: mcpkit call <server> <tool> '{"key":"value"}'`;
const CHAIN_USAGE = `Usage: --chain 'tool:{"key":"value"}'`;

/** How a JSON value that is not an object is named in a message, without echoing it back: params can hold a token. */
function describeJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** `text` parsed as a JSON object. Anything else is a usage error, found before any server is contacted. */
function parseParamsObject(text: string, subject: string, usage: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // The engine's message quotes part of the text it could not parse, and that may be a token: keep only where it went wrong.
    const position = /at position (\d+)/.exec(err instanceof Error ? err.message : '')?.[1];
    throw new UsageError(`${subject} are not valid JSON${position ? ` (at position ${position})` : ''}. ${usage}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${subject} must be a JSON object, but are ${describeJsonValue(parsed)}. ${usage}`);
  }
  return parsed as Record<string, unknown>;
}

function buildCalls(tool: string, params: Record<string, unknown>, chainArgs?: string[]): ToolCall[] {
  const calls: ToolCall[] = [{ toolName: tool, params }];
  if (!chainArgs || chainArgs.length === 0) return calls;

  for (const chainArg of chainArgs) {
    const colonIdx = chainArg.indexOf(':');
    if (colonIdx === -1) {
      calls.push({ toolName: chainArg, params: {} });
    } else {
      const chainTool = chainArg.slice(0, colonIdx);
      const subject = `Params of chain step ${calls.length + 1} ("${escapeControlChars(chainTool)}")`;
      calls.push({ toolName: chainTool, params: parseParamsObject(chainArg.slice(colonIdx + 1), subject, CHAIN_USAGE) });
    }
  }

  return calls;
}

/** The message for the first call the server flagged `isError`, or undefined when all succeeded. */
function toolFailureMessage(calls: ToolCall[], outputs: ToolCallOutput[]): string | undefined {
  const index = outputs.findIndex((output) => output.isError);
  if (index === -1) return undefined;
  const step = calls.length > 1 ? ` (step ${index + 1} of ${calls.length})` : '';
  return `Tool "${calls[index].toolName}"${step} returned an error: ${outputs[index].text || '(no message)'}`;
}

/**
 * Print the outputs of a finished call or chain. A failed call prints nothing
 * on stdout and throws, so the action's handler reports it on stderr and exits 1.
 */
function writeResults(calls: ToolCall[], outputs: ToolCallOutput[], json: boolean): void {
  const failure = toolFailureMessage(calls, outputs);
  if (failure) throw new Error(failure);

  const isChained = calls.length > 1;
  if (json) {
    const values = outputs.map((output) => output.value ?? null);
    process.stdout.write(`${JSON.stringify(isChained ? values : values[0])}\n`);
    return;
  }

  if (isChained) {
    for (const { text } of outputs) {
      if (text) process.stdout.write(text + '\n');
    }
  } else {
    process.stdout.write(outputs[0]?.text ?? '');
  }
  noteOmittedParts(outputs);
}

/**
 * Plain output is the text of the result. When a result also holds images,
 * audio or resources (or holds nothing else), one stderr line per kind says what
 * was left out and how to get it; stdout never carries them. A persistent runtime
 * sends `omitted` along with the result, so both paths note the same things.
 */
function noteOmittedParts(outputs: ToolCallOutput[]): void {
  outputs.forEach((output, index) => {
    const step = outputs.length > 1 ? ` (step ${index + 1} of ${outputs.length})` : '';
    for (const description of output.omitted ?? []) {
      console.error(`[omitted${step}: ${escapeControlChars(description)}; use --json or mcpkit exec]`);
    }
  });
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
    .option('--json', 'Print the result as one JSON value: the structured content, else the text parsed as JSON when it is valid JSON, else the text as a JSON string. With --chain, a JSON array with one value per call.')
    .addHelpText('after', `
Examples:
  Basic calls:
  $ mcpkit call github list_repos '{"owner":"octocat"}'
  $ mcpkit call weather get_forecast '{"city":"London"}'
  $ mcpkit call postman list_collections '{}'    # OAuth tokens used automatically
  $ mcpkit call github list_repos '{"owner":"octocat"}' --json    # machine-readable result

Exit status:
  0 on success. 1 when the server is unknown or cannot be reached, or the tool reports an error
  (its message goes to stderr, nothing to stdout). 2 when the params (or the params of a --chain
  call) are not a JSON object: nothing is connected. A chain stops at the first failed call and
  prints nothing on stdout.

Output:
  Plain output is the text of the result. Images, audio and resources are never printed, whatever else the result holds: one stderr line, [omitted: ...], names each kind left out.
  With --json, a result with non-text parts (images, resources) prints as {"content":[...]} holding the raw parts.

A tool name that starts with a dash needs -- in front of it, with options before the --:
  $ mcpkit call <server> -- <tool> '{}'

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
    .action(async (server: string, tool: string, paramsStr: string, opts: { chain?: string[]; keepalive?: boolean; json?: boolean }) => {
      try {
        // Everything wrong with the command line is found before any server is contacted.
        const params = parseParamsObject(paramsStr, 'Params', PARAMS_USAGE);
        const calls = buildCalls(tool, params, opts.chain);
        const isChained = calls.length > 1;
        const json = opts.json === true;

        const entry = await getServer(server);
        if (!entry) {
          console.error(chalk.red(`Server "${server}" not found. Run 'mcpkit list' to see registered servers.`));
          process.exit(1);
        }

        // For dynamic servers: refresh the skill snapshot if stale (or nudge to
        // update). Best-effort — never blocks or fails the call below.
        await maybeAutoRefresh(entry);

        if (opts.keepalive && entry.transport.type !== 'stdio') {
          throw new Error('--keepalive is only supported for stdio transports');
        }

        // If OAuth, authenticate first
        const authProvider = (entry.transport.type === 'http' || entry.transport.type === 'sse') && entry.transport.auth === 'oauth'
          ? await authenticateIfNeeded(entry.transport.url, entry.transport.oauth)
          : undefined;

        if (opts.keepalive) {
          const session = await connectToolSession(entry.transport, authProvider, entry.paramProvider, entry.envHints);
          try {
            const outputs = isChained
              ? await session.callToolsChained(calls)
              : [await session.callTool(tool, params)];
            writeResults(calls, outputs, json);
            await waitForKeepAliveShutdown(() => session.close());
          } finally {
            await session.close();
          }
        } else if (isPersistentRuntimeEntry(entry)) {
          writeResults(calls, await callPersistentRuntime(server, entry, calls), json);
        } else if (isChained) {
          const outputs = await callToolsChained(entry.transport, calls, authProvider, entry.paramProvider, entry.envHints);
          writeResults(calls, outputs, json);
        } else {
          const output = await callTool(entry.transport, tool, params, authProvider, entry.paramProvider, entry.envHints);
          writeResults(calls, [output], json);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(err instanceof UsageError ? 2 : 1);
      }
    });
}
