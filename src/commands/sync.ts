import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { getServer, listServers, updateServer } from '../config.js';
import { discoverForEntry } from '../discover.js';
import { trySaveSchemaCache } from '../schema-store.js';
import { loadAgentSettings, resolveServerAgents } from '../agent-config.js';
import { perServerAgents } from '../settings.js';
import { getGenerator } from '../generators/index.js';
import { reconcileSkillFiles } from '../skill-sync.js';
import { writeMetaSkill } from '../meta-skill.js';
import { reconcileAfterChange } from '../reconcile.js';
import { OAuthRequiredError } from '../oauth-required-error.js';
import { scrubSecrets } from '../sandbox/redact.js';
import type { AgentType, ServerEntry } from '../types.js';

async function hasSkillFiles(entry: ServerEntry, agents: AgentType[]): Promise<boolean> {
  const ctx = { serverName: entry.name, tools: [], transport: entry.transport, scope: 'global' as const };
  for (const agent of agents) {
    const generate = await getGenerator(agent);
    const skill = generate(ctx);
    if (!existsSync(skill.filePath)) {
      return false;
    }
  }
  return true;
}

export interface SyncOptions {
  /** Regenerate skill files even if they already exist. */
  force?: boolean;
  dryRun?: boolean;
  /** Touch only these agents: the servers that do not target any of them are left out, and no other agent's skill is removed. */
  onlyAgents?: AgentType[];
}

export interface SyncResult {
  synced: number;
  skipped: number;
  /** The servers that could not be synced; each also printed a warning. */
  failed: string[];
  /**
   * The OAuth servers skipped because they have no usable sign-in; each also printed a warning. Not a
   * failure: nothing is wrong with the server, and nothing in a batch can fix it.
   */
  needSignIn: string[];
}

/**
 * Generate the skill files of one registered server, or of all of them, from saved agent
 * preferences. `mcpkit sync` is this; so is the regeneration `mcpkit config skills per-server` does.
 * Agents whose skills mode is `guide` get no per-server skill and are not looked for either, but
 * still get the `mcpkit-cli` guide.
 */
