import { execFile } from 'node:child_process';

/**
 * The command line of a process, '' when there is no such process, undefined when it cannot be
 * told (no `ps`, as on Windows, or `ps` failed to run).
 */
function commandLineOf(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeout: 3_000 }, (error, stdout) => {
      // `ps` exits 1 and prints nothing for a pid that does not exist.
      resolve(!error || typeof error.code === 'number' ? stdout.trim() : undefined);
    });
  });
}

/**
 * Whether `pid` is a runtime host of `serverName` (`mcpkit runtime _host <name>`), and not an
 * unrelated process that was given a dead host's pid since. Only meant for the moment before a
 * signal is sent: it starts a process. Where the command line cannot be read the record is trusted.
 */
export async function isRuntimeHostProcess(pid: number, serverName: string): Promise<boolean> {
  const commandLine = await commandLineOf(pid);
  return commandLine === undefined || commandLine.includes(`runtime _host ${serverName}`);
}

/**
 * Send `signal` to a runtime host, never to this process. With `wholeGroup` it goes to the host's
 * process group instead: a host is spawned detached and so leads a group of its own, which holds
 * the MCP server it started (and whatever that started in turn). A host that does not lead a group
 * has none to signal, and only the host itself receives it.
 */
export function signalRuntimeHost(pid: number, signal: NodeJS.Signals, wholeGroup = false): void {
  if (pid === process.pid) return;
  if (wholeGroup && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a group leader: fall through to the process itself.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}
