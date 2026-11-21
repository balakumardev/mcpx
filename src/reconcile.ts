import { createHash } from 'node:crypto';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Command } from 'commander';
import { agentsInUse, getAgentSettingsPath, loadAgentSettings, resolveEntryAgents } from './agent-config.js';
import { tryWithFileLock } from './atomic-file.js';
import { getRegistryPath, loadRegistry } from './config.js';
import { directoryFromSnapshot, loadDirectorySnapshot, snapshotSource } from './directory-snapshot.js';
import type { DirectorySnapshot } from './directory-snapshot.js';
import { detectHomeAgents } from './generators/index.js';
import { DEFAULT_MATCHER, SettingsRefusal, UnsafeRewrite, backupFile, hasInstalledHook, installHook, writeSettings } from './hook-settings.js';
import { defaultPkgVersion, guideIsCurrent, writeMetaSkill } from './meta-skill.js';
import { schemaCacheDir } from './schema-store.js';
import { SKILL_DIR_PREFIX } from './server-name.js';
import { getSettingsPath, loadSettings, readEnvMode, resolveSkillModeSource } from './settings.js';
import type { LoadedSettings } from './settings.js';
import { backupSkillDirs, perServerSkillOwners, planGuideMigration, removeGeneratedSkillDirs } from './skill-mode-migration.js';
import type { AgentMigrationPlan } from './skill-mode-migration.js';
import { deferredOf, loadState, updateState } from './state.js';
import type { GuideFileSignature, McpkitState } from './state.js';
import { ALL_AGENTS } from './types.js';
import type { AgentSettings, AgentType, ServerEntry } from './types.js';

/**
 * The start-up reconcile: what mcpkit does on the next use after an upgrade, and after a change,
 * so that its own files match the default (lean) skills mode without the user doing anything.
 *
 *   freshness   the `mcpkit-cli` guide of every agent in guide mode lists the servers that are
 *               registered now (rewritten when it does not);
 *   adoption    an agent that is on the built-in default, and has not been moved yet, has the
 *               per-server skills mcpkit generated for it backed up and removed, once, and gets the
 *               SessionStart hook (Claude Code; a hook that could not be added is tried again when its
 *               settings file changes);
 *   deferred    a skill kept at adoption because the server's tool list existed nowhere else is
 *               removed once the schema cache has it.
 *
 * Only an agent that is installed on this machine (its home directory is there), or already has an
 * mcpkit guide or skills mcpkit generated, is touched: one that is merely named in the registry gets no
 * folder. An agent whose guide cannot be written is left exactly as it is, per-server skills included:
 * the guide always comes first, so nobody is left with neither.
 *
 * It reads and writes files only: it never contacts an MCP server, starts a process, prints, throws
 * or waits for another mcpkit (a held lock means "somebody else is doing it"). Whatever it did is in
 * the report, and the caller prints `formatNotices(report)` to stderr.
 */

export type CommandClass = 'skip' | 'refresh' | 'full';
export type ReconcileKind = 'refresh' | 'full';

/**
 * What start-up does for the command at `path` (the whole path: `['hook', 'session-start']`):
 *   skip     nothing at all: `hook` and `config` (they manage exactly what this would change, and a hook must
 *            stay silent), and every internal command (a name that starts with `_`, `runtime _host`);
 *   refresh  only the guide's freshness: `call` and `exec`, which an agent runs in the middle of a session
 *            that still lists the skills it started with, so nothing is removed under it;
 *   full     everything else.
 */
export function classifyCommand(path: string[]): CommandClass {
  if (path.length === 0) return 'skip';
  if (path.some((name) => name.startsWith('_'))) return 'skip';
  const [first] = path;
  if (first === 'hook' || first === 'config') return 'skip';
  if (first === 'call' || first === 'exec') return 'refresh';
  return 'full';
}

export type ReconcileAction =
  | { type: 'guide-written'; agent: AgentType }
  | { type: 'adopted'; agent: AgentType; removed: number; backup: string | null; deferred: string[] }
  | { type: 'deferred-removed'; agent: AgentType; removed: number; backup: string | null }
  | { type: 'hook-added'; agent: AgentType; path: string; /** Added by a later run, not by the one that adopted the agent. */ retried?: boolean };

export interface ReconcileReport {
  /** Why nothing was done, when that is so (an opt-out, an unusable file, a busy lock, nothing to reconcile). */
  skipped?: string;
  /** The inputs were as they were after the last good pass, so nothing was read but `stat` data. */
  fast?: boolean;
  /** An unexpected error that cut the run short. */
  failed?: string;
  /** Sentences for the user about something that could not be done (one the notice carries as it is). */
  notices: string[];
  /** The same `notices` were already printed in the last 24 hours (state.json `lastNotice`), so `formatNotices` leaves them out. */
  noticesSuppressed?: boolean;
  /** What was done. */
  actions: ReconcileAction[];
  ms: number;
}

