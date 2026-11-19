import { HostCallError, runSandbox } from './core.js';
import { ProtocolError, parseParentMessage, type ParentMessage, type RunRequest } from './protocol.js';

/**
 * Child side of `mcpkit exec`: the process that runs the script. It is started
 * by the parent with an empty environment, receives one `run` request over the
 * fork IPC channel and forwards every `mcp.*` call back to the parent, which
 * holds the MCP sessions and the credentials.
 */
export async function runSandboxWorker(): Promise<void> {
  const send = process.send?.bind(process);
  if (send === undefined) {
    process.stderr.write('_sandbox-worker is internal: `mcpkit exec` starts it with an IPC channel\n');
    process.exit(2);
  }

  // If the parent goes away, nobody can answer calls or read the result: do not linger. The
  // 'disconnect' event covers a script that is waiting; a script spinning in a loop never lets
  // the event loop run, so the VM's interrupt handler checks the parent pid itself (a parent
  // killed with SIGKILL leaves no other signal, and this process is then adopted by init).
  process.on('disconnect', () => process.exit(1));
  const parentPid = process.ppid;
  const parentGone = (): boolean => process.ppid !== parentPid;

  const pending = new Map<number, { resolve: (json: string) => void; reject: (error: HostCallError) => void }>();
  let nextId = 0;
  let started = false;

  const hostCall = (server: string, tool: string, args: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ type: 'call', id, server, tool, args });
    });

  const run = async (request: RunRequest): Promise<void> => {
    const outcome = await runSandbox({
      code: request.code,
      limits: request.limits,
      deadline: request.deadline,
      hostCall,
      onLog: (line) => send({ type: 'log', line }),
      onLogsCut: () => send({ type: 'logs-cut' }),
      parentGone,
    });
    if (parentGone()) process.exit(1);
    const done = outcome.ok
      ? {
        type: 'done',
        ok: true,
        result: outcome.result,
        resultTruncated: outcome.resultTruncated,
        resultBytes: outcome.resultBytes,
        logs: outcome.logAccount,
        ...(outcome.warnings.length === 0 ? {} : { warnings: outcome.warnings }),
      }
      : {
        type: 'done',
        ok: false,
        error: outcome.error,
        logs: outcome.logAccount,
        ...(outcome.warnings.length === 0 ? {} : { warnings: outcome.warnings }),
      };
    // Exit once the result is flushed: nothing is left to dispose that the OS will not reclaim.
    send(done, () => process.exit(0));
  };

  process.on('message', (raw: unknown) => {
    let message: ParentMessage;
    try {
      message = parseParentMessage(raw);
    } catch (error) {
      process.stderr.write(`${error instanceof ProtocolError ? error.message : String(error)}\n`);
      process.exit(2);
    }

    if (message.type === 'run') {
      if (started) {
        process.stderr.write('a sandbox runs exactly one script\n');
        process.exit(2);
      }
      started = true;
      run(message).catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exit(1);
      });
      return;
    }

    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.ok) {
      waiting.resolve(message.json);
    } else {
      waiting.reject(new HostCallError(message.error.kind, message.error.message, message.error.tool));
    }
  });
}
