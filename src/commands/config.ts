import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { agentsInUse, isValidAgentType, loadAgentSettings, resolveEntryAgents } from '../agent-config.js';
import { listServers } from '../config.js';
import { hasInstalledHook } from '../hook-settings.js';
import { writeMetaSkill } from '../meta-skill.js';
import { SKILL_DIR_PREFIX } from '../server-name.js';
import { neutralize } from '../session-context.js';
import {
  SKILL_MODES,
  SKILL_MODE_ENV,
  isExplicitSource,
  isSkillMode,
  loadSettings,
  resolveSkillMode,
  resolveSkillModeSource,
  saveSkillMode,
  withSkillMode,
} from '../settings.js';
import type { LoadedSettings, SkillMode } from '../settings.js';
import {
  backupRootPath,
  backupSkillDirs,
  perServerSkillOwners,
  planGuideMigration,
  removeGeneratedSkillDirs,
} from '../skill-mode-migration.js';
import type { AgentMigrationPlan } from '../skill-mode-migration.js';
import { deferredOf, loadState } from '../state.js';
import type { AdoptedRecord, McpkitState } from '../state.js';
import { runSync } from './sync.js';
import { ALL_AGENTS } from '../types.js';
import type { AgentType, ServerEntry } from '../types.js';

const MODE_HELP = `${SKILL_MODES.join(' or ')}`;

/** The agents of each registered server, for the servers whose agent list can be read, and whether the registry could be read at all. */
async function registeredServers(): Promise<{ servers: Array<{ entry: ServerEntry; agents: AgentType[] }>; readable: boolean }> {
  let servers: ServerEntry[] = [];
  let readable = true;
  try {
    servers = await listServers();
  } catch (err) {
    readable = false;
    console.warn(chalk.yellow(`Could not read the registry (${(err as Error).message.split('\n')[0]}); only agents named with --agent are considered.`));
  }
  return { servers: resolveEntryAgents(servers, await loadAgentSettings()), readable };
}

/**
 * How many of the skills the start-up reconcile kept at adoption (the names in the record) are still on
 * disk as skills mcpkit generated: a skill that `config lean on` or the cleanup of an indexed server
 * removed since is not kept any more, and one an agent on per-server skills reads (the same file) is
 * kept for that, not until indexed. A skills directory that cannot be read counts as none (nothing can be said of it).
 */
async function keptSkillCount(agent: AgentType, record: AdoptedRecord, settings: LoadedSettings): Promise<number> {
  const names = new Set(deferredOf(record));
  if (names.size === 0) return 0;
  try {
    // Without reading the registry, every agent on per-server skills owns every server: a skill one of them reads lands in `keep`, not `remove`.
    const owners = perServerSkillOwners(settings, undefined);
    const generated = new Set((await planGuideMigration(agent, owners)).remove.map((dir) => basename(dir).slice(SKILL_DIR_PREFIX.length)));
    return [...names].filter((name) => generated.has(name)).length;
  } catch {
    return 0;
  }
}

/**
 * What the start-up reconcile did for `agent` when it moved it to the guide (state.json), as one line;
 * undefined for an agent it has not moved. The skills still kept are the ones whose servers are not
 * indexed yet and whose skill is still there; the clause is left out when there are none.
 */
async function adoptionNote(agent: AgentType, state: McpkitState, settings: LoadedSettings): Promise<string | undefined> {
  if (!Object.hasOwn(state.adopted, agent)) return undefined;
  const record = state.adopted[agent];
  const date = /^\d{4}-\d{2}-\d{2}/.test(record.at) ? record.at.slice(0, 10) : neutralize(record.at);
  const moved = `${record.removed} skill${record.removed === 1 ? '' : 's'} moved${record.removed > 0 && record.backup !== null ? ` to ${neutralize(record.backup)}` : ''}`;
  // The settings say which agents are on per-server skills: what they read is not counted as kept until indexed.
  const kept = await keptSkillCount(agent, record, settings);
  return `adopted ${date}: ${moved}${kept > 0 ? `; ${kept} kept until indexed` : ''}`;
}

