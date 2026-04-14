import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntimeConfig } from './runtime-config.js';
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
}

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

export function getRuntimeSocketPath(serverName: string): string {
  const key = runtimeKey(serverName);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mcpkit-${key}`;
  }
  return join(getRuntimeDir(), `${key}.sock`);
}

export async function ensureRuntimeDir(): Promise<void> {
  await mkdir(getRuntimeDir(), { recursive: true });
}

export async function readRuntimeRecord(serverName: string): Promise<RuntimeRecord | undefined> {
  try {
    const content = await readFile(getRuntimeMetadataPath(serverName), 'utf-8');
    return JSON.parse(content) as RuntimeRecord;
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
            const content = await readFile(join(getRuntimeDir(), file), 'utf-8');
            return JSON.parse(content) as RuntimeRecord;
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

export async function writeRuntimeRecord(record: RuntimeRecord): Promise<void> {
  await ensureRuntimeDir();
  await writeFile(getRuntimeMetadataPath(record.serverName), JSON.stringify(record, null, 2), 'utf-8');
}

export async function deleteRuntimeArtifacts(
  serverName: string,
  options: { removeLog?: boolean } = {},
): Promise<void> {
  const paths = [
    getRuntimeMetadataPath(serverName),
    getRuntimeLockPath(serverName),
    ...(process.platform === 'win32' ? [] : [getRuntimeSocketPath(serverName)]),
    ...(options.removeLog ? [getRuntimeLogPath(serverName)] : []),
  ];

  await Promise.all(paths.map(async (path) => {
    try {
      await rm(path, { force: true });
    } catch {
      // Ignore missing artifacts.
    }
  }));
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
    transport: entry.transport,
    paramProvider: entry.paramProvider ?? null,
    runtime: resolveRuntimeConfig(entry.runtime),
  };

  return createHash('sha256').update(stableSerialize(payload)).digest('hex');
}
