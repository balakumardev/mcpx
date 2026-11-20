import { Command } from 'commander';
import chalk from 'chalk';
import { getServer, removeServer, updateServer } from '../config.js';
import { getGenerator } from '../generators/index.js';
import { loadAgentSettings, normalizeAgentList, resolveServerAgents } from '../agent-config.js';
import { reconcileAfterChange } from '../reconcile.js';
import { stopRuntime } from '../runtime-manager.js';
import { removeSchemaCache } from '../schema-store.js';
import { removeSkillDirectory } from '../skill-file.js';
import { ALL_AGENTS } from '../types.js';
import type { AgentType } from '../types.js';

/** Best-effort: a leftover cache file is harmless and must not fail the removal. */
async function dropSchemaCache(name: string): Promise<void> {
  try {
    await removeSchemaCache(name);
  } catch (err) {
    console.error(chalk.dim(
      `⚠ could not remove the tool schema cache for "${name}" (${err instanceof Error ? err.message : err})`,
    ));
  }
}

export function createRemoveCommand(): Command {
  return new Command('remove')
    .description('Remove an installed MCP server')
    .argument('<name>', 'Server name to remove')
    .option('-a, --agent <agent>', `Remove only for specific agent (${ALL_AGENTS.join(', ')})`)
    .addHelpText('after', `
Examples:
  $ mcpkit remove github              Remove server and all skill files
  $ mcpkit remove github -a cursor    Remove only Cursor skill files`)
    .action(async (name: string, opts) => {
      try {
        const entry = await getServer(name);
        if (!entry) {
          console.error(chalk.red(`Server "${name}" not found. Run 'mcpkit list' to see registered servers.`));
          process.exit(1);
        }

        const settings = await loadAgentSettings();
        const resolved = resolveServerAgents(entry, settings);
        const trackedAgents = Array.from(new Set([...entry.agents, ...resolved.agents]));
        const requestedAgents: AgentType[] = opts.agent
          ? normalizeAgentList([opts.agent], 'agent')
          : trackedAgents;
        const agentsToRemove: AgentType[] = requestedAgents.filter(agent => trackedAgents.includes(agent));
        const ctx = { serverName: name, tools: [], transport: entry.transport, scope: 'global' as const };

        for (const agent of agentsToRemove) {
          const generate = await getGenerator(agent);
          const skill = generate(ctx);

          try {
            // All generators now use SKILL.md in a skill directory — remove the directory
            await removeSkillDirectory(skill.filePath);
            console.log(chalk.green(`✓ Removed ${agent} skill: ${skill.filePath}`));
          } catch {
            console.log(chalk.dim(`  ${agent}: nothing to remove`));
          }
        }

        if (!opts.agent) {
          await stopRuntime(name, { removeLog: true });
          await removeServer(name);
          await dropSchemaCache(name);
          console.log(chalk.green(`✓ Server "${name}" removed from registry`));
        } else {
          const nextAgents = resolved.agents.filter(a => a !== opts.agent);
          entry.agentSelectionMode = 'explicit';
          entry.agents = nextAgents;
          if (entry.agents.length === 0) {
            await stopRuntime(name, { removeLog: true });
            await removeServer(name);
            await dropSchemaCache(name);
            console.log(chalk.green(`✓ Server "${name}" removed from registry (no agents left)`));
          } else {
            entry.updatedAt = new Date().toISOString();
            await updateServer(name, (current) => {
              current.agentSelectionMode = entry.agentSelectionMode;
              current.agents = entry.agents;
              current.updatedAt = entry.updatedAt;
            });
            console.log(chalk.green(`✓ Removed ${opts.agent} skill for "${name}"`));
          }
        }
        // The guide still lists the server until it is rewritten.
        await reconcileAfterChange();
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
