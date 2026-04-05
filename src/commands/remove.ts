import { Command } from 'commander';
import chalk from 'chalk';
import { getServer, removeServer, addServer } from '../config.js';
import { getGenerator } from '../generators/index.js';
import { loadAgentSettings, normalizeAgentList, resolveServerAgents } from '../agent-config.js';
import { removeSkillDirectory } from '../skill-file.js';
import { ALL_AGENTS } from '../types.js';
import type { AgentType } from '../types.js';

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
          await removeServer(name);
          console.log(chalk.green(`✓ Server "${name}" removed from registry`));
        } else {
          const nextAgents = resolved.agents.filter(a => a !== opts.agent);
          entry.agentSelectionMode = 'explicit';
          entry.agents = nextAgents;
          if (entry.agents.length === 0) {
            await removeServer(name);
            console.log(chalk.green(`✓ Server "${name}" removed from registry (no agents left)`));
          } else {
            entry.updatedAt = new Date().toISOString();
            await addServer(entry);
            console.log(chalk.green(`✓ Removed ${opts.agent} skill for "${name}"`));
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