export interface ReconcileOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  pkgVersion?: string;
}

/** A lock older than this belongs to a process that died. */
const LOCK_STALE_MS = 60_000;
/** The state file is written inside the reconcile: never wait long for it. */
const STATE_LOCK = { timeoutMs: 1500 };
/** A failure notice that was printed is not printed again, unchanged, for this long. */
const NOTICE_REPEAT_MS = 24 * 60 * 60 * 1000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

/** The name of the temp file `writeFileAtomic` makes beside its target (`<file>.<pid>.<8 hex>.tmp`): it holds the process id and random bytes, so it differs on every run. */
const TEMP_FILE_SUFFIX = /\.\d+\.[0-9a-f]{8}\.tmp\b/g;

/** `text` without the temp file names of atomic writes: what a failure notice is shown and compared with the next run's by. */
const withoutTempNames = (text: string): string => text.replace(TEMP_FILE_SUFFIX, '');

/** A notice is said once per run, whoever finds it. */
function addNotice(report: ReconcileReport, text: string): void {
  if (!report.notices.includes(text)) report.notices.push(text);
}

function isEnoent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** `console` silenced: the loaders warn about what they skip, and this runs in front of every command. */
function muteConsole(): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const saved = methods.map((method) => console[method]);
  for (const method of methods) console[method] = () => {};
  return () => {
    methods.forEach((method, index) => { console[method] = saved[index]; });
  };
}

