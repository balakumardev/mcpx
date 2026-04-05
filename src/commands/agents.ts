import { Command } from 'commander';
import chalk from 'chalk';
import {
  createAgentSettings,
  getAgentDefaultsSeed,
  getAgentSettingsPath,
  isInteractiveSession,
  loadAgentSettings,
  promptForAgentSelection,
  saveAgentSettings,
} from '../agent-config.js';
import { detectAgents } from '../generators/index.js';
import { ALL_AGENTS } from '../types.js';

export function createAgentsCommand(): Command {
  return new Command('agents')
    .description('Show supported agents and configure default skill targets')
    .option('--configure', 'Interactively configure saved default agents')
    .addHelpText('after', `
Examples:
  $ mcpkit agents
  $ mcpkit agents --configure`)
    .action(async (opts?: { configure?: boolean }) => {
      try {
        const detectedAgents = detectAgents();
        const settings = await loadAgentSettings();

        if (opts?.configure) {
          if (!isInteractiveSession()) {
            console.error(chalk.red('`mcpkit agents --configure` requires an interactive terminal. Use `mcpkit install -a <agent>` to set agents non-interactively.'));
            process.exit(1);
          }

          const selectedAgents = await promptForAgentSelection({
            currentAgents: getAgentDefaultsSeed(settings, detectedAgents),
            detectedAgents,
            isFirstRun: false,
          });
          const nextSettings = createAgentSettings(selectedAgents);
          await saveAgentSettings(nextSettings);

          console.log(chalk.green(`✓ Saved default agents: ${nextSettings.enabledAgents.join(', ')}`));
          return;
        }

        console.log(chalk.bold('\nAgents\n'));
        console.log(`  Supported: ${formatAgents(ALL_AGENTS)}`);
        console.log(`  Detected:  ${formatAgents(detectedAgents)}`);
        console.log(`  Defaults:  ${formatAgents(settings?.enabledAgents ?? [])}`);
        console.log(`  Settings:  ${getAgentSettingsPath()}`);
        console.log();
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}

function formatAgents(agents: string[]): string {
  return agents.length > 0 ? agents.join(', ') : chalk.dim('none');
}
