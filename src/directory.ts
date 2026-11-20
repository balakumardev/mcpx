import { entryServesAgent, loadAgentSettings } from './agent-config.js';
import { loadRegistry } from './config.js';
import { directoryServerOf } from './directory-snapshot.js';
import { loadSchemaCache } from './schema-store.js';
import type { DirectoryServer } from './session-context.js';
import type { AgentType } from './types.js';

export type { DirectoryServer };

/** `task` with `console.warn` silenced: loading the registry warns about entries it skips, and a hook says nothing. */
async function withoutWarnings<T>(task: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await task();
  } finally {
    console.warn = warn;
  }
}

/** The directory of `agent`, read straight from the registry and the schema caches; throws what `loadRegistry` throws. */
async function readDirectoryServers(agent: AgentType): Promise<DirectoryServer[]> {
  const registry = await withoutWarnings(loadRegistry);
  const settings = await withoutWarnings(loadAgentSettings);
  const entries = Object.values(registry.servers).filter((entry) => entryServesAgent(entry, settings, agent));
  return Promise.all(entries.map(async (entry) => {
    const cache = await loadSchemaCache(entry.name);
    return directoryServerOf(entry, cache === null ? undefined : cache.tools);
  }));
}

/**
 * The servers the directory lists for `agent`, read from the registry and the schema caches only:
 * nothing is started, contacted or written. A server is listed for an agent when `entryServesAgent`
 * says it is installed for it, the rule that decides where its per-server skill is written (see
 * agent-config.ts): an explicit agent list is respected, and a server in defaults mode follows the saved
 * default agents, so an agent enabled after the server was installed lists it too. A server without a
 * usable schema cache (none yet, unreadable, empty, corrupt or of another version) is still listed, from
 * its registry entry alone: one bad cache must not hide the other servers. A missing registry file
 * means no servers; a registry that cannot be read or parsed makes this reject
 * (`loadDirectoryServersChecked` reports that as `ok: false` instead, for a caller that must tell
 * "no servers" from "cannot tell").
 */
export async function loadDirectoryServers(agent: AgentType): Promise<DirectoryServer[]> {
  return readDirectoryServers(agent);
}

/**
 * `loadDirectoryServers` that never rejects. `ok` is false only when the registry file exists but
 * cannot be read or parsed (a permission error, invalid YAML, an unsupported version): `servers` is
 * then empty and says nothing about what is registered, so a caller that rewrites something from the
 * list must keep what it has. A registry file that is missing is `ok: true` with no servers.
 */
export async function loadDirectoryServersChecked(agent: AgentType): Promise<{ servers: DirectoryServer[]; ok: boolean }> {
  try {
    return { servers: await readDirectoryServers(agent), ok: true };
  } catch {
    return { servers: [], ok: false };
  }
}
