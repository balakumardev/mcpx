import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { withFileLock, writeFileAtomic } from './atomic-file.js';
import { ALL_AGENTS } from './types.js';
import type { AgentType, Scope } from './types.js';

/**
 * mcpkit's own settings, in `~/.mcpkit/config.yaml`. They are kept apart from the registry
 * (`servers.yaml`) and from the agent defaults (`settings.yaml`) because an mcpkit that does not
 * know them rewrites those two files from what it does know, which would silently drop a setting
 * written here.
 *
 * Today there is one setting, how skills are written (`skills`):
 *   guide       only the `mcpkit-cli` guide, no per-server skills (also called lean mode, the default);
 *               the agent learns about the servers from the session hook or, for an agent with no hook,
 *               from the live server list written into the guide itself
 *   per-server  one skill per registered server
 *
 * Reading never throws: a missing, unreadable or invalid file means the defaults, and
 * `LoadedSettings.problems` says what was wrong so that `mcpkit config` can report it.
 */

export const SKILL_MODES = ['per-server', 'guide'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export const DEFAULT_SKILL_MODE: SkillMode = 'guide';

/** Overrides the file for every agent: `guide` or `per-server`. */
export const SKILL_MODE_ENV = 'MCPKIT_SKILLS';

export interface SkillSettings {
  default?: SkillMode;
  agents: Partial<Record<AgentType, SkillMode>>;
}

export interface LoadedSettings {
  path: string;
  skills: SkillSettings;
  /** What was wrong with the file or the environment, one sentence each; empty when all is well. */
  problems: string[];
  /** The file exists but cannot be used at all (unreadable, not YAML, not a mapping, a newer version): a write would replace it. */
  unusable: boolean;
  /** Why the file is unusable. */
  reason?: string;
  /** Top-level keys of the file other than `version` and `skills`, kept when the file is rewritten. */
  extra: Record<string, unknown>;
}

export interface ResolvedSkillMode {
  mode: SkillMode;
  /** `default` here is the built-in fallback: nothing was configured. */
  source: 'env' | 'file' | 'default';
  /** Which setting decided: `MCPKIT_SKILLS`, `agents.<agent>` or `skills.default`. */
  detail?: string;
}

/**
 * Which setting decided the mode of an agent:
 *   env      `MCPKIT_SKILLS`
 *   agent    `skills.agents.<agent>` in the settings file
 *   default  `skills.default` in the settings file
 *   builtin  nothing was configured, so the built-in default applies
 */
export type SkillModeSource = 'env' | 'agent' | 'default' | 'builtin';

export interface SkillModeWithSource {
  mode: SkillMode;
  source: SkillModeSource;
}

/** Whether somebody chose the mode (the environment or the settings file), as opposed to the built-in default. */
export function isExplicitSource(source: SkillModeSource): boolean {
  return source === 'env' || source === 'agent' || source === 'default';
}

const FILE_VERSION = 1;

export function isSkillMode(value: unknown): value is SkillMode {
  return typeof value === 'string' && (SKILL_MODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

export function getSettingsPath(): string {
  return join(homedir(), '.mcpkit', 'config.yaml');
}

/**
 * The mode `MCPKIT_SKILLS` asks for, or what is wrong with its value (an empty value counts as unset).
 * Only a valid value is a choice: an invalid one is ignored everywhere (`mcpkit config` says so, and the
 * start-up reconcile treats the variable as unset).
 */
export function readEnvMode(env: NodeJS.ProcessEnv): { mode?: SkillMode; problem?: string } {
  const raw = env[SKILL_MODE_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return {};
  if (isSkillMode(raw)) return { mode: raw };
  return { problem: `${SKILL_MODE_ENV}=${describeValue(env[SKILL_MODE_ENV])} is ignored: it must be ${SKILL_MODES.join(' or ')}.` };
}

function parseSkillsSection(skills: unknown, problems: string[], path: string): SkillSettings {
  const result: SkillSettings = { agents: {} };
  if (skills === undefined || skills === null) return result;
  if (!isRecord(skills)) {
    problems.push(`${path}: "skills" must be a mapping, so it is ignored.`);
    return result;
  }
  if (skills.default !== undefined) {
    if (isSkillMode(skills.default)) result.default = skills.default;
    else problems.push(`${path}: skills.default ${describeValue(skills.default)} is ignored: it must be ${SKILL_MODES.join(' or ')}.`);
  }
  if (skills.agents !== undefined && skills.agents !== null) {
    if (!isRecord(skills.agents)) {
      problems.push(`${path}: skills.agents must be a mapping, so it is ignored.`);
    } else {
      for (const [agent, mode] of Object.entries(skills.agents)) {
        if (!(ALL_AGENTS as string[]).includes(agent)) {
          problems.push(`${path}: skills.agents has an unknown agent ${describeValue(agent)}, so it is ignored. Known agents: ${ALL_AGENTS.join(', ')}.`);
        } else if (!isSkillMode(mode)) {
          problems.push(`${path}: skills.agents.${agent} ${describeValue(mode)} is ignored: it must be ${SKILL_MODES.join(' or ')}.`);
        } else {
          result.agents[agent as AgentType] = mode;
        }
      }
    }
  }
  return result;
}

/** The settings file, tolerantly: it never throws, and anything it cannot use falls back to the defaults. */
export async function loadSettings(): Promise<LoadedSettings> {
  const problems: string[] = [];
  const envProblem = readEnvMode(process.env).problem;
  if (envProblem) problems.push(envProblem);
  const loaded: LoadedSettings = { path: '', skills: { agents: {} }, problems, unusable: false, extra: {} };

  try {
    loaded.path = getSettingsPath();
  } catch (err) {
    problems.push(`The home directory cannot be found (${messageOf(err)}), so the settings file is not read.`);
    return loaded;
  }
  const { path } = loaded;
  const unusable = (reason: string): LoadedSettings => {
    problems.unshift(`${path}: ${reason}; the defaults are used.`);
    return { ...loaded, unusable: true, reason };
  };

  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? loaded : unusable(`cannot read it (${messageOf(err)})`);
  }

  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    return unusable(`it is not valid YAML (${messageOf(err)})`);
  }
  if (data === null || data === undefined) return loaded;
  if (!isRecord(data)) return unusable('it must be a mapping');
  if (data.version !== undefined && data.version !== FILE_VERSION) {
    return unusable(`its version is ${describeValue(data.version)}, but this mcpkit reads version ${FILE_VERSION} (it was written by another mcpkit)`);
  }

  const { skills, ...extra } = data;
  delete extra.version;
  loaded.extra = extra;
  loaded.skills = parseSkillsSection(skills, problems, path);
  return loaded;
}

/**
 * The mode of `agent` and what decided it: the environment, then its own entry, then the default
 * entry, then the built-in default (`guide`). `builtin` means nothing was configured.
 */
export function resolveSkillModeSource(settings: LoadedSettings, agent: AgentType, env: NodeJS.ProcessEnv = process.env): SkillModeWithSource {
  const fromEnv = readEnvMode(env).mode;
  if (fromEnv) return { mode: fromEnv, source: 'env' };
  const own = settings.skills.agents[agent];
  if (own) return { mode: own, source: 'agent' };
  if (settings.skills.default) return { mode: settings.skills.default, source: 'default' };
  return { mode: DEFAULT_SKILL_MODE, source: 'builtin' };
}

/** The mode of `agent`, with the setting that decided it named in `detail` (see `resolveSkillModeSource`). */
export function resolveSkillMode(settings: LoadedSettings, agent: AgentType, env: NodeJS.ProcessEnv = process.env): ResolvedSkillMode {
  const { mode, source } = resolveSkillModeSource(settings, agent, env);
  switch (source) {
    case 'env': return { mode, source: 'env', detail: SKILL_MODE_ENV };
    case 'agent': return { mode, source: 'file', detail: `agents.${agent}` };
    case 'default': return { mode, source: 'file', detail: 'skills.default' };
    case 'builtin': return { mode, source: 'default' };
  }
}

export async function skillModeFor(agent: AgentType): Promise<SkillMode> {
  return resolveSkillMode(await loadSettings(), agent).mode;
}

/**
 * The agents of `agents`, in order, that get a per-server skill. Skills of project scope are
 * explicit, written into the project that asked for them, so the mode (which governs the global
 * skills) never removes one.
 */
export async function perServerAgents(agents: AgentType[], scope: Scope = 'global'): Promise<AgentType[]> {
  if (scope === 'project') return agents;
  const settings = await loadSettings();
  return agents.filter((agent) => resolveSkillMode(settings, agent).mode === 'per-server');
}

function render(settings: LoadedSettings): string {
  const skills: Record<string, unknown> = {};
  if (settings.skills.default) skills.default = settings.skills.default;
  if (Object.keys(settings.skills.agents).length > 0) skills.agents = settings.skills.agents;
  return stringify({ version: FILE_VERSION, ...settings.extra, skills });
}

/** `settings` with `mode` set for `agent`, or as the default when `agent` is not given; the input is not changed. */
export function withSkillMode(settings: LoadedSettings, mode: SkillMode, agent?: AgentType): LoadedSettings {
  const next: LoadedSettings = { ...settings, skills: { ...settings.skills, agents: { ...settings.skills.agents } } };
  if (agent) next.skills.agents[agent] = mode;
  else next.skills.default = mode;
  return next;
}

/**
 * Save a mode for one agent, or for the default when `agent` is not given. The file is read again
 * under a lock, so two saves at once keep both, and replaced atomically with owner-only
 * permissions. A file that cannot be used is never overwritten: the error says so and nothing is
 * written. Throws when the file cannot be written (a read-only home, for one).
 */
export async function saveSkillMode(mode: SkillMode, agent?: AgentType): Promise<LoadedSettings> {
  const path = getSettingsPath();
  return withFileLock(`${path}.lock`, async () => {
    const current = await loadSettings();
    if (current.unusable) {
      throw new Error(`Cannot update ${path}: ${current.reason}. Nothing was written. Fix or remove ${path} and try again.`);
    }
    const next = withSkillMode(current, mode, agent);
    await writeFileAtomic(path, render(next), { mode: 0o600 });
    return next;
  });
}
