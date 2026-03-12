import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { getServer, listServers, addServer } from '../config.js';
import { discoverTools } from '../client.js';
import { getGenerator, detectAgents } from '../generators/index.js';
import { writeSkillFile } from '../skill-file.js';
import type { AgentType, ServerEntry } from '../types.js';

async function hasSkillFiles(entry: ServerEntry): Promise<boolean> {
  const ctx = { serverName: entry.name, tools: [], transport: entry.transport, scope: 'global' as const };
  for (const agent of entry.agents) {
    const generate = await getGenerator(agent);
    const skill = generate(ctx);
    if (!existsSync(skill.filePath)) return false;
  }
  return true;
}

export function createSyncCommand(): Command {
  return new Command('sync')
    .description('Sync registry — generate missing skill files and re-detect agents')
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
            // Check if skill files already exist
            if (!opts?.force && entry.agents.length > 0 && await hasSkillFiles(entry)) {
              console.log(chalk.dim(`  ⏭ ${entry.name} — skill files exist (use --force to regenerate)`));
              skipped++;
              continue;
            }

            console.log(chalk.blue(`Syncing ${entry.name}...`));

            // Connect and discover tools
            const tools = await discoverTools(entry.transport);
            console.log(`  Found ${tools.length} tool(s)`);

            // Re-detect agents (picks up newly installed agents)
            let agents = detectAgents();
            if (agents.length === 0) agents = ['claude-code'] as AgentType[];

            const ctx = { serverName: entry.name, tools, transport: entry.transport, scope: 'global' as const };

            for (const agent of agents) {
              const generate = await getGenerator(agent);
              const skill = generate(ctx);

              if (opts?.dryRun) {
                console.log(chalk.yellow(`  [dry-run] ${agent}: ${skill.filePath}`));
              } else {
                await writeSkillFile(skill.filePath, skill.content);
                console.log(chalk.green(`  ✓ ${agent}: ${skill.filePath}`));
              }
            }

            // Update registry entry
            if (!opts?.dryRun) {
              entry.toolCount = tools.length;
              entry.agents = agents;
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
