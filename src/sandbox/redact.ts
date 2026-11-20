import { resolveEnvVars } from '../client.js';
import { secretsInCommand } from '../redact-config.js';
import type { ServerEntry } from '../types.js';

/**
 * What a script may learn from a failure it did not cause itself. Connection and
 * transport errors are written by Node, the MCP SDK or a param provider and can
 * quote a URL with its token, a header, an environment value, the command line
 * of a helper or its output. None of that belongs to the script (it never sees
 * credentials), so such a message is cleaned before it leaves the parent, and
 * the original goes to the parent's stderr only when MCPKIT_DEBUG=1.
 */

const REDACTED = '<redacted>';
/** Shorter values are not worth hiding, and replacing them would mangle ordinary words. */
const MIN_SECRET_CHARS = 6;
/** Words that name how a credential is sent, not the credential: `Authorization: Bearer <token>` keeps its `Bearer`. */
const AUTH_SCHEMES = new Set(['bearer', 'basic', 'token', 'digest', 'apikey']);
/** A configured name (header, environment variable) that says its value is a credential. */
const SECRET_NAME = /key|token|secret|pass|auth|cookie|session|credential/i;
/** A short all-lowercase word: `production`, `staging`. Under a name that is not secret-looking it is a setting, not a credential. */
const PLAIN_WORD = /^[a-z]{1,15}$/;
/** Path segments of a server URL that are ordinary words, never a credential, whatever their length. */
const ORDINARY_PATH_WORDS = new Set([
  'mcp', 'sse', 'api', 'rpc', 'jsonrpc', 'v1', 'v2', 'v3', 'stream', 'messages', 'events',
]);

/** Print `message` on the parent's stderr when MCPKIT_DEBUG=1; otherwise stay silent. */
export function debugLog(message: string): void {
  if (process.env.MCPKIT_DEBUG === '1') process.stderr.write(`mcpkit [debug] ${message}\n`);
}

function safeResolve(value: string, hints: ServerEntry['envHints']): string | undefined {
  try {
    return resolveEnvVars(value, hints);
  } catch {
    return undefined;
  }
}

/** `text` percent-decoded; text that is not valid percent-encoding is returned as it is. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The pieces of one configured value worth hiding: the whole, and (for "Bearer x" or "--key=x") its parts, less any auth scheme word. */
function pieces(value: string): string[] {
  return [value, ...value.split(/[\s=]+/)].filter((piece) => !AUTH_SCHEMES.has(piece.toLowerCase()));
}

/** The names of the environment variables a configured value reads: `${NAME}`. */
function referencedVariables(value: string): string[] {
  return [...value.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
}

/**
 * The path of a server URL when it holds a credential (an API key in the path is common): every
 * segment long enough to matter that is not an ordinary word, as written and decoded, plus the
 * whole path so the error does not show what surrounds the key. A path of ordinary words only
 * (`/mcp`, `/api/v1/sse`) is not a credential and is left alone.
 */
function pathSecretsOf(url: URL): string[] {
  const segments = url.pathname
    .split('/')
    .flatMap((segment) => [segment, decoded(segment)])
    .filter((segment) => segment.length >= MIN_SECRET_CHARS && !ORDINARY_PATH_WORDS.has(segment.toLowerCase()));
  return segments.length === 0 ? [] : [...segments, url.pathname, decoded(url.pathname)];
}

/**
 * Strings that are credentials by where they sit, whatever their length: the `user:password@` part
 * of a URL, as written and as decoded, and a URL's whole query string.
 */
function positionalSecretsOf(entry: ServerEntry): { userinfo: string[]; other: string[] } {
  const userinfo: string[] = [];
  const other: string[] = [];
  const transport = entry.transport;
  if (transport.type === 'stdio') return { userinfo, other };
  try {
    const url = new URL(transport.url);
    if (url.search !== '') other.push(url.search);
    for (const [username, password] of [[url.username, url.password], [decoded(url.username), decoded(url.password)]]) {
      if (password !== '') userinfo.push(`${username}:${password}@`);
      else if (username !== '') userinfo.push(`${username}@`);
    }
  } catch {
    // An address that does not parse has no pieces to find.
  }
  return { userinfo, other };
}

/** Every value in the registry entry that may be a credential, as written and as the environment resolves it. */
export function secretValuesOf(entry: ServerEntry): string[] {
  const found: string[] = [];
  /** A value that is a credential by where it sits (URL user and password, query values, helper arguments), whatever it looks like. */
  const addPositional = (value: string | undefined): void => {
    if (value !== undefined) found.push(...pieces(value));
  };
  /**
   * A value configured under a name. A plain lowercase word under a name that does not look secret
   * (`X-Env: production`) is a setting and is not hidden, so errors that mention it stay readable.
   */
  const addNamed = (names: string[], value: string | undefined): void => {
    if (value === undefined) return;
    if (PLAIN_WORD.test(value) && !names.some((name) => SECRET_NAME.test(name))) return;
    found.push(...pieces(value));
  };
  const addConfigured = (name: string, value: string): void => {
    const names = [name, ...referencedVariables(value)];
    addNamed(names, value);
    addNamed(names, safeResolve(value, entry.envHints));
  };
  const transport = entry.transport;

  if (transport.type === 'stdio') {
    for (const [name, value] of Object.entries(transport.env ?? {})) addConfigured(name, value);
    // A credential written into the launch command (`--header "x-api-key: <KEY>"`, `--api-key=<KEY>`, a URL with a user and password).
    for (const secret of secretsInCommand(transport.command, transport.args)) addPositional(secret);
  } else {
    for (const [name, value] of Object.entries(transport.headers ?? {})) addConfigured(name, value);
    try {
      const url = new URL(transport.url);
      for (const value of [url.username, url.password, decoded(url.username), decoded(url.password), ...url.searchParams.values()]) {
        addPositional(value);
      }
      found.push(...pathSecretsOf(url));
    } catch {
      addPositional(transport.url);
    }
  }

  if (entry.paramProvider !== undefined) {
    addPositional(entry.paramProvider.command);
    for (const arg of entry.paramProvider.args ?? []) addPositional(arg);
  }
  return found.filter((value) => value.length >= MIN_SECRET_CHARS);
}

/** `message` with the entry's credentials, the connection URL's secrets and the registry's env hints removed. */
export function redactMessage(entry: ServerEntry, message: string): string {
  let cleaned = message;
  for (const hint of Object.values(entry.envHints ?? {})) {
    if (hint !== '') cleaned = cleaned.split(`\n\nHint: ${hint}`).join('').split(hint).join(REDACTED);
  }
  return scrubSecrets(entry, cleaned);
}

/**
 * `message` with the entry's credentials and the connection URL's secrets removed, the env hints
 * kept. For the owner's own commands (`call`, `sync`, `update`): a hint is the recipe an
 * "environment variable is not set" message is meant to carry, while a transport error that
 * quotes a header, a URL or a launch argument must not reach a terminal or a transcript.
 */
export function scrubSecrets(entry: ServerEntry, message: string): string {
  let cleaned = message;
  const positional = positionalSecretsOf(entry);
  for (const userinfo of [...new Set(positional.userinfo)].sort((a, b) => b.length - a.length)) {
    cleaned = cleaned.split(userinfo).join(`${REDACTED}@`);
  }
  const secrets = [...new Set([...positional.other, ...secretValuesOf(entry)])].sort((a, b) => b.length - a.length);
  for (const secret of secrets) cleaned = cleaned.split(secret).join(REDACTED);
  return cleaned;
}