async function printSettings(settings: LoadedSettings): Promise<void> {
  const state = existsSync(settings.path) ? 'present' : 'not created yet: the built-in defaults apply';
  console.log(`Settings file: ${settings.path} (${state})`);
  for (const problem of settings.problems) console.warn(chalk.yellow(`Warning: ${problem}`));
  console.log();
  console.log(`Skills (${MODE_HELP}): guide (lean, the default) writes only the mcpkit-cli guide, with a live list of your servers; per-server writes one skill per registered server.`);
  // Read once: the state file is what mcpkit remembers about moving agents to the guide, and nothing here writes it.
  const { state: remembered } = loadState();
  for (const agent of ALL_AGENTS) {
    const resolved = resolveSkillMode(settings, agent);
    const source = resolved.source === 'default' ? 'built-in default' : `${resolved.source} (${resolved.detail})`;
    console.log(`  ${agent.padEnd(12)} ${resolved.mode.padEnd(11)} ${source}`);
    const adopted = await adoptionNote(agent, remembered, settings);
    if (adopted !== undefined) console.log(chalk.dim(`    ${adopted}`));
  }
  console.log();
  console.log(chalk.dim('Change it with: mcpkit config skills <per-server|guide> [--agent <agent>] [--dry-run], or mcpkit config lean <on|off>. Skills of --scope project installs are always per-server.'));
}

/**
 * Warn, once per agent, about what the guide alone cannot do. The guide carries a live list of the
 * servers (names and a few words each in its description, the whole directory in its body), but only
 * a session hook puts the full directory in front of the agent at the start of every session.
 */
async function warnAboutMissingHook(agents: AgentType[]): Promise<void> {
  for (const agent of agents) {
    if (agent === 'claude-code') {
      let text: string | undefined;
      try {
        text = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf-8');
      } catch {
        text = undefined;
      }
      if (!hasInstalledHook(text)) {
        console.warn(chalk.yellow(
          'Warning: claude-code has no SessionStart hook for mcpkit, so it learns about your servers only from the live list in the mcpkit-cli guide skill. '
          + 'For the full directory at the start of every session run `mcpkit hook install --write`, or add a pointer line to CLAUDE.md, for example: '
          + '"MCP tools are reached with `mcpkit search <words>`, `mcpkit describe <server> <tool>` and `mcpkit exec`."',
        ));
      }
    } else {
      console.warn(chalk.yellow(
        `Warning: there is no session hook for ${agent}, so it learns about your servers only from the live list in the mcpkit-cli guide skill. `
        + `For the full directory, put a pointer line in its instructions file, or paste the output of \`mcpkit hook session-start --agent ${agent} --format text\`.`,
      ));
    }
  }
}

function printGuidePlan(plan: AgentMigrationPlan, dryRun: boolean): void {
  const prefix = dryRun ? '[dry-run] ' : '';
  for (const { dir, reason } of plan.keep) console.log(`${prefix}${plan.agent}: keep ${dir} (${reason})`);
}

async function showGuideDryRun(plans: AgentMigrationPlan[], setting: string): Promise<void> {
  console.log(chalk.yellow('[dry-run] Nothing is written.'));
  console.log(`[dry-run] settings: set ${setting}`);
  for (const plan of plans) {
    console.log(`[dry-run] ${plan.agent}: write the mcpkit-cli guide ${plan.guidePath}`);
    if (plan.remove.length === 0) {
      console.log(`[dry-run] ${plan.agent}: nothing to remove (no skill generated by mcpkit in ${plan.root})`);
    } else {
      console.log(`[dry-run] ${plan.agent}: back up ${plan.remove.length} skill dir(s) to ${join(backupRootPath(), '<yyyymmddhhmmss>', plan.agent)}, then remove:`);
      for (const dir of plan.remove) console.log(`[dry-run]   remove ${dir}`);
    }
    printGuidePlan(plan, true);
  }
  await warnAboutMissingHook(plans.map((plan) => plan.agent));
}

/**
 * The agents `mode` applies to now, and the ones the environment keeps on another mode. An agent is a
 * candidate when its mode changes, or when the setting makes explicit a mode it already had by the
 * built-in default: skills written before the default became the guide are still on disk, and saying
 * `guide` is how the user asks for them to be backed up and removed.
 */
function applicableAgents(before: LoadedSettings, after: LoadedSettings, mode: SkillMode, explicit: AgentType | undefined, inUse: AgentType[]): { apply: AgentType[]; overridden: AgentType[] } {
  const changes = (agent: AgentType): boolean => {
    const was = resolveSkillModeSource(before, agent);
    const now = resolveSkillModeSource(after, agent);
    return was.mode !== now.mode || (!isExplicitSource(was.source) && isExplicitSource(now.source));
  };
  const candidates = explicit ? [explicit] : inUse.filter(changes);
  return {
    apply: candidates.filter((agent) => resolveSkillMode(after, agent).mode === mode),
    overridden: candidates.filter((agent) => resolveSkillMode(after, agent).mode !== mode),
  };
}

