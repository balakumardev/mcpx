import { readFile, stat } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { loadRegistry } from '../config.js';
import { loadSchemaCache } from '../schema-store.js';
import { nearestNames } from '../sandbox/broker.js';
import { emptyAllowWarnings, parseAllowPatterns, resolveAllowPatterns, type AllowRule } from '../sandbox/gate.js';
import { defaultHostDeps, runExec, type ExecEnvelope } from '../sandbox/host.js';
import {
  DEFAULT_LIMITS,
  MAX_CALLS_CEILING,
  MAX_CODE_BYTES,
  MAX_MEMORY_MB,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  MIN_MEMORY_MB,
  MIN_OUTPUT_BYTES,
  MIN_TIMEOUT_MS,
  type SandboxLimits,
} from '../sandbox/limits.js';
import { createProcessWatch } from '../sandbox/reaper.js';

interface ExecOptions {
  code?: string;
  allow?: string[];
  allowReadOnly?: boolean;
  allowWrites?: boolean;
  timeout: number;
  maxCalls: number;
  maxOutput: number;
  memoryMb: number;
}

function integerOption(min: number, max?: number): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
      throw new InvalidArgumentError(
        max === undefined ? `expected an integer of at least ${min}` : `expected an integer from ${min} to ${max}`,
      );
    }
    return parsed;
  };
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Usage errors exit 2 and print nothing on stdout, so 1 always means "the script ran and failed". */
function usageError(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_CODE_BYTES) throw new Error(`the script on stdin is larger than ${MAX_CODE_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readScript(file: string | undefined, code: string | undefined): Promise<string> {
  const text = await readScriptText(file, code);
  // An empty script is almost always a mistake (an unset variable piped in, a missing file argument).
  if (text.trim() === '') throw new Error("the script is empty: give a script file, '-' to read it from stdin, or --code <js>");
  return text;
}

async function readScriptText(file: string | undefined, code: string | undefined): Promise<string> {
  if (file !== undefined && code !== undefined) {
    throw new Error('give either a script file or --code, not both');
  }
  if (code !== undefined) {
    if (Buffer.byteLength(code, 'utf-8') > MAX_CODE_BYTES) throw new Error(`the script is larger than ${MAX_CODE_BYTES} bytes`);
    return code;
  }
  if (file === undefined) {
    throw new Error("give a script file, '-' to read the script from stdin, or --code <js>");
  }
  if (file === '-') return readStdin();

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    throw new Error(`cannot read the script "${file}": ${(error as Error).message}`);
  }
  if (size > MAX_CODE_BYTES) throw new Error(`the script "${file}" is larger than ${MAX_CODE_BYTES} bytes`);
  return readFile(file, 'utf-8');
}

/** Characters that end a line for some readers (Python's splitlines) though JSON.stringify leaves them raw. */
const LINE_BREAKS = new RegExp(`[${[0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code)).join('')}]`, 'g');

/** The envelope as one line of JSON for every reader: U+0085, U+2028 and U+2029 are written as \uXXXX escapes. */
export function envelopeLine(envelope: ExecEnvelope): string {
  return JSON.stringify(envelope).replace(LINE_BREAKS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, () => resolve());
  });
}

/** A reader that went away (`mcpkit exec ... | head -c 10`) ends the output, it is not a crash with a stack trace. */
function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

/** A warning for each literal `server.tool` pattern whose server has a cached tool list that lacks the tool. */
async function unknownToolWarnings(rules: readonly AllowRule[], registered: readonly string[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const rule of rules) {
    if (rule.server === null || rule.tool === null || !registered.includes(rule.server)) continue;
    // Only the cache: the check must never start a server.
    const cache = await loadSchemaCache(rule.server);
    if (cache === null || cache.tools.some((tool) => tool.name === rule.tool)) continue;
    const near = nearestNames(rule.tool, cache.tools.map((tool) => tool.name));
    warnings.push(
      `warning: --allow ${rule.server}.${rule.tool} names no tool of ${rule.server} in its cached tool list (cached ${cache.fetchedAt})`
      + (near.length > 0 ? `; did you mean: ${near.join(', ')}?` : ''),
    );
  }
  return warnings;
}

export function createExecCommand(): Command {
  return new Command('exec')
    .description('Run a script in a sandbox that exposes the registered MCP tools as functions')
    .argument('[file]', "script file, or '-' to read the script from stdin")
    .option('-c, --code <js>', 'script text, instead of a file')
    .option(
      '--allow <patterns>',
      'allow matching tools: server.tool, server.*, *.tool or * (repeatable, comma-separated)',
      collect,
    )
    .option(
      '--allow-read-only',
      'trust the server-declared readOnlyHint, read from the live tool list of each server: allow tools whose server marks them read-only (the hint is a claim by the server, not verified)',
    )
    .option('--allow-writes', 'allow every tool, writes included')
    .option(
      '--timeout <ms>',
      `wall-clock limit in ms for the whole run, sandbox start-up included: past it the run fails as "timeout" whatever the script does (from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS})`,
      integerOption(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      DEFAULT_LIMITS.timeoutMs,
    )
    .option(
      '--max-calls <n>',
      `most mcp.* calls the script may make (at most ${MAX_CALLS_CEILING})`,
      integerOption(0, MAX_CALLS_CEILING),
      DEFAULT_LIMITS.maxCalls,
    )
    .option(
      '--max-output <bytes>',
      `cap on the serialised result and, separately, on the total logs; cut output sets "truncated" and the logs end with a marker line (at most ${MAX_OUTPUT_BYTES})`,
      integerOption(MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
      DEFAULT_LIMITS.maxOutputBytes,
    )
    .option(
      '--memory-mb <n>',
      'memory limit of the script, in MiB; a script that needs more fails as "limit"',
      integerOption(MIN_MEMORY_MB, MAX_MEMORY_MB),
      DEFAULT_LIMITS.memoryMb,
    )
    .addHelpText('after', `
