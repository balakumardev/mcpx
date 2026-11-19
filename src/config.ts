import { parse, stringify } from 'yaml';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { readStateFile, stateFileError, withFileLock, writeFileAtomic } from './atomic-file.js';
import { validateRuntimeCallTimeout, validateRuntimeIdleTimeout } from './runtime-config.js';
import { assertServerName, quoteName, serverNameProblem } from './server-name.js';
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

const VALID_TRANSPORT_TYPES = ['stdio', 'http', 'sse'];

export function getRegistryPath(): string {
  return join(homedir(), '.mcpkit', 'servers.yaml');
}

function getRegistryLockPath(): string {
  return `${getRegistryPath()}.lock`;
}

/**
 * The server map has no prototype, so a server named `constructor`, `toString` or `__proto__`
 * is an ordinary key: looking one up that is not registered finds nothing, and storing one
 * cannot change the map itself.
 */
function emptyServers(): Record<string, ServerEntry> {
  return Object.create(null) as Record<string, ServerEntry>;
}

/** A fresh empty registry: callers mutate it, so it must never be shared. */
function emptyRegistry(): ServerRegistry {
  return { version: 1, servers: emptyServers() };
}

/**
 * What a registry on disk held besides its valid servers: the entries that failed validation, as
 * parsed, and the order of every key in the file. Reading skips such an entry with a warning, but
 * the next write must not delete what it could not understand (a newer mcpkit's entry, a hand edit
 * that went wrong), so saveRegistry puts them back. Kept beside the registry, never on it, so
 * nothing that mutates or serialises a registry can see it.
 */
interface SkippedEntries {
  raw: Map<string, unknown>;
  order: string[];
}

const skippedByRegistry = new WeakMap<ServerRegistry, SkippedEntries>();

/** Forget a skipped entry: the caller is deleting that name on purpose. */
function dropSkippedEntry(registry: ServerRegistry, name: string): void {
  skippedByRegistry.get(registry)?.raw.delete(name);
}

/** The `servers` map to write: valid entries, kept invalid ones, in the file's order, new names last. */
function serversToWrite(registry: ServerRegistry): Record<string, unknown> {
  const skipped = skippedByRegistry.get(registry);
  if (skipped === undefined || skipped.raw.size === 0) return registry.servers;
  const servers = Object.create(null) as Record<string, unknown>;
  for (const name of skipped.order) {
    if (Object.hasOwn(registry.servers, name)) servers[name] = registry.servers[name];
    else if (skipped.raw.has(name)) servers[name] = skipped.raw.get(name);
  }
  for (const [name, entry] of Object.entries(registry.servers)) {
    if (!Object.hasOwn(servers, name)) servers[name] = entry;
  }
  return servers;
}

