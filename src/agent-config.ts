import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { parse, stringify } from 'yaml';
import type { AgentSelectionMode, AgentSettings, AgentType, ServerEntry } from './types.js';
import { ALL_AGENTS } from './types.js';

const DEFAULT_FALLBACK_AGENT: AgentType = 'claude-code';

export interface InstallAgentSelectionOptions {
  includeAgents: string[];
  excludeAgents: string[];
  interactive?: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  detectedAgents?: AgentType[];
  settings?: AgentSettings | null;
  promptForAgents?: (options: PromptForAgentsOptions) => Promise<AgentType[]>;
}

export interface InstallAgentSelectionResult {
  agents: AgentType[];
  selectionMode: AgentSelectionMode;
  source: 'explicit' | 'defaults' | 'detected' | 'fallback' | 'interactive';
  settingsToSave?: AgentSettings;
}

export interface ResolvedServerAgents {
  agents: AgentType[];
  selectionMode: AgentSelectionMode;
  source: 'explicit' | 'defaults' | 'legacy' | 'fallback';
}

export interface PromptForAgentsOptions {
  currentAgents: AgentType[];
  detectedAgents: AgentType[];
  isFirstRun: boolean;
}

export function getAgentSettingsPath(): string {
  return join(homedir(), '.mcpkit', 'settings.yaml');
}

export function isValidAgentType(value: string): value is AgentType {
  return ALL_AGENTS.includes(value as AgentType);
}

export function normalizeAgentList(values: Iterable<string>, context = 'agent'): AgentType[] {
  const normalized: AgentType[] = [];
  const seen = new Set<AgentType>();

  for (const value of values) {
    if (!isValidAgentType(value)) {
      throw new Error(`Unknown ${context} "${value}". Supported agents: ${ALL_AGENTS.join(', ')}`);
    }
    if (!seen.has(value)) {
      normalized.push(value);
      seen.add(value);
    }
  }

  return normalized;
}

export function getDetectedAgentsWithFallback(detectedAgents: AgentType[] = []): AgentType[] {
  return detectedAgents.length > 0 ? detectedAgents : [DEFAULT_FALLBACK_AGENT];
}

export function getAgentDefaultsSeed(settings: AgentSettings | null | undefined, detectedAgents: AgentType[]): AgentType[] {
  if (settings?.enabledAgents.length) {
    return settings.enabledAgents;
  }
  return getDetectedAgentsWithFallback(detectedAgents);
}

function validateSettings(data: unknown): AgentSettings | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;

  if (raw.version !== 1) return null;
  if (!Array.isArray(raw.enabledAgents)) return null;
  if (typeof raw.updatedAt !== 'string') return null;

  try {
    return {
      version: 1,
      enabledAgents: normalizeAgentList(raw.enabledAgents as string[], 'default agent'),
      updatedAt: raw.updatedAt,
    };
  } catch {
    return null;
  }
}

export async function loadAgentSettings(): Promise<AgentSettings | null> {
  try {
    const content = await readFile(getAgentSettingsPath(), 'utf-8');
    const parsed = parse(content);
    const settings = validateSettings(parsed);
    if (!settings) {
      console.warn(chalk.yellow('Warning: settings.yaml is invalid, ignoring saved agent defaults'));
      return null;
    }
    return settings;
  } catch {
    return null;
  }
}

export async function saveAgentSettings(settings: AgentSettings): Promise<void> {
  await mkdir(join(homedir(), '.mcpkit'), { recursive: true });
  await writeFile(getAgentSettingsPath(), stringify(settings), 'utf-8');
}

export function createAgentSettings(enabledAgents: AgentType[], now = new Date().toISOString()): AgentSettings {
  const normalized = normalizeAgentList(enabledAgents, 'default agent');
  if (normalized.length === 0) {
    throw new Error('At least one default agent must be selected.');
  }

  return {
    version: 1,
    enabledAgents: normalized,
    updatedAt: now,
  };
}

export function isInteractiveSession(
  stdinIsTTY = process.stdin.isTTY ?? false,
  stdoutIsTTY = process.stdout.isTTY ?? false,
): boolean {
  return Boolean(stdinIsTTY && stdoutIsTTY);
}

export function parseAgentSelectionInput(input: string, currentAgents: AgentType[]): AgentType[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return currentAgents;
  }

  if (trimmed.toLowerCase() === 'all') {
    return [...ALL_AGENTS];
  }

  const selected = new Set<AgentType>();
  const tokens = trimmed.split(/[,\s]+/).filter(Boolean);

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1;
      const agent = ALL_AGENTS[index];
      if (!agent) {
        throw new Error(`Unknown agent index "${token}". Choose 1-${ALL_AGENTS.length}.`);
      }
      selected.add(agent);
      continue;
    }

    if (!isValidAgentType(token)) {
      throw new Error(`Unknown agent "${token}". Supported agents: ${ALL_AGENTS.join(', ')}`);
    }
    selected.add(token);
  }

  if (selected.size === 0) {
    throw new Error('At least one agent must be selected.');
  }

  return ALL_AGENTS.filter(agent => selected.has(agent));
}

