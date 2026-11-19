import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { getServer, listServers, updateServer } from '../config.js';
import { discoverForEntry } from '../discover.js';
import { trySaveSchemaCache } from '../schema-store.js';
import { loadAgentSettings, resolveServerAgents } from '../agent-config.js';
import { getGenerator } from '../generators/index.js';
import { reconcileSkillFiles } from '../skill-sync.js';
import { writeMetaSkill } from '../meta-skill.js';
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
          if (name) {
            console.error(chalk.red(`Server "${name}" not found. Run 'mcpkit list' to see registered servers.`));
            process.exit(1);
          }
          console.log(chalk.yellow('No servers registered. Run `mcpkit install <server>` to add one.'));
          return;
        }

        let synced = 0;
        let skipped = 0;
        const metaAgents = new Set<AgentType>();

        for (const entry of servers) {
          try {
            const resolved = resolveServerAgents(entry, settings);
            for (const agent of resolved.agents) metaAgents.add(agent);

            // Check if skill files already exist
            const sameAgents = entry.agents.length === resolved.agents.length
              && entry.agents.every((agent, index) => agent === resolved.agents[index]);

            if (!opts?.force && sameAgents && await hasSkillFiles(entry, resolved.agents)) {
              console.log(chalk.dim(`  ⏭ ${entry.name} — skill files exist (use --force to regenerate)`));
              skipped++;
              continue;
            }

            console.log(chalk.blue(`Syncing ${entry.name}...`));

            // Connect and discover tools (authenticating first when the server uses OAuth)
            const { tools, serverMeta } = await discoverForEntry(entry, { interactiveAuth: true });
            console.log(`  Found ${tools.length} tool(s)`);
            const ctx = { serverName: entry.name, tools, transport: entry.transport, description: entry.description, serverMeta, scope: 'global' as const, runtime: entry.runtime, paramProvider: entry.paramProvider };
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
              // Patch the stored entry: it may have been edited or removed while tools were discovered.
              const stored = await updateServer(entry.name, (current) => {
                current.toolCount = entry.toolCount;
                current.agents = entry.agents;
                current.agentSelectionMode = entry.agentSelectionMode;
                current.updatedAt = entry.updatedAt;
              });
              if (stored) await trySaveSchemaCache(entry.name, tools);
            }

            synced++;
          } catch (err) {
            console.warn(chalk.yellow(`  ⚠ ${entry.name}: ${err instanceof Error ? err.message : err}`));
          }
        }

        // Refresh the mcpkit-cli meta-skill for every agent these servers target.
        if (metaAgents.size > 0) {
          await writeMetaSkill({
            agents: [...metaAgents],
            scope: 'global',
            dryRun: opts?.dryRun,
            logPrefix: '  ',
          });
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