function validateServerEntry(name: string, entry: unknown): string | null {
  const nameProblem = serverNameProblem(name);
  if (nameProblem !== null) {
    return `invalid server name: ${nameProblem}`;
  }

  if (entry === null || typeof entry !== 'object') {
    return 'entry must be an object';
  }

  const e = entry as Record<string, unknown>;

  // The entry's own name, not only its key, becomes a skill directory: a hand-written
  // `good: { name: "../../victim" }` must never reach a path.
  const ownNameProblem = serverNameProblem(e.name);
  if (ownNameProblem !== null) {
    return `invalid "name" ${quoteName(e.name)}: ${ownNameProblem}`;
  }
  if (e.name !== name) {
    return `"name" ${quoteName(e.name)} does not match the key`;
  }

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

/**
 * Load the registry. A missing or blank file is an empty registry. A file that cannot be read
 * or parsed, or that is not a version 1 registry, throws an error naming it: the registry is
 * updated by reading it and writing it back, so reading such a file as empty would let the next
 * update erase every server in it. A single invalid server entry is skipped with a warning.
 */
export async function loadRegistry(): Promise<ServerRegistry> {
  const registryPath = getRegistryPath();
  const content = await readStateFile(registryPath);
  if (content === undefined) {
    return emptyRegistry();
  }

  let data: unknown;
  try {
    data = parse(content);
  } catch (err) {
    throw stateFileError(registryPath, `invalid YAML (${(err instanceof Error ? err.message : String(err)).split('\n')[0]})`);
  }

  if (data === null || data === undefined) {
    return emptyRegistry();
  }

  if (typeof data !== 'object' || Array.isArray(data)) {
    throw stateFileError(registryPath, 'not a YAML mapping');
  }

  const { version, servers } = data as { version?: unknown; servers?: unknown };
  if (version !== 1) {
    throw stateFileError(
      registryPath,
      version === undefined ? 'missing "version" (expected 1)' : `unsupported version "${String(version)}" (expected 1)`,
    );
  }

  if (servers === undefined || servers === null) {
    console.warn(chalk.yellow('Warning: servers.yaml has no "servers" field, using an empty registry'));
    return emptyRegistry();
  }

  if (typeof servers !== 'object' || Array.isArray(servers)) {
    throw stateFileError(registryPath, '"servers" is not a mapping');
  }

  const validServers = emptyServers();
  const skipped: SkippedEntries = { raw: new Map(), order: Object.keys(servers) };

  for (const [name, entry] of Object.entries(servers)) {
    const error = validateServerEntry(name, entry);
    if (error) {
      console.warn(chalk.yellow(`Warning: skipping server ${quoteName(name)}: ${error} (left unchanged in servers.yaml; fix or delete it there)`));
      skipped.raw.set(name, entry);
      continue;
    }
    validServers[name] = entry as ServerEntry;
  }

  const registry: ServerRegistry = { version: 1, servers: validServers };
  skippedByRegistry.set(registry, skipped);
  return registry;
}

/**
 * Every server written must have a valid name that is also the name inside its entry. Everything
 * that stores a server ends up here (addServer, updateServer, updateRegistry, a rename done as
 * delete-then-add), so a bad name is refused once, whatever route it took, before a byte is written.
 */
function assertRegistryNames(registry: ServerRegistry): void {
  for (const [key, entry] of Object.entries(registry.servers)) {
    assertServerName(key);
    assertServerName(entry.name);
    if (entry.name !== key) {
      throw new Error(`Cannot save server ${quoteName(key)}: its name ${quoteName(entry.name)} does not match the key it is stored under.`);
    }
  }
}

export async function saveRegistry(registry: ServerRegistry): Promise<void> {
  assertRegistryNames(registry);
  await mkdir(join(homedir(), '.mcpkit'), { recursive: true });
  // A new registry is private to its owner: env values stored in it may be literal secrets.
  // An existing one keeps whatever permissions the user gave it.
  await writeFileAtomic(getRegistryPath(), stringify({ ...registry, servers: serversToWrite(registry) }), { newFileMode: 0o600 });
}

/**
 * Read-modify-write the registry as one step that no other mcpkit process can
 * interleave with: take the registry lock, load the file fresh, let `mutator`
 * change it in place, then save atomically. Whatever the mutator returns is
 * returned; if it throws, nothing is saved. The lock is not reentrant: the
 * mutator must not call updateRegistry, addServer or removeServer itself.
 */
export async function updateRegistry<T = void>(
  mutator: (registry: ServerRegistry) => T | Promise<T>,
): Promise<T> {
  return withFileLock(getRegistryLockPath(), async () => {
    const registry = await loadRegistry();
    const result = await mutator(registry);
    await saveRegistry(registry);
    return result;
  });
}

/**
 * Change one stored server in place. `mutator` receives the entry as it is on disk
 * right now, so a command that read the entry earlier (a refresh that spent seconds
 * discovering tools) applies only its own fields and never overwrites an edit made
 * meanwhile. Returns false, and writes nothing new, when the server no longer exists:
 * a removed server is not brought back. The mutator may change any field but `name`: a
 * rename is refused when the registry is saved (see `assertRegistryNames`).
 */
export async function updateServer(
  name: string,
  mutator: (entry: ServerEntry) => void,
): Promise<boolean> {
  return updateRegistry((registry) => {
    if (!Object.hasOwn(registry.servers, name)) return false;
    mutator(registry.servers[name]);
    return true;
  });
}

export async function addServer(entry: ServerEntry): Promise<void> {
  assertServerName(entry.name);
  await updateRegistry((registry) => {
    registry.servers[entry.name] = entry;
  });
}

export async function removeServer(name: string): Promise<void> {
  await updateRegistry((registry) => {
    delete registry.servers[name];
    dropSkippedEntry(registry, name);
  });
}

/**
 * The registered server called `name`, or undefined. A name that could never be registered is an
 * error rather than a miss: the message says why, and a caller that checks a new name here before
 * it removes the old one (a rename) learns that it is invalid while nothing has changed yet.
 */
export async function getServer(name: string): Promise<ServerEntry | undefined> {
  assertServerName(name);
  const registry = await loadRegistry();
  return Object.hasOwn(registry.servers, name) ? registry.servers[name] : undefined;
}

export async function listServers(): Promise<ServerEntry[]> {
  const registry = await loadRegistry();
  return Object.values(registry.servers);
}
