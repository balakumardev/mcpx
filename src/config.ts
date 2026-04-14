import { parse, stringify } from 'yaml';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { validateRuntimeCallTimeout, validateRuntimeIdleTimeout } from './runtime-config.js';
import { ALL_AGENTS } from './types.js';
import type {
  AgentSelectionMode,
  AgentType,
  RuntimeMode,
  ServerEntry,
  ServerRegistry,
} from './types.js';

const VALID_AGENT_SELECTION_MODES: AgentSelectionMode[] = ['defaults', 'explicit'];
const VALID_RUNTIME_MODES: RuntimeMode[] = ['ephemeral', 'persistent'];

const DEFAULT_REGISTRY: ServerRegistry = { version: 1, servers: {} };
const VALID_TRANSPORT_TYPES = ['stdio', 'http', 'sse'];

export function getRegistryPath(): string {
  return join(homedir(), '.mcpkit', 'servers.yaml');
}

function validateServerEntry(name: string, entry: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') {
    return 'server name must be a non-empty string';
  }

  if (entry === null || typeof entry !== 'object') {
    return 'entry must be an object';
  }

  const e = entry as Record<string, unknown>;

  // transport
  if (!e.transport || typeof e.transport !== 'object') {
    return 'missing or invalid "transport"';
  }

  const transport = e.transport as Record<string, unknown>;

  if (!VALID_TRANSPORT_TYPES.includes(transport.type as string)) {
    return `invalid transport type "${transport.type}" (expected: ${VALID_TRANSPORT_TYPES.join(', ')})`;
  }

  if (transport.type === 'stdio') {
    if (typeof transport.command !== 'string' || transport.command.trim() === '') {
      return 'stdio transport requires a non-empty "command" string';
    }
    if (!Array.isArray(transport.args)) {
      return 'stdio transport requires "args" to be an array';
    }
  }

  if (transport.type === 'http' || transport.type === 'sse') {
    if (typeof transport.url !== 'string' || transport.url.trim() === '') {
      return `${transport.type} transport requires a non-empty "url" string`;
    }
  }

  // paramProvider
  if (e.paramProvider !== undefined) {
    if (typeof e.paramProvider !== 'object' || e.paramProvider === null) {
      return '"paramProvider" must be an object';
    }
    const pp = e.paramProvider as Record<string, unknown>;
    if (typeof pp.command !== 'string' || pp.command.trim() === '') {
      return '"paramProvider.command" must be a non-empty string';
    }
  }

  if (e.runtime !== undefined) {
    if (typeof e.runtime !== 'object' || e.runtime === null) {
      return '"runtime" must be an object';
    }
    const runtime = e.runtime as Record<string, unknown>;
    const mode = runtime.mode as RuntimeMode | undefined;
    if (mode === undefined || !VALID_RUNTIME_MODES.includes(mode)) {
      return `"runtime.mode" must be one of: ${VALID_RUNTIME_MODES.join(', ')}`;
    }
    try {
      validateRuntimeIdleTimeout(runtime.idleTimeoutSec as number | undefined);
      validateRuntimeCallTimeout(runtime.callTimeoutSec as number | undefined);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (transport.type !== 'stdio' && mode === 'persistent') {
      return '"runtime.mode" can only be "persistent" for stdio transports';
    }
    if (
      mode !== 'persistent'
      && (runtime.idleTimeoutSec !== undefined || runtime.callTimeoutSec !== undefined)
    ) {
      return '"runtime.idleTimeoutSec" and "runtime.callTimeoutSec" can only be set when runtime.mode is "persistent"';
    }
  }

  // toolCount
  if (e.toolCount !== undefined && typeof e.toolCount !== 'number') {
    return '"toolCount" must be a number';
  }

  // agents
  if (e.agents !== undefined && !Array.isArray(e.agents)) {
    return '"agents" must be an array';
  }
  if (Array.isArray(e.agents) && e.agents.some(agent => !ALL_AGENTS.includes(agent as AgentType))) {
    return `"agents" contains unsupported values (expected: ${ALL_AGENTS.join(', ')})`;
  }

  if (e.agentSelectionMode !== undefined && !VALID_AGENT_SELECTION_MODES.includes(e.agentSelectionMode as AgentSelectionMode)) {
    return `"agentSelectionMode" must be one of: ${VALID_AGENT_SELECTION_MODES.join(', ')}`;
  }

  return null;
}

export async function loadRegistry(): Promise<ServerRegistry> {
  try {
    const content = await readFile(getRegistryPath(), 'utf-8');
    const data = parse(content);

    if (data === null || data === undefined) {
      return { ...DEFAULT_REGISTRY };
    }

    if (typeof data !== 'object') {
      console.warn(chalk.yellow('Warning: servers.yaml is not a valid object, using empty registry'));
      return { ...DEFAULT_REGISTRY };
    }

    if (data.version !== 1) {
      console.warn(chalk.yellow(`Warning: servers.yaml has unsupported version "${data.version}", expected 1. Using empty registry`));
      return { ...DEFAULT_REGISTRY };
    }

    if (!data.servers || typeof data.servers !== 'object' || Array.isArray(data.servers)) {
      console.warn(chalk.yellow('Warning: servers.yaml "servers" field is missing or not an object, using empty registry'));
      return { ...DEFAULT_REGISTRY };
    }

    const validServers: Record<string, ServerEntry> = {};

    for (const [name, entry] of Object.entries(data.servers)) {
      const error = validateServerEntry(name, entry);
      if (error) {
        console.warn(chalk.yellow(`Warning: skipping server "${name}": ${error}`));
        continue;
      }
      validServers[name] = entry as ServerEntry;
    }

    return { version: 1, servers: validServers };
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
