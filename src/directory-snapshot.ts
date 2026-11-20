import { entryServesAgent, loadAgentSettings } from './agent-config.js';
import { loadSchemaCache } from './schema-store.js';
import type { DirectoryServer } from './session-context.js';
import type { AgentSettings, AgentType, ServerEntry, ToolInfo } from './types.js';

/**
 * The registry and the schema caches read once, to be turned into the directory of any number of agents.
 * The start-up reconcile needs the directory of every agent it looks at several times (is the guide
 * current, what is written into it, which servers are indexed), and reading and parsing every cache for
 * each of those is what made a run with several agents slow. It gives the same servers, in the same
 * order, with the same fields as `loadDirectoryServers(agent)` of `directory.ts` (a test holds the two
 * together): a guide written from one must be the guide the other would write, or install and the
 * reconcile would keep rewriting each other's. Both pick the servers of an agent with `entryServesAgent`
 * (agent-config.ts, where the rule is written down): the one that decides where the per-server skills go.
 */

export interface DirectorySnapshot {
  /** Every registered server, in registry order, with the directory entry made from it. */
  servers: Array<{ entry: ServerEntry; server: DirectoryServer }>;
  /** The saved default agents (settings.yaml) the servers of an agent are picked with; null when there are none. */
  agentSettings: AgentSettings | null;
}

/** What a caller that needs the directory of one agent gets: the shape `loadDirectoryServersChecked` returns. */
export interface AgentDirectory {
  servers: DirectoryServer[];
  ok: boolean;
}

/** Where the directory of an agent comes from. */
export type DirectorySource = (agent: AgentType) => AgentDirectory | Promise<AgentDirectory>;

/** The directory entry of `entry`: its name, its description when that is text, and the cached tools when there are some (`tools` is undefined for a server without a usable cache). */
export function directoryServerOf(entry: ServerEntry, tools: ToolInfo[] | undefined): DirectoryServer {
  return {
    name: entry.name,
    // A hand-edited registry can hold anything here; only text is a description.
    description: typeof entry.description === 'string' ? entry.description : undefined,
    ...(tools === undefined ? {} : { tools }),
  };
}

/**
 * Read the schema cache of each of `entries` once (a server without a usable cache is listed from its
 * entry alone), and the saved default agents unless the caller has them already (`agentSettings`, null
 * for "there are none").
 */
export async function loadDirectorySnapshot(entries: readonly ServerEntry[], agentSettings?: AgentSettings | null): Promise<DirectorySnapshot> {
  const [servers, settings] = await Promise.all([
    Promise.all(entries.map(async (entry) => {
      const cache = await loadSchemaCache(entry.name);
      return { entry, server: directoryServerOf(entry, cache === null ? undefined : cache.tools) };
    })),
    agentSettings === undefined ? loadAgentSettings() : agentSettings,
  ]);
  return { servers, agentSettings: settings };
}

/** The directory of `agent`: the servers that are installed for it (`entryServesAgent`: the rule that decides where their skills are written). */
export function directoryFromSnapshot(snapshot: DirectorySnapshot, agent: AgentType): AgentDirectory {
  return {
    ok: true,
    servers: snapshot.servers
      .filter(({ entry }) => entryServesAgent(entry, snapshot.agentSettings, agent))
      .map(({ server }) => server),
  };
}

/** `directoryFromSnapshot` as the source a caller takes. */
export function snapshotSource(snapshot: DirectorySnapshot): DirectorySource {
  return (agent) => directoryFromSnapshot(snapshot, agent);
}