/** `stat` data for one file as text; two reads of an unchanged file give the same text, and a rewrite (an atomic rename included) gives another. */
async function signatureOf(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}:${info.ino}`;
  } catch (err) {
    return isEnoent(err) ? 'absent' : `error:${(err as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

/**
 * A hash of everything the reconcile decides from, read with `stat` only: the version of this mcpkit,
 * the registry, the schema caches, the two settings files, the variable that moves Hermes' skills, and
 * which agents are installed (an agent that is installed later must get its guide). The files this
 * reconcile itself writes (the guides, the state, the skills it removes, the hook) are not inputs.
 */
async function computeFingerprint(pkgVersion: string): Promise<string> {
  const files = [getRegistryPath(), getSettingsPath(), getAgentSettingsPath()];
  const cacheDir = schemaCacheDir();
  let caches: string[] = [];
  try {
    caches = (await readdir(cacheDir)).filter((name) => name.endsWith('.json')).sort().map((name) => join(cacheDir, name));
  } catch {
    // No schema directory: no caches.
  }
  const lines = await Promise.all([...files, ...caches].map(async (path) => `${path}=${await signatureOf(path)}`));
  const parts = ['reconcile-fingerprint-2', `version=${pkgVersion}`, `HERMES_HOME=${process.env.HERMES_HOME ?? ''}`, `installed=${detectHomeAgents().join(',')}`, ...lines];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function isGuideFiles(value: unknown): value is Record<string, GuideFileSignature> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'object' && entry !== null
      && typeof (entry as GuideFileSignature).path === 'string' && typeof (entry as GuideFileSignature).sig === 'string');
}

/** Whether the guide files of a pass are all still there as it left them. Reads `stat` data only. */
async function guideFilesHold(files: unknown): Promise<boolean> {
  if (!isGuideFiles(files)) return false;
  const checks = await Promise.all(Object.values(files).map(async ({ path, sig }) => (await signatureOf(path)) === sig));
  return checks.every(Boolean);
}

/**
 * Whether the last good pass saw these inputs, and the guide files it left are still there as it left
 * them. A full run accepts only a full pass (a refresh pass adopts nothing, so it can never stand in for
 * one); a refresh run accepts either. Reads `stat` data only.
 */
async function lastPassStillHolds(state: McpkitState, fingerprint: string, kind: ReconcileKind): Promise<boolean> {
  if (state.fingerprint === fingerprint && await guideFilesHold(state.guideFiles)) return true;
  return kind === 'refresh' && state.refreshFingerprint === fingerprint && await guideFilesHold(state.refreshGuideFiles);
}

const SETTINGS_RELATIVE = join('.claude', 'settings.json');

/** `<mtimeMs>:<size>` of the Claude Code settings file, `absent` when there is none: what a failed hook attempt is remembered by. */
async function hookSettingsSignature(): Promise<string> {
  try {
    const info = await stat(join(homedir(), SETTINGS_RELATIVE));
    return `${info.mtimeMs}:${info.size}`;
  } catch (err) {
    return isEnoent(err) ? 'absent' : `error:${(err as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

/** Whether Claude Code was adopted without its hook getting in, and its settings file is not the one the last failed attempt saw (or no attempt was made: a run that stopped in between). `stat` only. */
async function hookRetryDue(state: McpkitState): Promise<boolean> {
  if (state.hookDeclined) return false;
  const record = Object.hasOwn(state.adopted, 'claude-code') ? state.adopted['claude-code'] : undefined;
  if (record?.hookPending !== true) return false;
  return record.hookTried !== await hookSettingsSignature();
}

interface Gathered {
  settings: LoadedSettings;
  entries: ServerEntry[];
  /** The saved default agents (settings.yaml), read once: the same ones pick the agents in use and the servers of each guide. */
  agentSettings: AgentSettings | null;
  /** The agents the reconcile looks at, in order. */
  agents: AgentType[];
  /** What each agent's skills directory holds; an agent whose directory cannot be read has none. */
  plans: Map<AgentType, AgentMigrationPlan>;
}

/** What a pass that is going to change something works from: `Gathered`, and the registry and schema caches read once for every agent. */
interface Loaded extends Gathered {
  snapshot: DirectorySnapshot;
}

type GatherResult = { gathered: Gathered } | { skipped: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read what decides the run, without writing anything: the settings (an unusable file means the
 * defaults, and defaults mean the guide, which is no ground to delete skills), the registry (a
 * missing one is no servers, one that cannot be read is no ground for anything), and the agents to
 * look at: those that a registered server is installed for and that are installed on this machine, and
 * those that already have a guide or skills mcpkit generated (whatever the registry says: they are
 * there, so their guide must be too). An agent that a server names but that is not installed gets no
 * folder made for it.
 */
async function gather(env: NodeJS.ProcessEnv): Promise<GatherResult> {
  const settings = await loadSettings();
  if (settings.unusable) return { skipped: `${settings.path} cannot be used: ${settings.reason}` };

  let entries: ServerEntry[];
  try {
    entries = Object.values((await loadRegistry()).servers);
  } catch (err) {
    return { skipped: `the registry cannot be read: ${messageOf(err)}` };
  }

  const agentSettings = await loadAgentSettings();
  const resolved = resolveEntryAgents(entries, agentSettings);
  const inUse = agentsInUse(resolved);
  // The skills of the agents on per-server skills: no plan removes them from a skills directory another agent shares.
  const owners = perServerSkillOwners(settings, resolved, env);
  const installed = new Set(detectHomeAgents());
  const plans = new Map<AgentType, AgentMigrationPlan>();
  const agents: AgentType[] = [];
  for (const agent of ALL_AGENTS) {
    let plan: AgentMigrationPlan | undefined;
    try {
      plan = await planGuideMigration(agent, owners);
      plans.set(agent, plan);
    } catch {
      // The skills directory cannot be read: nothing is removed from it, but an agent in use still gets its guide.
    }
    const named = inUse.includes(agent) && installed.has(agent);
    if (named || plan !== undefined && (plan.remove.length > 0 || await exists(plan.guidePath))) agents.push(agent);
  }
  return { gathered: { settings, entries, agentSettings, agents, plans } };
}

/** The guide files of the agents that are in guide mode, as they are now; undefined when one of them is missing. */
async function guideFilesOf(gathered: Gathered, env: NodeJS.ProcessEnv): Promise<Record<string, GuideFileSignature> | undefined> {
  const files: Record<string, GuideFileSignature> = {};
  for (const agent of gathered.agents) {
    if (resolveSkillModeSource(gathered.settings, agent, env).mode !== 'guide') continue;
    const plan = gathered.plans.get(agent);
    if (plan === undefined) return undefined;
    const sig = await signatureOf(plan.guidePath);
    if (sig === 'absent' || sig.startsWith('error:')) return undefined;
    files[agent] = { path: plan.guidePath, sig };
  }
  return files;
}

const serverOf = (dir: string): string => basename(dir).slice(SKILL_DIR_PREFIX.length);

/** The names of the servers the guide of `agent` lists, with those whose tool list is in a schema cache apart. */
function indexedServers(l: Loaded, agent: AgentType): { listed: Set<string>; indexed: Set<string> } {
  const { servers } = directoryFromSnapshot(l.snapshot, agent);
  return {
    listed: new Set(servers.map((server) => server.name)),
    indexed: new Set(servers.filter((server) => server.tools !== undefined).map((server) => server.name)),
  };
}

/**
 * Copy the skills of `plans` to one backup (one directory for the whole run). When that fails, each
 * plan is tried alone, so one agent that cannot be backed up does not hold the others. Maps each
 * agent that has a backup to its directory; an agent with no entry must not have anything removed.
 */
async function backUp(plans: AgentMigrationPlan[], now: Date, report: ReconcileReport): Promise<Map<AgentType, string>> {
  const backups = new Map<AgentType, string>();
  if (plans.length === 0) return backups;
  try {
    const dir = await backupSkillDirs(plans, now);
    if (dir !== undefined) for (const plan of plans) backups.set(plan.agent, dir);
    return backups;
  } catch {
    for (const plan of plans) {
      try {
        const dir = await backupSkillDirs([plan], now);
        if (dir !== undefined) backups.set(plan.agent, dir);
      } catch (err) {
        report.notices.push(`could not back up the ${plan.agent} per-server skills (${messageOf(err)}); they were left as they are`);
      }
    }
    return backups;
  }
}

/** Remove the skills of `plan`, one by one (each is checked again just before it goes); how many went, and the servers of the ones that could not be removed. */
async function removeSkills(plan: AgentMigrationPlan, report: ReconcileReport): Promise<{ removed: number; failed: string[] }> {
  let removed = 0;
  const failed: string[] = [];
  for (const dir of plan.remove) {
    try {
      removed += (await removeGeneratedSkillDirs([{ ...plan, remove: [dir] }])).length;
    } catch (err) {
      failed.push(serverOf(dir));
      report.notices.push(`could not remove ${dir} (${messageOf(err)})`);
    }
  }
  return { removed, failed };
}

async function readSettingsText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

/** What `ensureHook` found: the hook was added, was there already, was turned down or has no Claude Code to go into (nothing is pending any more), or could not be added (`tried` is what the settings file looked like). */
type HookResult = { outcome: 'installed' | 'present' | 'declined' | 'unneeded' } | { outcome: 'failed'; tried: string };

const HOOK_FIX = 'Fix the file, then run: mcpkit hook install --write';

/**
 * Add the SessionStart hook to the Claude Code settings: through the same code as `mcpkit hook install
 * --write` (the original is backed up first, every other key and hook stays, a missing file is
 * created), unless the user turned it down or it is there. A file that is not valid JSON, has the
 * wrong shape, or holds a number the rewrite would change (an integer beyond 2^53) is never touched:
 * the reason goes into the report. The settings file is created only where Claude Code is (`~/.claude`
 * exists). Never throws.
 */
async function ensureHook(agent: AgentType, declined: boolean, now: Date, report: ReconcileReport, retried: boolean): Promise<HookResult> {
  if (declined) return { outcome: 'declined' };
  const path = join(homedir(), SETTINGS_RELATIVE);
  if (!(await exists(dirname(path)))) return { outcome: 'unneeded' };
  // Taken before the file is read: a change made while this runs is a change the next run sees.
  const tried = await hookSettingsSignature();
  try {
    let text = await readSettingsText(path);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (hasInstalledHook(text)) return { outcome: 'present' };
      const edit = installHook(text, DEFAULT_MATCHER);
      if (!edit.changed) return { outcome: 'present' };
      if (text !== undefined) await backupFile(path, now);
      // Claude Code writes this file too: what is about to be replaced must still be what was read.
      const current = await readSettingsText(path);
      if (current !== text) {
        text = current;
        continue;
      }
      await writeSettings(path, edit.text);
      report.actions.push({ type: 'hook-added', agent, path, ...(retried ? { retried: true } : {}) });
      return { outcome: 'installed' };
    }
    addNotice(report, `could not add the hook: ${path} kept changing while it was being edited. ${HOOK_FIX}`);
  } catch (err) {
    // A number the rewrite would change is not fixed by editing the file and running the command again: the message says to add the entry by hand.
    const hint = err instanceof UnsafeRewrite ? '' : ` ${HOOK_FIX}`;
    addNotice(report, `could not add the hook: ${messageOf(err)}${err instanceof SettingsRefusal ? ` (${path} was left as it is)` : ''}.${hint}`);
  }
  return { outcome: 'failed', tried };
}

/** Write down what `ensureHook` found: a hook that is settled is no longer pending; one that failed stays pending, with the file it failed on. Returns whether the state was written. */
async function settleHook(agent: AgentType, result: HookResult): Promise<boolean> {
  return updateState((current) => {
    const record = Object.hasOwn(current.adopted, agent) ? current.adopted[agent] : undefined;
    if (record === undefined) return;
    if (result.outcome === 'failed') {
      record.hookPending = true;
      record.hookTried = result.tried;
    } else {
      delete record.hookPending;
      delete record.hookTried;
    }
  }, STATE_LOCK);
}

/**
 * The hook of an agent that was adopted without it (the file was invalid, or the run stopped before the
 * hook step), tried again when its settings file is not the one the last failed attempt saw. Full runs only.
 */
async function retryPendingHook(now: Date, report: ReconcileReport): Promise<void> {
  const { state, usable } = loadState();
  if (!usable || !(await hookRetryDue(state))) return;
  await settleHook('claude-code', await ensureHook('claude-code', state.hookDeclined, now, report, true));
}

/**
 * The adoption of the agents that are on the built-in default and have not been moved yet: back up
 * and remove the per-server skills mcpkit generated (those whose servers the guide lists with their
 * tools; a skill for a server whose tool list is in no schema cache stays, and is remembered in
 * `deferred`; a skill for a server the guide does not list is somebody's leftover and stays), record
 * it, and give Claude Code its hook. Returns whether every step worked.
 */
async function adopt(candidates: AgentType[], l: Loaded, state: McpkitState, now: Date, pkgVersion: string, report: ReconcileReport): Promise<boolean> {
  let ok = true;
  interface Move { agent: AgentType; plan: AgentMigrationPlan; removable: AgentMigrationPlan; deferred: string[]; shared: string[] }
  const moves: Move[] = [];

  for (const agent of candidates) {
    const plan = l.plans.get(agent);
    if (plan === undefined) { ok = false; continue; }
    const removable = { ...plan, remove: [] as string[] };
    const deferred: string[] = [];
    const sharedKeeps = plan.keep.filter((kept) => kept.sharedWith !== undefined).map((kept) => serverOf(kept.dir));
    const shared: string[] = [];
    if (plan.remove.length > 0 || sharedKeeps.length > 0) {
      const servers = indexedServers(l, agent);
      for (const dir of plan.remove) {
        const name = serverOf(dir);
        if (servers.indexed.has(name)) removable.remove.push(dir);
        else if (servers.listed.has(name)) deferred.push(name);
      }
      // Kept because another agent reads the same file: on the record's list only (the report's says "not indexed yet"), so a later run removes it once nobody does.
      shared.push(...sharedKeeps.filter((name) => servers.listed.has(name)));
    }
    moves.push({ agent, plan, removable, deferred, shared });
  }

  const backups = await backUp(moves.map((move) => move.removable).filter((plan) => plan.remove.length > 0), now, report);

  for (const { agent, removable, deferred, shared } of moves) {
    let removed = 0;
    // A skill that was backed up but could not be removed is kept like one whose server is not indexed: it has a cache, so the next run's deferred step removes it.
    let stuck: string[] = [];
    if (removable.remove.length > 0) {
      if (!backups.has(agent)) { ok = false; continue; }
      const result = await removeSkills(removable, report);
      removed = result.removed;
      stuck = result.failed;
      if (stuck.length > 0) ok = false;
    }
    const backup = backups.get(agent) ?? null;
    // The hook is written down as pending in the same write as the adoption: a run that stops before the hook step (a crash, a kill) cannot lose it.
    const saved = await updateState((current) => {
      current.adopted[agent] = { at: now.toISOString(), by: pkgVersion, removed, backup, deferred: [...deferred, ...stuck, ...shared], ...(agent === 'claude-code' && !current.hookDeclined ? { hookPending: true } : {}) };
    }, STATE_LOCK);
    if (!saved) ok = false;
    report.actions.push({ type: 'adopted', agent, removed, backup, deferred });
    if (agent === 'claude-code') await settleHook(agent, await ensureHook(agent, state.hookDeclined, now, report, false));
  }
  return ok;
}

/**
 * The skills kept at adoption (`deferred`) whose servers are in a schema cache by now: back them up
 * and remove them, and forget the names. A name whose skill is gone, or is no longer one mcpkit
 * generated, is forgotten without touching anything; one whose skill another agent on per-server
 * skills reads (the same file) stays on the list, untouched, until nobody does. Only the names in
 * the record are ever looked at, so a skill the user brings back for a server that was already moved stays.
 */
async function removeDeferred(l: Loaded, state: McpkitState, env: NodeJS.ProcessEnv, now: Date, noGuide: ReadonlySet<AgentType>, report: ReconcileReport): Promise<boolean> {
  let ok = true;
  interface Cleanup { agent: AgentType; removable: AgentMigrationPlan; settled: string[] }
  const cleanups: Cleanup[] = [];

  for (const agent of l.agents) {
    // The guide comes first: an agent whose guide could not be written keeps every skill it has.
    if (noGuide.has(agent)) continue;
    const record = Object.hasOwn(state.adopted, agent) ? state.adopted[agent] : undefined;
    const names = record === undefined ? [] : deferredOf(record);
    const plan = l.plans.get(agent);
    if (names.length === 0 || plan === undefined) continue;
    const { mode, source } = resolveSkillModeSource(l.settings, agent, env);
    if (mode !== 'guide' || source !== 'builtin') continue;

    const servers = indexedServers(l, agent);
    const generated = new Map(plan.remove.map((dir) => [serverOf(dir), dir]));
    // Kept only because another agent on per-server skills reads the same file: not gone, so not forgotten.
    const shared = new Set(plan.keep.filter((kept) => kept.sharedWith !== undefined).map((kept) => serverOf(kept.dir)));
    const removable = { ...plan, remove: [] as string[] };
    const settled: string[] = [];
    for (const name of names) {
      const dir = generated.get(name);
      if (dir === undefined) {
        // A shared skill stays on the list, to go in a later run once nobody shares it and its server is indexed.
        if (!shared.has(name)) settled.push(name);
      } else if (servers.indexed.has(name)) {
        removable.remove.push(dir);
        settled.push(name);
      }
    }
    if (settled.length > 0) cleanups.push({ agent, removable, settled });
  }

  const backups = await backUp(cleanups.map((cleanup) => cleanup.removable).filter((plan) => plan.remove.length > 0), now, report);

  for (const { agent, removable, settled } of cleanups) {
    let removed = 0;
    let forget = settled;
    if (removable.remove.length > 0) {
      if (!backups.has(agent)) {
        // Nothing was backed up, so nothing goes: the names that were to go stay on the list for the next run.
        const staying = new Set(removable.remove.map(serverOf));
        forget = settled.filter((name) => !staying.has(name));
        ok = false;
      } else {
        const result = await removeSkills(removable, report);
        removed = result.removed;
        // A skill that could not be removed stays on the list too.
        forget = settled.filter((name) => !result.failed.includes(name));
        if (result.failed.length > 0) ok = false;
      }
    }
    const saved = await updateState((current) => {
      const record = Object.hasOwn(current.adopted, agent) ? current.adopted[agent] : undefined;
      if (record === undefined) return;
      record.deferred = deferredOf(record).filter((name) => !forget.includes(name));
    }, STATE_LOCK);
    if (!saved) ok = false;
    if (removed > 0) report.actions.push({ type: 'deferred-removed', agent, removed, backup: backups.get(agent) ?? null });
  }
  return ok;
}

/**
 * The guide of every agent in guide mode: written when it is not current. Returns the agents whose
 * guide could not be written, with a notice for each: such an agent must be left as it is (see
 * `reconcileLocked`). The directory in every guide comes from the one snapshot of the registry and the caches.
 */
async function ensureGuides(l: Loaded, modes: Map<AgentType, { mode: string }>, pkgVersion: string, report: ReconcileReport): Promise<Set<AgentType>> {
  const failed = new Set<AgentType>();
  const directory = snapshotSource(l.snapshot);
  for (const agent of l.agents) {
    if (modes.get(agent)?.mode !== 'guide') continue;
    try {
      if (await guideIsCurrent(agent, { settings: l.settings, pkgVersion, directory })) continue;
      await writeMetaSkill({ agents: [agent], scope: 'global', quiet: true, settings: l.settings, pkgVersion, directory });
      report.actions.push({ type: 'guide-written', agent });
    } catch (err) {
      failed.add(agent);
      addNotice(report, `${agent}: could not write the mcpkit-cli guide (${withoutTempNames(messageOf(err))}); left the per-server skills in place.`);
    }
  }
  return failed;
}

/** The body of a run, inside the lock. */
async function reconcileLocked(kind: ReconcileKind, env: NodeJS.ProcessEnv, now: Date, pkgVersion: string, report: ReconcileReport): Promise<void> {
  // Taken before anything is read: a file that changes during the pass is not covered by it, and shows in the next run.
  const fingerprint = await computeFingerprint(pkgVersion);
  const { state, usable } = loadState();
  if (usable && await lastPassStillHolds(state, fingerprint, kind)) {
    // Nothing changed, but a hook that could not be added may be addable now (its settings file is another file).
    if (kind === 'full' && await hookRetryDue(state)) await retryPendingHook(now, report);
    else report.fast = true;
    return;
  }

  const result = await gather(env);
  if ('skipped' in result) {
    report.skipped = result.skipped;
    return;
  }
  const g = result.gathered;
  if (g.agents.length === 0) {
    report.skipped = 'there is no agent to reconcile';
    return;
  }
  // The registry and every cache, read once for every agent and every step below.
  const l: Loaded = { ...g, snapshot: await loadDirectorySnapshot(g.entries, g.agentSettings) };

  const modes = new Map(l.agents.map((agent) => [agent, resolveSkillModeSource(l.settings, agent, env)]));

  // 1. Freshness: the guide first, so that an agent is never left with neither the guide nor its skills.
  // An agent whose guide cannot be written is dropped from everything after it: nothing of it is backed
  // up, removed or hooked, and nothing is recorded, so the next run starts from the same place.
  const noGuide = await ensureGuides(l, modes, pkgVersion, report);
  let ok = noGuide.size === 0;

  if (kind === 'full' && usable) {
    // 2. Adoption, once per agent, only where nobody chose a mode.
    const candidates = l.agents.filter((agent) => {
      const mode = modes.get(agent);
      return mode?.mode === 'guide' && mode.source === 'builtin' && !Object.hasOwn(state.adopted, agent) && !noGuide.has(agent);
    });
    if (candidates.length > 0 && !(await adopt(candidates, l, state, now, pkgVersion, report))) ok = false;

    // 3. The skills kept for servers that were not indexed.
    if (!(await removeDeferred(l, state, env, now, noGuide, report))) ok = false;

    // 4. A hook that could not be added at adoption, when its settings file is another file now.
    if (!noGuide.has('claude-code')) await retryPendingHook(now, report);
  }

  // 5. Remember the pass only when all of it worked: a failure is tried again on the next run.
  if (usable && ok) {
    const guideFiles = await guideFilesOf(l, env);
    if (guideFiles !== undefined) {
      await updateState((current) => {
        if (kind === 'full') {
          current.fingerprint = fingerprint;
          current.guideFiles = guideFiles;
        } else {
          current.refreshFingerprint = fingerprint;
          current.refreshGuideFiles = guideFiles;
        }
      }, STATE_LOCK);
    }
  }
}

async function run(kind: ReconcileKind, opts: ReconcileOptions, report: ReconcileReport): Promise<void> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const pkgVersion = opts.pkgVersion ?? defaultPkgVersion();

  // Opt-outs: the run is explicit about its mode (a valid MCPKIT_SKILLS: a value `mcpkit config` ignores is no choice), or the user said so.
  if (readEnvMode(env).mode !== undefined) { report.skipped = 'MCPKIT_SKILLS is set'; return; }
  if (/^(1|true)$/i.test((env.MCPKIT_NO_MIGRATE ?? '').trim())) { report.skipped = 'MCPKIT_NO_MIGRATE is set'; return; }

  // Nothing is created for a machine that has never used mcpkit.
  const dir = join(homedir(), '.mcpkit');
  try {
    if (!(await stat(dir)).isDirectory()) { report.skipped = `${dir} is not a directory`; return; }
  } catch (err) {
    report.skipped = isEnoent(err) ? 'mcpkit has not been used on this machine' : `${dir} cannot be read: ${messageOf(err)}`;
    return;
  }

  // Before the lock, and read-only: the common cases (nothing changed, nothing to do) take no lock and write nothing.
  const fingerprint = await computeFingerprint(pkgVersion);
  const early = loadState();
  if (early.usable && await lastPassStillHolds(early.state, fingerprint, kind)) {
    if (!(kind === 'full' && await hookRetryDue(early.state))) {
      report.fast = true;
      return;
    }
  } else {
    const preview = await gather(env);
    if ('skipped' in preview) { report.skipped = preview.skipped; return; }
    if (preview.gathered.agents.length === 0) { report.skipped = 'there is no agent to reconcile'; return; }
  }

  let locked;
  try {
    locked = await tryWithFileLock(join(dir, 'reconcile.lock'), () => reconcileLocked(kind, env, now, pkgVersion, report), { staleMs: LOCK_STALE_MS });
  } catch (err) {
    report.skipped = `the lock cannot be taken: ${messageOf(err)}`;
    return;
  }
  if (!locked.acquired) report.skipped = 'busy';
}

/**
 * What a set of failure notices is called in the state file: the same failure gives the same key. A
 * backup folder is named after the time (`20261120153000`, `-1` when there are several in one second),
 * and a failure inside it (a full disk, a folder that cannot be written to) puts that name in the
 * message, and so does the temp file of an atomic write (`<file>.<pid>.<8 hex>.tmp`): those names are left out
 * of the key, as they are the one part of the text that changes on every run.
 */
function noticeKey(notices: readonly string[]): string {
  const text = [...notices].map((notice) => notice.replace(/\d{14}(?:-\d{1,3})?/g, '<time>')).map(withoutTempNames).sort().join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * A failure notice that keeps happening (a backup that cannot be made fails again on every command)
 * is printed once a day, not on every command: the key of the last one printed and when it was
 * is in `state.json`; the same key within 24 hours is left out of the output (`noticesSuppressed`).
 * A new or different failure prints at once. When the state cannot be read or written it prints.
 */
async function muteRepeatedNotices(report: ReconcileReport, now: Date): Promise<void> {
  if (report.notices.length === 0) return;
  const key = noticeKey(report.notices);
  const { state, usable } = loadState();
  if (!usable) return;
  const last = state.lastNotice;
  const age = last === undefined ? Number.NaN : now.getTime() - Date.parse(last.at);
  if (last !== undefined && last.key === key && age >= 0 && age < NOTICE_REPEAT_MS) {
    report.noticesSuppressed = true;
    return;
  }
  await updateState((current) => {
    current.lastNotice = { key, at: now.toISOString() };
  }, STATE_LOCK);
}

/** Never throws, never prints. */
export async function reconcile(kind: ReconcileKind, opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const started = performance.now();
  const report: ReconcileReport = { notices: [], actions: [], ms: 0 };
  const restore = muteConsole();
  try {
    await run(kind, opts, report);
    await muteRepeatedNotices(report, opts.now ?? new Date());
  } catch (err) {
    report.failed = messageOf(err);
  } finally {
    restore();
    report.ms = performance.now() - started;
  }
  return report;
}

/** The lines the user gets on stderr for what `report` says was done; empty when there is nothing to say. */
export function formatNotices(report: ReconcileReport): string[] {
  const lines: string[] = [];
  const adopted = report.actions.filter((action): action is Extract<ReconcileAction, { type: 'adopted' }> => action.type === 'adopted');
  const hooks = report.actions.filter((action): action is Extract<ReconcileAction, { type: 'hook-added' }> => action.type === 'hook-added' && action.retried !== true);
  const lateHooks = report.actions.filter((action): action is Extract<ReconcileAction, { type: 'hook-added' }> => action.type === 'hook-added' && action.retried === true);
  const deferred = report.actions.filter((action): action is Extract<ReconcileAction, { type: 'deferred-removed' }> => action.type === 'deferred-removed');

  const adoption: string[] = [];
  for (const action of adopted) {
    if (action.removed > 0 && action.backup !== null) {
      adoption.push(`  ${action.agent}: moved ${action.removed} per-server skill${action.removed === 1 ? '' : 's'} to ${action.backup} (copy a folder back to restore one).`);
    }
  }
  for (const action of hooks) adoption.push(`  ${action.agent}: added the SessionStart hook (undo: mcpkit hook uninstall --write).`);
  const kept = adopted.reduce((count, action) => count + action.deferred.length, 0);
  if (kept > 0) {
    adoption.push(`  ${kept} skill${kept === 1 ? '' : 's'} kept for servers whose tools are not indexed yet; they are removed automatically after you run: mcpkit update`);
  }
  for (const notice of report.noticesSuppressed === true ? [] : report.notices) adoption.push(`  ${notice}`);
  if (adoption.length > 0) {
    lines.push('mcpkit: skills are now lean by default: one mcpkit-cli guide with a live server list instead of one skill per server.');
    lines.push(...adoption);
    lines.push('  Prefer one skill per server? mcpkit config lean off   (or set MCPKIT_SKILLS=per-server)');
  }

  // A hook added by a later run (the settings file was fixed): the adoption was said long ago, so only this is said.
  for (const action of lateHooks) lines.push(`mcpkit: added the SessionStart hook for ${action.agent} (undo: mcpkit hook uninstall --write).`);

  if (deferred.length > 0) {
    // One line for the whole run: it makes one backup, whatever the number of agents.
    const total = deferred.reduce((count, action) => count + action.removed, 0);
    const backups = [...new Set(deferred.flatMap((action) => (action.backup === null ? [] : [action.backup])))];
    lines.push(`mcpkit: removed ${total} per-server skill${total === 1 ? '' : 's'} for servers that are now indexed${backups.length === 0 ? '' : ` (backup: ${backups.join(', ')})`}.`);
  }
  return lines;
}

/**
 * Write `text` to stderr without ever failing the command: a closed or broken stderr reports its error
 * as an event, which, unhandled, would end the process. The way Node's own `console` does it, and
 * with the same result: no `error` listener is left on the stream. One that is there while the write
 * is made catches an error raised at once; the write's callback, which always runs before an
 * asynchronous error is emitted, adds one that lets that error go by and removes itself with it.
 */
function writeToStderr(text: string): void {
  const stream = process.stderr;
  const ignore = (): void => {};
  try {
    if (stream.listenerCount('error') === 0) stream.once('error', ignore);
    stream.write(text, (err?: Error | null) => {
      if (err === undefined || err === null) return;
      stream.once('error', ignore);
      // The error is emitted in the next tick; an error that was emitted already leaves nothing to remove it.
      setImmediate(() => stream.removeListener('error', ignore));
    });
  } catch {
    // Nobody is listening.
  } finally {
    stream.removeListener('error', ignore);
  }
}

/** Print the notices of `report` to stderr. A closed or broken stderr is no failure. */
export function printNotices(report: ReconcileReport): void {
  const lines = formatNotices(report);
  if (lines.length === 0) return;
  writeToStderr(`${lines.join('\n')}\n`);
}

/** The path of the command a commander action belongs to, without the program: `runtime status` is `['runtime', 'status']`. */
export function commandPath(command: Command): string[] {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names;
}

/**
 * The commander `preAction` hook: reconcile in front of the command that is about to run, as its class
 * says (see `classifyCommand`). A dry run changes nothing, so it triggers nothing either. Never throws.
 */
export async function reconcileBeforeAction(actionCommand: Command): Promise<void> {
  try {
    const kind = classifyCommand(commandPath(actionCommand));
    if (kind === 'skip' || actionCommand.opts().dryRun === true) return;
    printNotices(await reconcile(kind));
  } catch {
    // A command is never held up by this.
  }
}

/** The step at the end of a command that changed what the reconcile reads (install, sync, update, remove). Never throws. */
export async function reconcileAfterChange(): Promise<void> {
  try {
    printNotices(await reconcile('full'));
  } catch {
    // A command is never held up by this.
  }
}
