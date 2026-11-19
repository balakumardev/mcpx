import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { loadRegistry } from '../config.js';
import { connectToolSession, type ConnectedToolSession } from '../client.js';
import { resolveAuthProvider } from '../discover.js';
import { loadSchemaCache, type SchemaCache } from '../schema-store.js';
import type { ServerEntry, ToolAnnotations } from '../types.js';
import { blockedMessage, gateVerdict, isDeclaredReadOnly, type GatePolicy } from './gate.js';
import { MAX_CALL_RESULT_BYTES, MAX_CONCURRENT_CALLS } from './limits.js';
import type { ErrorKind } from './protocol.js';
import { debugLog, redactMessage } from './redact.js';

/** What a call failure carries back to the script. */
export class BrokerError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly tool?: string) {
    super(message);
    this.name = 'BrokerError';
  }
}

/** A tool as the connected server lists it: all the gate needs is its name and its annotations. */
export interface LiveTool {
  name: string;
  annotations?: ToolAnnotations;
}

export interface BrokerSession extends Pick<ConnectedToolSession, 'callTool' | 'close'> {
  /** The tools the connected server lists now. */
  listTools(): Promise<LiveTool[]>;
  /** `handler` runs once when the connection closes (the server exited, the transport dropped). */
  onClose(handler: () => void): void;
}

/** Everything the broker needs from the outside, so tests can run it without a registry or a server. */
export interface BrokerDeps {
  loadServers(): Promise<Record<string, ServerEntry>>;
  /** The schema cache file only; never connects to the server. Used for "did you mean" lists, never for the gate. */
  loadCache(server: string): Promise<SchemaCache | null>;
  openSession(entry: ServerEntry, timeoutMs: number): Promise<BrokerSession>;
}

/** Upper bound on `tools/list` pages followed for one server, like discovery. */
const MAX_TOOL_LIST_PAGES = 100;

/** Every tool the server lists, following the pagination cursor (a repeated cursor ends the walk). */
export async function listLiveTools(client: Pick<Client, 'listTools'>): Promise<LiveTool[]> {
  const tools: LiveTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const result = await client.listTools(cursor === undefined ? undefined : { cursor });
    for (const tool of result.tools) tools.push({ name: tool.name, annotations: tool.annotations });
    cursor = result.nextCursor;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  }
  return tools;
}

export function defaultBrokerDeps(): BrokerDeps {
  return {
    async loadServers() {
      return (await loadRegistry()).servers;
    },
    loadCache: loadSchemaCache,
    async openSession(entry, timeoutMs) {
      // Never an interactive OAuth flow: a missing sign-in is an error naming `mcpkit auth`.
      const authProvider = await resolveAuthProvider(entry, { interactive: false });
      const session = await connectToolSession(entry.transport, authProvider, entry.paramProvider, entry.envHints, { timeoutMs });
      return {
        callTool: (tool, args) => session.callTool(tool, args),
        close: () => session.close(),
        listTools: () => listLiveTools(session.client),
        onClose: (handler) => {
          const previous = session.client.onclose;
          session.client.onclose = () => {
            previous?.();
            handler();
          };
        },
      };
    },
  };
}

export interface BrokerOptions {
  policy: GatePolicy;
  maxCalls: number;
  /** When the run's wall clock ends (epoch ms): no call may outlive it. */
  deadline: number;
  deps: BrokerDeps;
  /** Called for every call the gate blocks, even if the script then catches the error. */
  onBlocked?: (server: string, tool: string) => void;
}

/** The SDK itself waits up to 2 s for a server to exit after its stdin closes, then 2 s more after SIGTERM. */
const SESSION_CLOSE_TIMEOUT_MS = 2500;

/** Levenshtein distance, for "did you mean" lists. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length];
}

/** The `limit` candidates closest to `name`; a name that contains (or is contained in) another counts as close. */
export function nearestNames(name: string, candidates: readonly string[], limit = 5): string[] {
  const needle = name.toLowerCase();
  return candidates
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const related = lower.includes(needle) || needle.includes(lower);
      return { candidate, score: related ? Math.abs(lower.length - needle.length) / 10 : editDistance(needle, lower) };
    })
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** Counts the calls that run at once and makes the others wait for a slot. */
class Semaphore {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(slots: number) {
    this.free = slots;
  }

