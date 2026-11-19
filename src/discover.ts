import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { authenticateIfNeeded, createStoredOAuthProvider } from './auth.js';
import { discoverTools } from './client.js';
import type { DiscoveryResult } from './client.js';
import { loadSchemaCache, trySaveSchemaCache } from './schema-store.js';
import type { ServerEntry, ToolInfo } from './types.js';

/** What discovery needs from a registry entry (install has no entry yet). */
export type DiscoverableEntry = Pick<ServerEntry, 'name' | 'transport' | 'envHints'>;

/**
 * The OAuth provider for an entry, or undefined when it does not use OAuth.
 *
 * interactive: run the full flow (may open a browser and wait for the callback).
 * non-interactive: use stored credentials only. The provider is built without
 * touching the credentials file, it throws when there are no tokens, and it can
 * never register a client or open a browser, so an expired session that cannot
 * be refreshed fails fast instead.
 */
export async function resolveAuthProvider(
  entry: DiscoverableEntry,
  opts: { interactive: boolean },
): Promise<OAuthClientProvider | undefined> {
  const { transport } = entry;
  if ((transport.type !== 'http' && transport.type !== 'sse') || transport.auth !== 'oauth') {
    return undefined;
  }
  if (opts.interactive) {
    return authenticateIfNeeded(transport.url, transport.oauth);
  }

  const authRequired = `"${entry.name}" needs OAuth sign-in: run \`mcpkit auth ${entry.name}\` first`;
  const provider = await createStoredOAuthProvider(transport.url, transport.oauth, authRequired);
  if (!provider.tokens()?.access_token) {
    throw new Error(authRequired);
  }
  return provider;
}

/** Connect to the server, list every tool (all pages) and disconnect. Does not touch the cache. */
export async function discoverForEntry(
  entry: DiscoverableEntry,
  opts: { interactiveAuth: boolean },
): Promise<DiscoveryResult> {
  const authProvider = await resolveAuthProvider(entry, { interactive: opts.interactiveAuth });
  return discoverTools(entry.transport, authProvider, entry.envHints);
}

/**
 * The tools of a server: from the schema cache when present, otherwise by live
 * discovery (which then fills the cache). `refresh` skips the cache read.
 * Unlike the commands that install or update a server, this never opens a
 * browser unless `interactiveAuth` is set.
 */
export async function getToolsForServer(
  entry: DiscoverableEntry,
  opts: { refresh?: boolean; interactiveAuth?: boolean } = {},
): Promise<{ tools: ToolInfo[]; fromCache: boolean }> {
  if (!opts.refresh) {
    const cached = await loadSchemaCache(entry.name);
    if (cached) return { tools: cached.tools, fromCache: true };
  }

  const { tools } = await discoverForEntry(entry, { interactiveAuth: opts.interactiveAuth ?? false });
  await trySaveSchemaCache(entry.name, tools);
  return { tools, fromCache: false };
}
