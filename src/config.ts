import { parse, stringify } from 'yaml';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerEntry, ServerRegistry } from './types.js';

const DEFAULT_REGISTRY: ServerRegistry = { version: 1, servers: {} };

export function getRegistryPath(): string {
  return join(homedir(), '.mcpkit', 'servers.yaml');
}

export async function loadRegistry(): Promise<ServerRegistry> {
  try {
    const content = await readFile(getRegistryPath(), 'utf-8');
    const data = parse(content) as ServerRegistry | null;
    return data ?? { ...DEFAULT_REGISTRY };
  } catch {
    return { ...DEFAULT_REGISTRY, servers: {} };
  }
}

export async function saveRegistry(registry: ServerRegistry): Promise<void> {
  const filePath = getRegistryPath();
  await mkdir(join(homedir(), '.mcpkit'), { recursive: true });
  await writeFile(filePath, stringify(registry), 'utf-8');
}

export async function addServer(entry: ServerEntry): Promise<void> {
  const registry = await loadRegistry();
  registry.servers[entry.name] = entry;
  await saveRegistry(registry);
}

export async function removeServer(name: string): Promise<void> {
  const registry = await loadRegistry();
  delete registry.servers[name];
  await saveRegistry(registry);
}

export async function getServer(name: string): Promise<ServerEntry | undefined> {
  const registry = await loadRegistry();
  return registry.servers[name];
}

export async function listServers(): Promise<ServerEntry[]> {
  const registry = await loadRegistry();
  return Object.values(registry.servers);
}