  async acquire(): Promise<() => void> {
    if (this.free > 0) {
      this.free--;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}

/** One server's connection together with the tool list it reported when the gate first needed it. */
interface Listing {
  session: BrokerSession;
  tools: readonly LiveTool[];
}

/**
 * The parent's side of every `mcp.server.tool(args)` the script makes: looks the
 * server up, applies the write gate, opens one session per server lazily,
 * runs at most MAX_CONCURRENT_CALLS calls at a time and turns the result into
 * the JSON text the script receives.
 *
 * Per run there is at most one session and one tool list per server (both
 * cached as promises, so concurrent calls share them), and a session that
 * fails to open, or whose connection closes, is forgotten so the next call
 * starts a fresh one. A tool list is only fetched for `--allow-read-only`, from
 * the session the call will use: `readOnlyHint` is never taken from the schema
 * cache, which may belong to a server that has since been replaced.
 */
export class CallBroker {
  /** Calls the script made (blocked ones included). */
  calls = 0;
  private readonly blockedCalls = new Set<string>();
  private servers: Promise<Record<string, ServerEntry>> | undefined;
  private readonly sessions = new Map<string, Promise<BrokerSession>>();
  private readonly listings = new Map<string, Promise<Listing>>();
  /** Sessions whose connection closed. */
  private readonly lost = new WeakSet<BrokerSession>();
  private readonly slots = new Semaphore(MAX_CONCURRENT_CALLS);
  private closed = false;

  constructor(private readonly options: BrokerOptions) {}

  /** `server.tool` of every call the gate blocked, each once, even when the script caught the error. */
  get blocked(): string[] {
    return [...this.blockedCalls];
  }

  /** Run one call. Resolves with the JSON text of the normalised result, else throws BrokerError. */
  async call(server: string, tool: string, argsJson: string): Promise<string> {
    if (this.calls >= this.options.maxCalls) {
      throw new BrokerError('limit', `mcpkit: call limit reached (${this.options.maxCalls} calls); raise it with --max-calls`);
    }
    this.calls++;
    const name = `${server}.${tool}`;

    const entry = await this.lookupServer(server);
    let admitted: BrokerSession | undefined;
    try {
      admitted = await this.admit(entry, tool);
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError('tool', `mcpkit: could not look up the tools of ${server}: ${this.describe(entry, error)}`, name);
    }
    const args = this.parseArgs(name, argsJson);

    const release = await this.slots.acquire();
    try {
      return await this.dispatch(entry, tool, args, admitted);
    } finally {
      release();
    }
  }

  private async lookupServer(server: string): Promise<ServerEntry> {
    this.servers ??= this.options.deps.loadServers();
    let servers: Record<string, ServerEntry>;
    try {
      servers = await this.servers;
    } catch (error) {
      debugLog(`could not read the server registry: ${error instanceof Error ? error.message : String(error)}`);
      throw new BrokerError('internal', 'mcpkit: could not read the server registry (`mcpkit list` shows why)');
    }
    if (Object.hasOwn(servers, server)) return servers[server];

    const names = Object.keys(servers);
    throw new BrokerError(
      'tool',
      names.length === 0
        ? `mcpkit: unknown server "${server}". No servers are registered; add one with \`mcpkit install\`.`
        : `mcpkit: unknown server "${server}". Registered servers: ${names.join(', ')}.`,
    );
  }

  /**
   * The write gate. Throws when the call may not run; a denied call never reaches the server.
   * Resolves with the session whose tool list vouched for the call (`--allow-read-only`), if any.
   */
  private async admit(entry: ServerEntry, tool: string): Promise<BrokerSession | undefined> {
    const { policy, deps } = this.options;
    const server = entry.name;
    const verdict = gateVerdict(policy, server, tool);
    if (verdict === 'allow') return undefined;

    if (verdict === 'check-read-only') {
      const { session, tools } = await this.listing(entry);
      const declared = tools.find((candidate) => candidate.name === tool);
      if (declared === undefined) {
        throw this.unknownTool(server, tool, tools.map((candidate) => candidate.name), null);
      }
      if (isDeclaredReadOnly(declared.annotations)) return session;
    } else {
      // A typo should read as a typo, not as "blocked": the cache is enough to tell.
      const cache = await deps.loadCache(server);
      if (cache !== null && !cache.tools.some((candidate) => candidate.name === tool)) {
        throw this.unknownTool(server, tool, cache.tools.map((candidate) => candidate.name), cache);
      }
    }

    this.blockedCalls.add(`${server}.${tool}`);
    this.options.onBlocked?.(server, tool);
    throw new BrokerError('blocked', blockedMessage(server, tool), `${server}.${tool}`);
  }

  private unknownTool(server: string, tool: string, names: readonly string[], cache: SchemaCache | null): BrokerError {
    const near = nearestNames(tool, names);
    const hint = near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : '';
    const stale = cache === null ? '' : ` (tool list cached ${cache.fetchedAt}; \`mcpkit update ${server}\` refreshes it)`;
    return new BrokerError('tool', `mcpkit: unknown tool ${server}.${tool}.${hint}${stale}`, `${server}.${tool}`);
  }

  private parseArgs(name: string, argsJson: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch {
      throw new BrokerError('tool', `mcpkit: the arguments of ${name} are not valid JSON`, name);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BrokerError('tool', `mcpkit: the arguments of ${name} must be an object`, name);
    }
    return parsed as Record<string, unknown>;
  }

  private async dispatch(entry: ServerEntry, tool: string, args: Record<string, unknown>, admitted?: BrokerSession): Promise<string> {
    const name = `${entry.name}.${tool}`;
    let session = admitted;
    let output;
    try {
      session ??= await this.withinDeadline(name, this.session(entry));
      output = await this.withinDeadline(name, session.callTool(tool, args));
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      const closed = session !== undefined && (this.lost.has(session) || isConnectionClosed(error));
      throw await this.failure(
        entry,
        tool,
        closed
          ? `the connection to ${entry.name} closed during the call (the call was not retried: it may have taken effect)`
          : this.describe(entry, error),
      );
    }

    if (output.isError) {
      throw await this.failure(entry, tool, output.text !== '' ? output.text : 'the tool reported an error');
    }

    const json = JSON.stringify(output.value) ?? 'null';
    if (Buffer.byteLength(json, 'utf-8') > MAX_CALL_RESULT_BYTES) {
      throw new BrokerError(
        'limit',
        `mcpkit: the result of ${name} is larger than ${MAX_CALL_RESULT_BYTES} bytes; ask the tool for less`,
        name,
      );
    }
    return json;
  }

  /**
   * A session's MCP timeout is fixed when it opens, so each call is also held to
   * what is left of the run: a hung tool cannot outlive `--timeout`.
   */
  private async withinDeadline<T>(name: string, pending: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new BrokerError('timeout', `mcpkit: ${name} did not answer within the time limit of the run`, name)),
        this.remainingMs(),
      );
    });
    try {
      return await Promise.race([pending, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A failed call as an error. When the cache says the tool does not exist, it names the nearest tools. */
  private async failure(entry: ServerEntry, tool: string, reason: string): Promise<BrokerError> {
    const name = `${entry.name}.${tool}`;
    const cache = await this.options.deps.loadCache(entry.name).catch(() => null);
    const near = cache !== null && !cache.tools.some((candidate) => candidate.name === tool)
      ? nearestNames(tool, cache.tools.map((candidate) => candidate.name))
      : [];
    const hint = near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : '';
    return new BrokerError('tool', `${name} failed: ${reason}${hint}`, name);
  }

  /**
   * The text of an error from the connection layer, fit for the script: credentials and the
   * registry's hints removed. The original goes to the parent's stderr when MCPKIT_DEBUG=1.
   */
  private describe(entry: ServerEntry, error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    debugLog(`${entry.name}: ${raw}`);
    return redactMessage(entry, raw);
  }

  private remainingMs(): number {
    return Math.max(1, this.options.deadline - Date.now());
  }

  /** The one session of this server, opened on first use. A session that failed to open is not kept. */
  private session(entry: ServerEntry): Promise<BrokerSession> {
    if (this.closed) return Promise.reject(new Error('the run is over'));
    const name = entry.name;
    let session = this.sessions.get(name);
    if (session === undefined) {
      const opening = this.options.deps.openSession(entry, this.remainingMs());
      session = opening;
      this.sessions.set(name, opening);
      opening.then(
        (opened) => opened.onClose(() => this.forget(name, opening, opened)),
        () => {
          if (this.sessions.get(name) === opening) this.sessions.delete(name);
        },
      );
    }
    return session;
  }

  /** The connection closed: the next call to this server opens a new session and lists its tools again. */
  private forget(name: string, opening: Promise<BrokerSession>, session: BrokerSession): void {
    this.lost.add(session);
    if (this.sessions.get(name) !== opening) return;
    this.sessions.delete(name);
    this.listings.delete(name);
    // The transport is already closed; this releases whatever is left of it.
    session.close().catch(() => undefined);
  }

  /** The tools this server's session reports, fetched once per session however many calls ask. */
  private listing(entry: ServerEntry): Promise<Listing> {
    const name = entry.name;
    let listing = this.listings.get(name);
    if (listing === undefined) {
      const fetching = (async (): Promise<Listing> => {
        const session = await this.withinDeadline(`${name} (tool list)`, this.session(entry));
        const tools = await this.withinDeadline(`${name} (tool list)`, session.listTools());
        return { session, tools };
      })();
      listing = fetching;
      this.listings.set(name, fetching);
      fetching.catch(() => {
        if (this.listings.get(name) === fetching) this.listings.delete(name);
      });
    }
    return listing;
  }

  /**
   * Close every session that was opened (or is still opening), waiting at most `timeoutMs` for
   * each. Never throws. Resolves false when a session did not close in time or failed to.
   */
  async close(timeoutMs: number = SESSION_CLOSE_TIMEOUT_MS): Promise<boolean> {
    this.closed = true;
    const closeOne = async (opening: Promise<BrokerSession>): Promise<boolean> => {
      let session: BrokerSession;
      try {
        session = await opening;
      } catch {
        return true;
      }
      try {
        await session.close();
        return true;
      } catch {
        // Closing is best effort: the child server dies with the transport anyway.
        return false;
      }
    };

    const results = await Promise.all([...this.sessions.values()].map((opening) => {
      let timer: NodeJS.Timeout | undefined;
      return Promise.race([
        closeOne(opening),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    }));
    return results.every(Boolean);
  }
}

function isConnectionClosed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === ErrorCode.ConnectionClosed;
}