export async function promptForAgentSelection(options: PromptForAgentsOptions): Promise<AgentType[]> {
  const { currentAgents, detectedAgents, isFirstRun } = options;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log();
    if (isFirstRun) {
      console.log(chalk.blue('Choose which agent skill files mcpkit should manage by default.'));
      console.log(chalk.dim('Detected agents are preselected. Press Enter to accept the current selection.'));
    } else {
      console.log(chalk.blue('Update your default agent selection for future installs and syncs.'));
      console.log(chalk.dim('Press Enter to keep the current defaults.'));
    }
    console.log();

    for (const [index, agent] of ALL_AGENTS.entries()) {
      const isSelected = currentAgents.includes(agent);
      const detectedLabel = detectedAgents.includes(agent) ? chalk.dim(' (detected)') : '';
      console.log(`  ${index + 1}. [${isSelected ? 'x' : ' '}] ${agent}${detectedLabel}`);
    }

    console.log();

    while (true) {
      const answer = await rl.question('Select agents by number or name (comma-separated, or "all"): ');
      try {
        return parseAgentSelectionInput(answer, currentAgents);
      } catch (error) {
        console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
      }
    }
  } finally {
    rl.close();
  }
}

function subtractAgents(baseAgents: AgentType[], excludeAgents: AgentType[]): AgentType[] {
  const excluded = new Set(excludeAgents);
  return baseAgents.filter(agent => !excluded.has(agent));
}

export async function resolveInstallAgentSelection(
  options: InstallAgentSelectionOptions,
): Promise<InstallAgentSelectionResult> {
  const detectedAgents = normalizeAgentList(options.detectedAgents ?? [], 'detected agent');
  const settings = options.settings ?? null;
  const includeAgents = normalizeAgentList(options.includeAgents, 'agent');
  const excludeAgents = normalizeAgentList(options.excludeAgents, 'excluded agent');
  const interactive = options.interactive ?? false;
  const canPrompt = isInteractiveSession(options.stdinIsTTY, options.stdoutIsTTY);

  if (interactive && (includeAgents.length > 0 || excludeAgents.length > 0)) {
    throw new Error('`--interactive` cannot be combined with `--agent` or `--exclude-agent`.');
  }

  if (interactive && !canPrompt) {
    throw new Error('`--interactive` requires an interactive terminal.');
  }

  if (includeAgents.length > 0 || excludeAgents.length > 0) {
    const baseAgents = includeAgents.length > 0
      ? includeAgents
      : getAgentDefaultsSeed(settings, detectedAgents);
    const agents = subtractAgents(baseAgents, excludeAgents);
    if (agents.length === 0) {
      throw new Error('At least one agent must remain after applying `--exclude-agent`.');
    }
    return {
      agents,
      selectionMode: 'explicit',
      source: 'explicit',
    };
  }

  if (interactive) {
    const currentAgents = getAgentDefaultsSeed(settings, detectedAgents);
    const prompt = options.promptForAgents ?? promptForAgentSelection;
    const agents = normalizeAgentList(await prompt({
      currentAgents,
      detectedAgents,
      isFirstRun: false,
    }), 'selected agent');
    return {
      agents,
      selectionMode: 'defaults',
      source: 'interactive',
      settingsToSave: createAgentSettings(agents),
    };
  }

  if (settings?.enabledAgents.length) {
    return {
      agents: settings.enabledAgents,
      selectionMode: 'defaults',
      source: 'defaults',
    };
  }

  if (canPrompt) {
    const currentAgents = getAgentDefaultsSeed(null, detectedAgents);
    const prompt = options.promptForAgents ?? promptForAgentSelection;
    const agents = normalizeAgentList(await prompt({
      currentAgents,
      detectedAgents,
      isFirstRun: true,
    }), 'selected agent');
    return {
      agents,
      selectionMode: 'defaults',
      source: 'interactive',
      settingsToSave: createAgentSettings(agents),
    };
  }

  if (detectedAgents.length > 0) {
    return {
      agents: detectedAgents,
      selectionMode: 'defaults',
      source: 'detected',
    };
  }

  return {
    agents: [DEFAULT_FALLBACK_AGENT],
    selectionMode: 'defaults',
    source: 'fallback',
  };
}

export function resolveServerAgents(
  entry: ServerEntry,
  settings: AgentSettings | null | undefined,
): ResolvedServerAgents {
  const selectionMode = entry.agentSelectionMode ?? 'defaults';

  if (selectionMode === 'explicit') {
    const agents = normalizeAgentList(entry.agents, 'server agent');
    if (agents.length === 0) {
      return {
        agents: [DEFAULT_FALLBACK_AGENT],
        selectionMode,
        source: 'fallback',
      };
    }
    return {
      agents,
      selectionMode,
      source: 'explicit',
    };
  }

  if (settings?.enabledAgents.length) {
    return {
      agents: settings.enabledAgents,
      selectionMode,
      source: 'defaults',
    };
  }

  const legacyAgents = normalizeAgentList(entry.agents, 'server agent');
  if (legacyAgents.length > 0) {
    return {
      agents: legacyAgents,
      selectionMode,
      source: 'legacy',
    };
  }

  return {
    agents: [DEFAULT_FALLBACK_AGENT],
    selectionMode,
    source: 'fallback',
  };
}

export function describeAgentSource(source: InstallAgentSelectionResult['source'] | ResolvedServerAgents['source']): string {
  switch (source) {
    case 'explicit':
      return 'explicit CLI selection';
    case 'defaults':
      return 'saved defaults';
    case 'detected':
      return 'detected installed agents';
    case 'fallback':
      return 'fallback default';
    case 'interactive':
      return 'interactive default selection';
    case 'legacy':
      return 'stored server agents';
  }
}

