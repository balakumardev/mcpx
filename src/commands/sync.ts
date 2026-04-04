import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { getServer, listServers, addServer } from '../config.js';
import { discoverTools } from '../client.js';
import { loadAgentSettings, resolveServerAgents } from '../agent-config.js';
import { getGenerator } from '../generators/index.js';
import { reconcileSkillFiles } from '../skill-sync.js';
import { authenticateIfNeeded } from '../auth.js';
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
  $ mcpkit sync --dry-run        Preview what would be synced`)
    .action(async (name?: string, opts?: { force?: boolean; dryRun?: boolean }) => {
      try {
        const settings = await loadAgentSettings();
        const servers = name
          ? [await getServer(name)].filter(Boolean) as ServerEntry[]
          : await listServers();

        if (servers.length === 0) {
          console.log(chalk.yellow(name ? `Server "${name}" not found.` : 'No servers registered.'));
          return;
        }

        let synced = 0;
        let skipped = 0;

        for (const entry of servers) {
          try {
            const resolved = resolveServerAgents(entry, settings);

            // Check if skill files already exist
            const sameAgents = entry.agents.length === resolved.agents.length
              && entry.agents.every((agent, index) => agent === resolved.agents[index]);

            if (!opts?.force && sameAgents && await hasSkillFiles(entry, resolved.agents)) {
              console.log(chalk.dim(`  ⏭ ${entry.name} — skill files exist (use --force to regenerate)`));
              skipped++;
              continue;
            }

            console.log(chalk.blue(`Syncing ${entry.name}...`));

            // If OAuth, authenticate first
            const authProvider = (entry.transport.type === 'http' || entry.transport.type === 'sse') && entry.transport.auth === 'oauth'
              ? await authenticateIfNeeded(entry.transport.url, entry.transport.oauth)
              : undefined;

            // Connect and discover tools
            const { tools, serverMeta } = await discoverTools(entry.transport, authProvider);
            console.log(`  Found ${tools.length} tool(s)`);
            const ctx = { serverName: entry.name, tools, transport: entry.transport, description: entry.description, serverMeta, scope: 'global' as const };
            await reconcileSkillFiles({
              ctx,
              nextAgents: resolved.agents,
              previousAgents: entry.agents,
              dryRun: opts?.dryRun,
              logPrefix: '  ',
            });

            // Update registry entry
            if (!opts?.dryRun) {
              entry.toolCount = tools.length;
              entry.agents = resolved.agents;
              entry.agentSelectionMode = resolved.selectionMode;
              entry.updatedAt = new Date().toISOString();
              await addServer(entry);
            }

            synced++;
          } catch (err) {
            console.warn(chalk.yellow(`  ⚠ ${entry.name}: ${err instanceof Error ? err.message : err}`));
          }
        }

        if (synced > 0) {
          console.log(chalk.green(`\n✓ Synced ${synced} server(s)${skipped > 0 ? `, skipped ${skipped}` : ''}`));
        } else if (skipped > 0) {
          console.log(chalk.dim(`\nAll ${skipped} server(s) already in sync. Use --force to regenerate.`));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