The script is the body of an async function: use await and return. TypeScript
type annotations are stripped. It sees \`mcp\`, where mcp["server"].tool(args) and
mcp.server.tool(args) call a registered MCP tool and resolve to its result (the
structured content, else the text, parsed as JSON when it is JSON). A failed
tool call throws. \`console.log/info/warn/error\` are captured. There is no file,
network, process or timer access, and no credentials: only the tools you allow.

Writes are denied by default. Allow calls with --allow, trust server-declared
read-only hints with --allow-read-only, or allow everything with --allow-writes.
Names may contain dots, so a pattern such as a.b.c is matched against the
registered servers: it must name exactly one (server, tool) pair, else the run is
refused. Calls the script starts but does not await are still waited for. If such a
call fails (or is blocked) and nothing caught the failure, the run fails, as an
unhandled rejection does in Node. Code that runs after the script returned (a .then
on a call it did not await) cannot start calls: they are skipped and named in
"warnings". Every call the write gate blocks is also named on stderr, even when the
script caught the error, so a swallowed block is visible.

Parameters from a configured param provider are merged into every call, so a tool
that echoes its arguments returns them to the script.

Output is one line of JSON, and the exit code is 0 only when "ok" is true:
  {"ok":true,"result":...,"logs":[...],"calls":N,"blocked":[...],"truncated":false}
  {"ok":false,"error":{"kind":"script|tool|blocked|timeout|limit|interrupted|internal","message":"..."},"logs":[...],"calls":N,"blocked":[...]}
"warnings":[...] is added only when something the script did could not be honoured.
Error kinds: script (the script threw or has a syntax error), tool (a tool call failed),
blocked (the write gate refused a call), timeout (--timeout passed), limit (memory,
--max-calls or a size limit), interrupted (SIGINT or SIGTERM), internal (a bug or a
failure of the sandbox itself).
Exit codes: 0 ok, 1 the script failed, 2 usage error.

Examples:
  $ mcpkit exec -c 'return 1 + 1'
  $ mcpkit exec --allow-read-only script.js
  $ mcpkit exec --allow github.create_issue,github.add_label script.js
  $ echo 'return await mcp.docs.search({ query: "mcp" })' | mcpkit exec --allow docs.search -`)
    .exitOverride((error) => {
      process.exit(error.exitCode === 0 ? 0 : 2);
    })
    .action(async (file: string | undefined, options: ExecOptions) => {
      ignoreBrokenPipe(process.stdout);
      ignoreBrokenPipe(process.stderr);

      let code: string;
      let allow: AllowRule[];
      try {
        const patterns = parseAllowPatterns(options.allow ?? []);
        code = await readScript(file, options.code);
        const registered = patterns.length === 0 ? [] : Object.keys((await loadRegistry()).servers);
        const resolved = resolveAllowPatterns(patterns, registered);
        const warnings = [
          ...emptyAllowWarnings(options.allow ?? []),
          ...resolved.warnings,
          ...await unknownToolWarnings(resolved.rules, registered),
        ];
        for (const warning of warnings) process.stderr.write(`${warning}\n`);
        allow = resolved.rules;
      } catch (error) {
        return usageError((error as Error).message);
      }

      const limits: SandboxLimits = {
        timeoutMs: options.timeout,
        memoryMb: options.memoryMb,
        maxOutputBytes: options.maxOutput,
        maxCalls: options.maxCalls,
      };

      // A first Ctrl+C or SIGTERM ends the run as a failure, after the processes are ended and the
      // sessions are closed. A second one does not wait for that: it kills every process the run
      // started (the watch remembers the ones the first signal's shutdown already orphaned) and exits.
      const processes = createProcessWatch();
      const controller = new AbortController();
      let signals = 0;
      const onSignal = (signal: NodeJS.Signals): void => {
        if (++signals > 1) {
          processes.killAllSync();
          process.exit(1);
        }
        controller.abort(signal);
      };
      const onInterrupt = (): void => onSignal('SIGINT');
      const onTerminate = (): void => onSignal('SIGTERM');
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);

      try {
        const envelope = await runExec({
          code,
          policy: {
            allow,
            allowWrites: options.allowWrites === true,
            allowReadOnly: options.allowReadOnly === true,
          },
          limits,
          signal: controller.signal,
          onBlocked: (server, tool) => {
            const name = `${server}.${tool}`;
            process.stderr.write(
              `warning: blocked ${name}: the script's call was not allowed. Allow it with --allow ${name}, `
              + '--allow-read-only (if the server marks it read-only) or --allow-writes.\n',
            );
          },
        }, { ...defaultHostDeps(), processes });
        await writeLine(envelopeLine(envelope));
        process.exit(envelope.ok ? 0 : 1);
      } finally {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
      }
    });
}

/** Hidden child-process entry used by `exec`: the process that runs the script. */
export function createSandboxWorkerCommand(): Command {
  return new Command('_sandbox-worker')
    .description('Internal: the sandbox process started by `mcpkit exec`')
    .action(async () => {
      const { runSandboxWorker } = await import('../sandbox/worker.js');
      await runSandboxWorker();
    });
}