async function setSkills(modeArg: string, opts: { agent?: string; dryRun?: boolean }): Promise<void> {
  if (!isSkillMode(modeArg)) {
    console.error(chalk.red(`Unknown skills mode ${JSON.stringify(modeArg)}: use ${MODE_HELP}.`));
    process.exit(2);
    return;
  }
  const mode: SkillMode = modeArg;
  if (opts.agent !== undefined && !isValidAgentType(opts.agent)) {
    console.error(chalk.red(`Unknown agent ${JSON.stringify(opts.agent)}. Supported agents: ${ALL_AGENTS.join(', ')}`));
    process.exit(2);
    return;
  }
  const agent = opts.agent as AgentType | undefined;
  const dryRun = opts.dryRun === true;

  const before = await loadSettings();
  if (before.unusable) {
    console.error(chalk.red(`Cannot update ${before.path}: ${before.reason}. Nothing was written. Fix or remove it and try again.`));
    process.exit(1);
    return;
  }
  const after = withSkillMode(before, mode, agent);
  const { servers, readable } = await registeredServers();
  const inUse = agentsInUse(servers);
  const { apply, overridden } = applicableAgents(before, after, mode, agent, inUse);
  const setting = `${agent ? `skills.agents.${agent}` : 'skills.default'} = ${mode} in ${before.path}`;

  if (overridden.length > 0) {
    const forced = resolveSkillMode(after, overridden[0]).mode;
    console.warn(chalk.yellow(
      `Warning: ${SKILL_MODE_ENV}=${forced} overrides the file for every agent, so ${overridden.join(', ')} keep ${forced} skills until it is unset. `
      + 'The setting is saved, but nothing is migrated.',
    ));
  }
  if (!agent && apply.length === 0 && overridden.length === 0) {
    console.log(chalk.dim(`No agent changes mode with this setting. Use --agent <agent> to apply ${mode} to one agent now.`));
  }

  if (mode === 'guide') {
    // An agent that stays on per-server skills keeps them, also where it reads the file of an agent that moves; with no registry, all of them (fails closed).
    const owners = perServerSkillOwners(after, readable ? servers : undefined);
    const plans = await Promise.all(apply.map((target) => planGuideMigration(target, owners)));
    if (dryRun) {
      await showGuideDryRun(plans, setting);
      return;
    }
    if (apply.length > 0) console.log(chalk.blue(`Skills mode: ${apply.join(', ')} -> guide`));
    // The guide first, so that an agent is never left with neither the guide nor its skills.
    // The settings it is about to save are passed along: on disk the agent is still on its old mode, and a guide written for it then would carry no server list.
    if (apply.length > 0) await writeMetaSkill({ agents: apply, scope: 'global', logPrefix: '  ', settings: after });
    // The backup before the setting is saved and before anything is removed: a failure here changes nothing but the guide.
    const backup = await backupSkillDirs(plans);
    if (backup) console.log(chalk.green(`✓ Backed up ${plans.reduce((count, plan) => count + plan.remove.length, 0)} skill dir(s) to ${backup} (copy a directory back to restore it)`));
    await saveSkillMode(mode, agent);
    console.log(chalk.green(`✓ Saved ${setting}`));
    const removed = new Set(await removeGeneratedSkillDirs(plans));
    for (const plan of plans) {
      if (plan.remove.length === 0) console.log(chalk.dim(`${plan.agent}: nothing to remove (no skill generated by mcpkit in ${plan.root})`));
      for (const dir of plan.remove) {
        console.log(removed.has(dir)
          ? chalk.green(`✓ ${plan.agent}: removed ${dir}`)
          : chalk.yellow(`${plan.agent}: kept ${dir} (it changed after the plan was made and is no longer a skill mcpkit generated)`));
      }
      printGuidePlan(plan, false);
    }
    await warnAboutMissingHook(apply);
    return;
  }

  // per-server: the way back regenerates the skills through the normal sync path.
  if (dryRun) {
    const names = servers.filter((server) => server.agents.some((candidate) => apply.includes(candidate))).map((server) => server.entry.name);
    console.log(chalk.yellow('[dry-run] Nothing is written.'));
    console.log(`[dry-run] settings: set ${setting}`);
    if (apply.length > 0) {
      console.log(`[dry-run] ${apply.join(', ')}: regenerate the per-server skills of ${names.join(', ') || 'no registered server'} (this connects to each server, like \`mcpkit sync --force\`)`);
    }
    return;
  }

  await saveSkillMode(mode, agent);
  console.log(chalk.green(`✓ Saved ${setting}`));
  if (apply.length === 0) return;
  console.log(chalk.blue(`Skills mode: ${apply.join(', ')} -> per-server. Regenerating their skills (connects to each server, like \`mcpkit sync --force\`)...`));
  const result = await runSync(undefined, { force: true, onlyAgents: apply });
  if (result.needSignIn.length > 0) {
    // Not a failure (nothing a batch can fix): the setting is saved, and each skipped server said how to sign in.
    console.warn(chalk.yellow(
      `${result.needSignIn.length} server(s) need sign-in and were not regenerated: ${result.needSignIn.join(', ')}. The setting is saved; run \`mcpkit auth <server>\`, then \`mcpkit sync --force\`.`,
    ));
  }
  if (result.failed.length > 0) {
    console.error(chalk.red(
      `${result.failed.length} server(s) could not be regenerated: ${result.failed.join(', ')}. The setting is saved; run \`mcpkit sync --force\` to try again.`,
    ));
    process.exit(1);
  }
}

