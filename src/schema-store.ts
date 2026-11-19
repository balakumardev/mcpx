import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import type { ToolInfo } from './types.js';

/**
 * Per-server cache of discovered tool schemas, kept at
 * `~/.mcpkit/schemas/<server>.json`. It lets `search`, `describe`, `types` and
 * `exec` work offline. Schemas are server-declared data: never trust them.
 */
export interface SchemaCache {
  version: 1;
  server: string;
  fetchedAt: string;
  tools: ToolInfo[];
}

const CACHE_VERSION = 1;

export function schemaCacheDir(): string {
  return join(homedir(), '.mcpkit', 'schemas');
}

/**
 * Server names become file names. Anything outside [A-Za-z0-9._-] is
 * percent-encoded (including `%` itself), so the mapping is injective and a name
 * can never escape the cache directory.
 */
function encodeServerName(server: string): string {
  return Array.from(Buffer.from(server, 'utf-8'), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9._-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

export function schemaCachePath(server: string): string {
  return join(schemaCacheDir(), `${encodeServerName(server)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolInfo(value: unknown): value is ToolInfo {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && isRecord(value.inputSchema);
}

function parseSchemaCache(raw: string): SchemaCache | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.version !== CACHE_VERSION) return null;
  if (typeof data.server !== 'string' || typeof data.fetchedAt !== 'string') return null;
  if (!Array.isArray(data.tools) || !data.tools.every(isToolInfo)) return null;
  return data as unknown as SchemaCache;
}

/** Write the cache atomically (tmp file + rename) so readers never see a partial file. */
export async function saveSchemaCache(server: string, tools: ToolInfo[]): Promise<void> {
  const cache: SchemaCache = {
    version: CACHE_VERSION,
    server,
    fetchedAt: new Date().toISOString(),
    tools,
  };
  const filePath = schemaCachePath(server);
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

  await mkdir(schemaCacheDir(), { recursive: true, mode: 0o700 });
  try {
    await writeFile(tmpPath, JSON.stringify(cache, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Best-effort variant for command flows: a cache problem must never fail the
 * command that discovered the tools, so a failure costs at most one stderr line.
 */
export async function trySaveSchemaCache(server: string, tools: ToolInfo[]): Promise<boolean> {
  try {
    await saveSchemaCache(server, tools);
    return true;
  } catch (err) {
    console.error(chalk.dim(
      `⚠ could not cache tool schemas for "${server}" (${err instanceof Error ? err.message : err})`,
    ));
    return false;
  }
}

/** The cached schemas for a server, or null when missing, unreadable, corrupt or of another version. */
export async function loadSchemaCache(server: string): Promise<SchemaCache | null> {
  let raw: string;
  try {
    raw = await readFile(schemaCachePath(server), 'utf-8');
  } catch {
    return null;
  }
  const cache = parseSchemaCache(raw);
  return cache && cache.server === server ? cache : null;
}

export async function removeSchemaCache(server: string): Promise<void> {
  await rm(schemaCachePath(server), { force: true });
}

/** Every valid cache on disk, sorted by server name. Corrupt files are skipped. */
export async function listSchemaCaches(): Promise<SchemaCache[]> {
  let files: string[];
  try {
    files = await readdir(schemaCacheDir());
  } catch {
    return [];
  }

  const caches: SchemaCache[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const cache = parseSchemaCache(await readFile(join(schemaCacheDir(), file), 'utf-8'));
      if (cache) caches.push(cache);
    } catch {
      // Unreadable entry (removed mid-listing, permissions): treat like a corrupt one.
    }
  }
  return caches.sort((a, b) => a.server.localeCompare(b.server));
}
