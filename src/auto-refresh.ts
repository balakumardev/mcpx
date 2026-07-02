import chalk from 'chalk';
import { DEFAULT_AUTO_REFRESH_TTL_SEC } from './types.js';
import type { ServerEntry, AgentType } from './types.js';
import { discoverTools } from './client.js';
import { authenticateIfNeeded } from './auth.js';
import { loadAgentSettings, resolveServerAgents } from './agent-config.js';
import { reconcileSkillFiles } from './skill-sync.js';
import { addServer } from './config.js';

/** Reference point for staleness: last discovery time, falling back to updatedAt. */
function lastDiscoveryTime(entry: ServerEntry): number {
  const iso = entry.autoRefresh?.lastRefreshedAt || entry.updatedAt;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Age of the skill snapshot in seconds. */
export function skillAgeSec(entry: ServerEntry, now = Date.now()): number {
  return Math.max(0, Math.floor((now - lastDiscoveryTime(entry)) / 1000));
}

function ttlSec(entry: ServerEntry): number {
  return entry.autoRefresh?.ttlSec ?? DEFAULT_AUTO_REFRESH_TTL_SEC;
}

/** True when the skill snapshot is older than the configured TTL. */
export function isStale(entry: ServerEntry, now = Date.now()): boolean {
  return skillAgeSec(entry, now) >= ttlSec(entry);
}

function humanizeAge(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/**
 * Re-discover tools and regenerate skill files for a server, then persist the
 * updated snapshot. Shared by `mcpkit update` and auto-refresh. Throws on
 * discovery failure so callers can decide whether to surface or swallow it.
 */
export async function refreshServer(
  entry: ServerEntry,
  opts: { logPrefix?: string; quiet?: boolean } = {},
): Promise<{ toolCount: number; agents: AgentType[] }> {
  const { logPrefix = '', quiet = false } = opts;
  const settings = await loadAgentSettings();

  const authProvider = (entry.transport.type === 'http' || entry.transport.type === 'sse') && entry.transport.auth === 'oauth'
    ? await authenticateIfNeeded(entry.transport.url, entry.transport.oauth)
    : undefined;

  const { tools, serverMeta } = await discoverTools(entry.transport, authProvider, entry.envHints);
  const resolved = resolveServerAgents(entry, settings);

  const ctx = {
    serverName: entry.name,
    tools,
    transport: entry.transport,
    description: entry.description,
    serverMeta,
    scope: 'global' as const,
    runtime: entry.runtime,
    paramProvider: entry.paramProvider,
  };
  await reconcileSkillFiles({
    ctx,
    nextAgents: resolved.agents,
    previousAgents: entry.agents,
    logPrefix,
    quiet,
  });

  const now = new Date().toISOString();
  entry.toolCount = tools.length;
  entry.agents = resolved.agents;
  entry.agentSelectionMode = resolved.selectionMode;
  entry.updatedAt = now;
  if (entry.autoRefresh) {
    entry.autoRefresh = { ...entry.autoRefresh, lastRefreshedAt: now };
  }
  await addServer(entry);

  return { toolCount: tools.length, agents: resolved.agents };
}

/**
 * Best-effort staleness handling invoked before a `mcpkit call`.
 *
 * - autoRefresh enabled + stale → silently re-discover & regenerate the skill,
 *   then continue. Any failure is swallowed (logged to stderr) so the actual
 *   tool call is never blocked by a refresh problem.
 * - autoRefresh disabled + stale → print a one-line hint suggesting
 *   `mcpkit update`, but do nothing else.
 *
 * Returns nothing; the call proceeds regardless.
 */
export async function maybeAutoRefresh(entry: ServerEntry): Promise<void> {
  if (!isStale(entry)) return;

  const age = humanizeAge(skillAgeSec(entry));

  if (!entry.autoRefresh?.enabled) {
    // Passive nudge only — never mutate without opt-in.
    console.error(chalk.dim(
      `ℹ skill for "${entry.name}" is ${age} old and may be out of date. ` +
      `Run 'mcpkit update ${entry.name}' to refresh, or enable auto-refresh with ` +
      `'mcpkit edit ${entry.name} --auto-refresh'.`,
    ));
    return;
  }

  try {
    console.error(chalk.dim(`↻ auto-refreshing "${entry.name}" (skill ${age} old)…`));
    const { toolCount } = await refreshServer(entry, { quiet: true });
    console.error(chalk.dim(`✓ refreshed "${entry.name}" (${toolCount} tools)`));
  } catch (err) {
    // Never let a refresh failure break the actual call.
    console.error(chalk.dim(
      `⚠ auto-refresh for "${entry.name}" failed (${err instanceof Error ? err.message : err}); using cached skill.`,
    ));
  }
}