/** The action of `config skills [mode]`, and of `config lean`, which maps its on/off to a mode and comes here. */
async function runSkillsCommand(mode: string | undefined, opts: { agent?: string; dryRun?: boolean }): Promise<void> {
  try {
    if (mode === undefined) {
      if (opts.agent !== undefined || opts.dryRun) {
        console.error(chalk.red(`--agent and --dry-run need a mode: mcpkit config skills <${SKILL_MODES.join('|')}>.`));
        process.exit(2);
        return;
      }
      await printSettings(await loadSettings());
      return;
    }
    await setSkills(mode, opts);
  } catch (err) {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}

export function createConfigCommand(): Command {
  const skills = new Command('skills')
    .description('Show or set how skills are written: one per server, or only the mcpkit-cli guide')
    .argument('[mode]', `${MODE_HELP}; omit to show the current mode of every agent`)
    .option('--agent <agent>', `Apply to one agent (${ALL_AGENTS.join(', ')}); without it, to the default`)
    .option('--dry-run', 'Print what would be created, backed up and removed, and write nothing')
    .addHelpText('after', `
guide       only the mcpkit-cli guide, no per-server skills (also called lean mode, the default): the guide
            carries a live list of your servers, and \`mcpkit hook session-start\` adds the full directory
            at the start of every session (run \`mcpkit hook install --write\` for Claude Code)
per-server  one skill per registered server

Switching an agent to guide writes the guide first, copies every skill mcpkit generated for that agent
to ~/.mcpkit/skill-backups/<yyyymmddhhmmss>/<agent>/, then removes them. A skill you wrote yourself,
the mcpkit-cli guide and project-scope skills are never touched. Switching back regenerates the skills
like \`mcpkit sync --force\` for that agent.
MCPKIT_SKILLS=guide|per-server overrides the file for every agent.

Examples:
  $ mcpkit config skills                                   Show the mode of every agent
  $ mcpkit config skills guide --agent claude-code --dry-run   Preview
  $ mcpkit config skills guide --agent claude-code         Only the guide for Claude Code
  $ mcpkit config skills per-server --agent claude-code    Back to one skill per server

\`mcpkit config lean on|off\` is a short form: on is \`skills guide\`, off is \`skills per-server\`.`)
    .action(runSkillsCommand);

  const lean = new Command('lean')
    .description('lean = only the mcpkit-cli guide, no per-server skills (on is `config skills guide`, off is `config skills per-server`)')
    .argument('<state>', 'on or off')
    .option('--agent <agent>', `Apply to one agent (${ALL_AGENTS.join(', ')}); without it, to the default`)
    .option('--dry-run', 'Print what would be created, backed up and removed, and write nothing')
    .addHelpText('after', `
Same as \`mcpkit config skills guide\` (on) and \`mcpkit config skills per-server\` (off), with the same
options and the same output; see \`mcpkit config skills --help\` for what switching does.

Examples:
  $ mcpkit config lean on --dry-run                 Preview
  $ mcpkit config lean on --agent claude-code       Lean mode for Claude Code only
  $ mcpkit config lean off                          One skill per server again`)
    .action(async (state: string, opts: { agent?: string; dryRun?: boolean }) => {
      if (state !== 'on' && state !== 'off') {
        console.error(chalk.red(`Unknown lean state ${JSON.stringify(state)}: use on or off.`));
        process.exit(2);
        return;
      }
      await runSkillsCommand(state === 'on' ? 'guide' : 'per-server', opts);
    });

  return new Command('config')
    .description('Show or change mcpkit settings')
    .addCommand(skills)
    .addCommand(lean)
    .addHelpText('after', `
Settings live in ~/.mcpkit/config.yaml. \`mcpkit config\` shows them; \`mcpkit config skills\` (or \`mcpkit config lean on|off\`) changes how skills are written.`)
    .action(async () => {
      await printSettings(await loadSettings());
    });
}
