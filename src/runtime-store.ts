import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rm, type FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-file.js';
import { resolveRuntimeConfig } from './runtime-config.js';
import { RUNTIME_PROTOCOL_VERSION } from './runtime-protocol.js';
import type { ServerEntry } from './types.js';

export interface RuntimeRecord {
  serverName: string;
  pid: number;
  socketPath: string;
  logPath: string;
  fingerprint: string;
  startedAt: string;
  lastUsedAt: string;
  idleTimeoutSec: number;
  callTimeoutSec: number;
}

/** Who is starting or running the host of a runtime. See runtime-claim.ts. */
export interface RuntimeClaim {
  pid: number;
  startedAt: string;
}

// The log can hold request data, the directory holds the socket that runs tools with the user's
// credentials: both are private to the owner.
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
// A Unix socket path has to fit sun_path: 104 bytes on macOS, 108 on Linux, each with its NUL.
const SOCKET_PATH_LIMIT = 100;

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function runtimeKey(serverName: string): string {
  const hash = createHash('sha256').update(serverName).digest('hex').slice(0, 10);
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'server';
  return `${slug}-${hash}`;
}

export function getRuntimeDir(): string {
  return join(homedir(), '.mcpkit', 'runtimes');
}

export function getRuntimeMetadataPath(serverName: string): string {
  return join(getRuntimeDir(), `${runtimeKey(serverName)}.json`);
}

export function getRuntimeLogPath(serverName: string): string {
  return join(getRuntimeDir(), `${runtimeKey(serverName)}.log`);
}

export function getRuntimeLockPath(serverName: string): string {
  return join(getRuntimeDir(), `${runtimeKey(serverName)}.lock`);
}

