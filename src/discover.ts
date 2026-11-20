import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { authenticateIfNeeded, createStoredOAuthProvider } from './auth.js';
import { discoverTools } from './client.js';
import type { DiscoveryResult } from './client.js';
import { OAuthRequiredError } from './oauth-required-error.js';
import { loadSchemaCache, trySaveSchemaCache } from './schema-store.js';
import type { ServerEntry, ToolInfo } from './types.js';

/** What discovery needs from a registry entry (install has no entry yet). */
export type DiscoverableEntry = Pick<ServerEntry, 'name' | 'transport' | 'envHints'>;

/**
 * The OAuth provider for an entry, or undefined when it does not use OAuth.
 *
 * interactive: run the full flow (may open a browser and wait for the callback). Only for a command
 * the user pointed at one server.
 * non-interactive: use stored credentials only. The provider is built without touching the
 * credentials file, and it can never register a client, open a browser or listen on a port. With no
 * tokens it throws an OAuthRequiredError at once, before any request is made; an expired session that
 * cannot be refreshed throws the same error from the connection.
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

  const provider = await createStoredOAuthProvider(transport.url, transport.oauth, entry.name);
  if (!provider.tokens()?.access_token) {
    throw new OAuthRequiredError(entry.name);
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