export async function runSync(name: string | undefined, opts: SyncOptions = {}): Promise<SyncResult> {
  const settings = await loadAgentSettings();
  const servers = name
    ? [await getServer(name)].filter(Boolean) as ServerEntry[]
    : await listServers();
  const result: SyncResult = { synced: 0, skipped: 0, failed: [], needSignIn: [] };

  if (servers.length === 0) {
    if (name) {
      console.error(chalk.red(`Server "${name}" not found. Run 'mcpkit list' to see registered servers.`));
      process.exit(1);
    }
    console.log(chalk.yellow('No servers registered. Run `mcpkit install <server>` to add one.'));
    return result;
  }

  const metaAgents = new Set<AgentType>();
  const only = opts.onlyAgents;

  for (const entry of servers) {
    try {
      const resolved = resolveServerAgents(entry, settings);
      const targetAgents = only ? resolved.agents.filter((agent) => only.includes(agent)) : resolved.agents;
      if (only && targetAgents.length === 0) continue;
      for (const agent of targetAgents) metaAgents.add(agent);

      // Check if skill files already exist
      const sameAgents = entry.agents.length === resolved.agents.length
        && entry.agents.every((agent, index) => agent === resolved.agents[index]);
      const skillAgents = await perServerAgents(targetAgents);

      if (!opts.force && sameAgents && await hasSkillFiles(entry, skillAgents)) {
        const why = skillAgents.length === 0
          ? 'no per-server skill (skills mode: guide)'
          : 'skill files exist (use --force to regenerate)';
        console.log(chalk.dim(`  ⏭ ${entry.name} — ${why}`));
        result.skipped++;
        continue;
      }

      console.log(chalk.blue(`Syncing ${entry.name}...`));

      // Connect and discover tools. Syncing all servers never opens a browser: an OAuth server without a
      // saved sign-in is skipped below. A named server is a request to work on that one, so it may sign in.
      const { tools, serverMeta } = await discoverForEntry(entry, { interactiveAuth: name !== undefined });
      console.log(`  Found ${tools.length} tool(s)`);
      const ctx = { serverName: entry.name, tools, transport: entry.transport, description: entry.description, serverMeta, scope: 'global' as const, runtime: entry.runtime, paramProvider: entry.paramProvider };
      await reconcileSkillFiles({
        ctx,
        nextAgents: targetAgents,
        previousAgents: only ? [] : entry.agents,
        dryRun: opts.dryRun,
        logPrefix: '  ',
      });

      // Update registry entry
      if (!opts.dryRun) {
        entry.toolCount = tools.length;
        entry.agents = resolved.agents;
        entry.agentSelectionMode = resolved.selectionMode;
        entry.updatedAt = new Date().toISOString();
        // Patch the stored entry: it may have been edited or removed while tools were discovered.
        const stored = await updateServer(entry.name, (current) => {
          current.toolCount = entry.toolCount;
          current.agents = entry.agents;
          current.agentSelectionMode = entry.agentSelectionMode;
          current.updatedAt = entry.updatedAt;
        });
        if (stored) await trySaveSchemaCache(entry.name, tools);
      }

      result.synced++;
    } catch (err) {
      if (err instanceof OAuthRequiredError) {
        console.warn(chalk.yellow(`  ⚠ ${entry.name}: needs sign-in (mcpkit auth ${entry.name}); skipped`));
        result.needSignIn.push(entry.name);
        continue;
      }
      console.warn(chalk.yellow(`  ⚠ ${entry.name}: ${scrubSecrets(entry, err instanceof Error ? err.message : String(err))}`));
      result.failed.push(entry.name);
    }
  }

  // Refresh the mcpkit-cli meta-skill for every agent these servers target.
  if (metaAgents.size > 0) {
    await writeMetaSkill({
      agents: [...metaAgents],
      scope: 'global',
      dryRun: opts.dryRun,
      logPrefix: '  ',
    });
  }

  const signIn = result.needSignIn.length > 0
    ? `${result.needSignIn.length} skipped, needs sign-in: ${result.needSignIn.join(', ')}`
    : '';
  if (result.synced > 0) {
    console.log(chalk.green(`\n✓ Synced ${result.synced} server(s)${result.skipped > 0 ? `, skipped ${result.skipped}` : ''}${signIn ? `; ${signIn}` : ''}`));
  } else if (signIn) {
    console.log(chalk.yellow(`\n${result.skipped > 0 ? `${result.skipped} already in sync; ` : ''}${signIn}`));
  } else if (result.skipped > 0) {
    console.log(chalk.dim(`\nAll ${result.skipped} server(s) already in sync. Use --force to regenerate.`));
  }
  return result;
}

export function createSyncCommand(): Command {
  return new Command('sync')
    .description('Sync registry — generate missing skill files using saved agent preferences')
    .argument('[name]', 'Server name (omit to sync all)')
    .option('--force', 'Regenerate skill files even if they already exist')
    .option('--dry-run', 'Show what would be synced without writing files')
    .addHelpText('after', `
Examples:
  $ mcpkit sync                  Sync all servers (skip if skill files exist)
  $ mcpkit sync github           Sync a specific server
  $ mcpkit sync --force          Regenerate all skill files
  $ mcpkit sync --dry-run        Preview what would be synced

Agents whose skills mode is "guide" (see \`mcpkit config skills\`) get no per-server skill from sync.

Without a name, sync never opens a browser: an OAuth server that has no saved sign-in is skipped with
a note to run \`mcpkit auth <server>\`, and the others are still synced. A skipped server does not
change the exit code. With a name, sync may open the browser to sign in to that server.`)
    .action(async (name?: string, opts?: { force?: boolean; dryRun?: boolean }) => {
      try {
        await runSync(name, { force: opts?.force, dryRun: opts?.dryRun });
        if (!opts?.dryRun) await reconcileAfterChange();
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