export function getRuntimeClaimPath(serverName: string): string {
  return join(getRuntimeDir(), `${runtimeKey(serverName)}.pid`);
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The runtime directory under its real path. Everything that has to agree between processes (the
 * scope below, the socket path) is derived from this one spelling, because two processes can reach
 * the same home through different spellings (a symlink to it, or HOME set one way by a shell and
 * another way by a service) and must still agree about where its socket is.
 */
function realRuntimeDir(): string {
  return join(realPathOrSelf(homedir()), '.mcpkit', 'runtimes');
}

/**
 * Identifies this runtime directory in the names that live outside it (the fallback socket below,
 * a Windows pipe), where every user and every HOME on the machine shares one namespace. It hashes the
 * directory's real path, so two spellings of the same home (a symlink) agree and two homes never do.
 */
function runtimeDirScope(): string {
  return createHash('sha256').update(realRuntimeDir()).digest('hex').slice(0, 10);
}

export function getRuntimeSocketPath(serverName: string): string {
  const key = runtimeKey(serverName);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mcpkit-${runtimeDirScope()}-${key}`;
  }
  // The real path, not the spelling this process happens to use: the host binds the socket and the
  // other processes probe it (see runtime-claim.ts) each through their own spelling of HOME, and a
  // short alias of a deep home (or the reverse) would otherwise send them to different sockets of
  // one runtime. The real path is what the length is judged on, and it is the path handed out when
  // it fits, so a long alias never reaches bind().
  const socketPath = join(realRuntimeDir(), `${key}.sock`);
  // The runtime directory can be too deep for a socket path. The fallback lives in the system tmp
  // dir, which every HOME shares, so it must say which runtime directory it belongs to as well as
  // which server, or two homes would bind (and delete) each other's socket.
  if (Buffer.byteLength(socketPath) >= SOCKET_PATH_LIMIT) {
    return join(tmpdir(), `mcpkit-${runtimeDirScope()}-${key.slice(-10)}.sock`);
  }
  return socketPath;
}

export async function ensureRuntimeDir(): Promise<void> {
  const dir = getRuntimeDir();
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // mkdir leaves an existing directory as it is, and an older release created it open to everyone.
  await chmod(dir, PRIVATE_DIR_MODE).catch(() => undefined);
}

/**
 * Open the runtime's log for appending. It is created readable by its owner only, and one that an
 * older release created with wider permissions is tightened.
 */
export async function openRuntimeLog(serverName: string): Promise<FileHandle> {
  await ensureRuntimeDir();
  const handle = await open(getRuntimeLogPath(serverName), 'a', PRIVATE_FILE_MODE);
  await handle.chmod(PRIVATE_FILE_MODE).catch(() => undefined);
  return handle;
}

function parseRuntimeRecord(content: string): RuntimeRecord | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<RuntimeRecord> | null;
    return parsed && typeof parsed.pid === 'number' && typeof parsed.serverName === 'string'
      ? (parsed as RuntimeRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readRuntimeRecord(serverName: string): Promise<RuntimeRecord | undefined> {
  try {
    return parseRuntimeRecord(await readFile(getRuntimeMetadataPath(serverName), 'utf-8'));
  } catch {
    return undefined;
  }
}

export async function listRuntimeRecords(): Promise<RuntimeRecord[]> {
  try {
    const files = await readdir(getRuntimeDir());
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          try {
            return parseRuntimeRecord(await readFile(join(getRuntimeDir(), file), 'utf-8'));
          } catch {
            return undefined;
          }
        }),
    );
    return records.filter((record): record is RuntimeRecord => record !== undefined);
  } catch {
    return [];
  }
}

/** Replace the record in one step: a reader sees the old one or the new one, never half of it. */
export async function writeRuntimeRecord(record: RuntimeRecord): Promise<void> {
  await ensureRuntimeDir();
  await writeFileAtomic(getRuntimeMetadataPath(record.serverName), JSON.stringify(record, null, 2), {
    mode: PRIVATE_FILE_MODE,
  });
}

export async function readRuntimeClaim(serverName: string): Promise<RuntimeClaim | undefined> {
  try {
    const parsed = JSON.parse(await readFile(getRuntimeClaimPath(serverName), 'utf-8')) as Partial<RuntimeClaim> | null;
    return parsed && typeof parsed.pid === 'number' && typeof parsed.startedAt === 'string'
      ? { pid: parsed.pid, startedAt: parsed.startedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove what the daemons in `pids` left behind: the record and the claim only while they still
 * name one of them, and the socket only when no other daemon is recorded. Nothing here touches the
 * start lock, and nothing of a daemon that is not listed, however it came to be there: a host that
 * stops, or a caller that finds a dead one, must never take files from a live runtime that started
 * in the meantime. The log is removed on request (`removeLog`), whoever wrote it. A host that is
 * closing passes `keepSocket`: closing its server already removed the socket it bound, and one that
 * never got to bind (it found the runtime owned) has none of its own to remove.
 */
export async function deleteRuntimeArtifacts(
  serverName: string,
  options: { pids: readonly number[]; removeLog?: boolean; keepSocket?: boolean },
): Promise<void> {
  const [record, claim] = await Promise.all([readRuntimeRecord(serverName), readRuntimeClaim(serverName)]);
  const socketPaths = new Set<string>();
  let otherOwner = false;

  if (record) {
    if (options.pids.includes(record.pid)) {
      await rm(getRuntimeMetadataPath(serverName), { force: true });
      // The socket this daemon announced, which an older release may have put somewhere else.
      socketPaths.add(record.socketPath);
    } else {
      otherOwner = true;
    }
  }
  if (claim) {
    if (options.pids.includes(claim.pid)) {
      await rm(getRuntimeClaimPath(serverName), { force: true });
    } else {
      otherOwner = true;
    }
  }
  if (!otherOwner) socketPaths.add(getRuntimeSocketPath(serverName));
  if (process.platform !== 'win32' && !options.keepSocket) {
    await Promise.all([...socketPaths].map((path) => rm(path, { force: true })));
  }
  if (options.removeLog) {
    await rm(getRuntimeLogPath(serverName), { force: true });
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function computeRuntimeFingerprint(
  entry: Pick<ServerEntry, 'transport' | 'paramProvider' | 'runtime'>,
): string {
  const payload = {
    protocol: RUNTIME_PROTOCOL_VERSION,
    transport: entry.transport,
    paramProvider: entry.paramProvider ?? null,
    runtime: resolveRuntimeConfig(entry.runtime),
  };

  return createHash('sha256').update(stableSerialize(payload)).digest('hex');
}
