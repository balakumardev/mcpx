import type { ParamProviderConfig, ServerEntry, TransportConfig } from './types.js';

/**
 * Masks the secret-bearing parts of a registry entry for DISPLAY: `list`, `view`, and any text that
 * quotes a configured command. Nothing stored or sent to a server goes through here.
 *
 * A server is often registered with its credential inside the launch arguments (for example
 * `mcp-remote <url> --header "x-api-key: <KEY>"`), so a secret can sit in an environment value, a
 * header, an argument, a URL (user and password, a query value, a key in the path) or the command
 * itself. Every mask is `<redacted len=N>`: the length only, never a character of the value.
 * Masking is idempotent: a masked value passes through unchanged.
 */

const MASK = /^<redacted len=\d+>$/;
/** What a masked value looks like inside a larger text; an already masked value is never masked again. */
const MASK_SOURCE = '<redacted len=\\d+>';

/** A name (header, environment variable, flag, query parameter, JSON key) that says its value is a credential. */
const SECRET_NAME = /authorization|api[-_]?key|token|secret|pass(?:word|wd|phrase)|credential|cookie|x-.*key|(?:^|[^a-z])(?:key|auth|pass|session|sig|signature|bearer)(?:[^a-z]|$)|key$/i;
/** Settings that are never credentials, whatever their value. */
const NON_SECRET_NAME = /^(?:NODE_ENV|LOG_LEVEL|DEBUG|PORT|HOST|HOME|PATH|LANG|TZ)$/i;
/** A short number under one of these names is a PIN or a password, not a setting. */
const PASSWORD_NAME = /pass|secret|pin$|code$/i;
/** Words that name how a credential is sent; they stay readable and the credential after them is hidden. */
const AUTH_SCHEMES = new Set(['bearer', 'basic']);
const HEADER_FLAGS = new Set(['--header', '--headers', '-H']);
const HTTP_SCHEME = /(?:^|\+)(?:https?|wss?|ftps?)$/i;

/** `<redacted len=N>`: how many characters were hidden, and nothing else. */
export function maskValue(value: string): string {
  return MASK.test(value) ? value : `<redacted len=${value.length}>`;
}

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name.replace(/^-+/, ''));
}

/** True when a value is a setting by its shape or its name: `true`, a short number, `PORT`, `NODE_ENV`. */
function isClearlyNonSecret(name: string, value: string): boolean {
  if (NON_SECRET_NAME.test(name)) return true;
  const trimmed = value.trim();
  if (/^(?:true|false)$/i.test(trimmed)) return true;
  return trimmed.length <= 6 && /^-?\d+(?:\.\d+)?$/.test(trimmed) && !PASSWORD_NAME.test(name);
}

/** `${VAR}` references (with an optional scheme word) are pointers to an environment variable, not a credential. */
function isReferenceOnly(value: string): boolean {
  if (!/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) return false;
  return value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '').replace(/\b(?:Bearer|Basic|Token)\b/gi, '').trim() === '';
}

/** What an environment value or a header value shows. Hidden unless it is clearly a setting. */
export function maskConfiguredValue(name: string, value: string): string {
  if (value === '' || MASK.test(value) || isReferenceOnly(value) || isClearlyNonSecret(name, value)) return value;
  return maskValue(value);
}

/** The environment of a stdio server or the headers of an http/sse server, every value masked. */
export function maskRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([name, value]) => [name, maskRecordValue(name, value)])) as Record<string, string>;
}

/** A hand-edited registry can hold a number or a boolean where a string belongs: it is masked the same way. */
function maskRecordValue(name: string, value: unknown): unknown {
  if (typeof value === 'string') return maskConfiguredValue(name, value);
  if (typeof value === 'object' && value !== null) return maskUnknown(value, name);
  if (value === null || value === undefined) return value;
  return isClearlyNonSecret(name, String(value)) ? value : maskValue(String(value));
}

/** Surrounding quotes stay in the output: the arguments of a command typed in a shell keep them when it is split on whitespace. */
function splitQuotes(token: string): { lead: string; core: string; trail: string } {
  const lead = /^["'`]+/.exec(token)?.[0] ?? '';
  const rest = token.slice(lead.length);
  const trail = /["'`]+[}\]),;]*$/.exec(rest)?.[0] ?? '';
  return { lead, core: rest.slice(0, rest.length - trail.length), trail };
}

/** True for a token that is another option, so it cannot be the value of the one before it. */
function isFlagLike(token: string): boolean {
  return /^--?[A-Za-z]/.test(token);
}

/** Long, mixed-class strings that are neither a path, a URL, a file name nor a package spec. */
function looksLikeCredential(core: string): boolean {
  if (core.length < 24 || !/^[A-Za-z0-9_\-.=+/]+$/.test(core)) return false;
  if (/^(?:\.{1,2}\/|\/|~)/.test(core)) return false;
  if (/\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(core)) return false;
  // `package==1.2.3`; a base64 credential only has `=` as padding at its end.
  if (/==[\w.*]/.test(core)) return false;
  const lower = /[a-z]/.test(core);
  const upper = /[A-Z]/.test(core);
  const digit = /\d/.test(core);
  const symbol = /[_\-.=+/]/.test(core);
  if ([lower, upper, digit, symbol].filter(Boolean).length < 3) return false;
  // A relative path has slashes and no random-looking mix of upper case, lower case and digits.
  return !core.includes('/') || (lower && upper && digit);
}

/** A path segment of a server URL that is a key: long, no dots, and either a mix of upper case and digits or 32 or more hex digits. */
function looksLikePathSecret(segment: string): boolean {
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true;
  return segment.length >= 24 && /^[A-Za-z0-9_\-+=]+$/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment);
}

/** `name=value&name=value`: the values of secret-looking names hidden. */
function maskParameters(parameters: string, found: string[]): string {
  return parameters.replace(/([^=&;\s]+)=([^&;\s]*)/g, (whole, name: string, value: string) => {
    if (!isSecretName(decodeName(name)) || value === '' || MASK.test(value) || isClearlyNonSecret(name, value) || isReferenceOnly(value)) return whole;
    found.push(value);
    return `${name}=${maskValue(value)}`;
  });
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** Every URL in `text`: the user and password, a key in the path, the secret query and fragment parameters. */
function maskUrls(text: string, found: string[]): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s"'<>]*)/g, (whole, scheme: string, rest: string) => {
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    let tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);

    let host = authority;
    let userinfo = '';
    const at = authority.lastIndexOf('@');
    if (at !== -1) {
      userinfo = authority.slice(0, at);
      host = authority.slice(at + 1);
    }
    if (userinfo !== '' && !MASK.test(userinfo) && (userinfo.includes(':') || HTTP_SCHEME.test(scheme.slice(0, -3)))) {
      found.push(userinfo);
      userinfo = maskValue(userinfo);
    }

    const fragmentAt = tail.indexOf('#');
    const fragment = fragmentAt === -1 ? '' : tail.slice(fragmentAt + 1);
    if (fragmentAt !== -1) tail = tail.slice(0, fragmentAt);
    const queryAt = tail.indexOf('?');
    const query = queryAt === -1 ? '' : tail.slice(queryAt + 1);
    const path = queryAt === -1 ? tail : tail.slice(0, queryAt);

    const maskedPath = path.split('/').map((segment) => {
      if (!looksLikePathSecret(segment)) return segment;
      found.push(segment);
      return maskValue(segment);
    }).join('/');
    return `${scheme}${userinfo === '' ? '' : `${userinfo}@`}${host}${maskedPath}`
      + `${queryAt === -1 ? '' : `?${maskParameters(query, found)}`}`
      + `${fragmentAt === -1 ? '' : `#${maskParameters(fragment, found)}`}`;
  });
}

/** The URL of an http/sse server with its secrets masked. */
export function maskUrl(url: string): string {
  return maskUrls(url, []);
}

/** One token (or one value) on its own, with no neighbour to help: URLs, `Bearer x`, JSON pairs, a long credential. */
function maskStandalone(token: string, found: string[]): string {
  let text = token;
  if (text.includes('://')) text = maskUrls(text, found);
  text = text.replace(new RegExp(`\\b(Bearer|Basic)(\\s+)(${MASK_SOURCE}|\\S+)`, 'gi'), (whole, scheme: string, space: string, credential: string) => {
    if (MASK.test(credential)) return whole;
    const { lead, core, trail } = splitQuotes(credential);
    if (core === '' || isReferenceOnly(core)) return whole;
    found.push(core);
    return `${scheme}${space}${lead}${maskValue(core)}${trail}`;
  });
  text = text.replace(/(["'])([A-Za-z][\w.-]{0,63})\1(\s*:\s*)(["'])((?:(?!\4).)*)\4/g, (whole, quote: string, name: string, colon: string, valueQuote: string, value: string) => {
    if (!isSecretName(name) || value === '' || MASK.test(value) || isClearlyNonSecret(name, value) || isReferenceOnly(value)) return whole;
    found.push(value);
    return `${quote}${name}${quote}${colon}${valueQuote}${maskValue(value)}${valueQuote}`;
  });
  if (text === token && !text.includes('://') && !token.startsWith('-')) {
    const { lead, core, trail } = splitQuotes(token);
    if (looksLikeCredential(core)) {
      found.push(core);
      return `${lead}${maskValue(core)}${trail}`;
    }
  }
  return text;
}

interface Pending {
  kind: 'header' | 'value';
  name: string;
}

/**
 * The tokens of a command line with the secrets masked. A token is judged with the one before it:
 * the value after `--header`, `--api-key` or `Authorization:` and the credential after `Bearer` are
 * hidden even when a shell split them into separate tokens. Every hidden value is also pushed on
 * `found`, so a caller can scrub the same strings out of an error message.
 */
function maskTokens(tokens: string[], found: string[]): string[] {
  const hide = (token: string, name: string): string => {
    const { lead, core, trail } = splitQuotes(token);
    if (core === '' || MASK.test(core) || isReferenceOnly(core) || isClearlyNonSecret(name, core)) return token;
    found.push(core);
    return `${lead}${maskValue(core)}${trail}`;
  };
  /** `Name: value`, `Name:value` or a bare `Name:` as the value of a header option. */
  const hideHeader = (token: string): { out: string; pending?: Pending } => {
    const { lead, core } = splitQuotes(token);
    const header = /^([^:\s]+):(\s*)([\s\S]*)$/.exec(core);
    if (!header) return { out: hide(token, '') };
    const [, name, space, value] = header;
    if (value === '') return { out: token, pending: { kind: 'value', name } };
    return { out: `${lead}${name}:${space}${hide(token.slice(lead.length + name.length + 1 + space.length), name)}` };
  };

  const out: string[] = [];
  let pending: Pending | undefined;
  for (const token of tokens) {
    const { core } = splitQuotes(token);
    if (pending !== undefined) {
      const waiting = pending;
      pending = undefined;
      // Another option means the one before it had no value of its own.
      if (!isFlagLike(core)) {
        if (waiting.kind === 'header') {
          const header = hideHeader(token);
          out.push(header.out);
          pending = header.pending;
        } else if (AUTH_SCHEMES.has(core.toLowerCase())) {
          out.push(token);
          pending = waiting;
        } else {
          out.push(hide(token, waiting.name));
        }
        continue;
      }
    }

    if (HEADER_FLAGS.has(token)) {
      out.push(token);
      pending = { kind: 'header', name: token };
      continue;
    }
    const headerOption = /^(--headers?=|-H(?=[^=\s-][^=\s]*:))([\s\S]*)$/.exec(token);
    if (headerOption) {
      const header = hideHeader(headerOption[2]);
      out.push(`${headerOption[1]}${header.out}`);
      pending = header.pending;
      continue;
    }
    if (isFlagLike(token) && !token.includes('=') && isSecretName(token)) {
      out.push(token);
      pending = { kind: 'value', name: token.replace(/^-+/, '') };
      continue;
    }
    const assignment = /^(-{0,2})([A-Za-z_][\w.-]*)=([\s\S]*)$/.exec(token);
    if (assignment && !/^=*$/.test(assignment[3])) {
      const [, dashes, name, value] = assignment;
      out.push(`${dashes}${name}=${isSecretName(name) ? hide(value, name) : maskStandalone(value, found)}`);
      continue;
    }
    const bare = /^(["'`]*)([A-Za-z][\w-]*):(["'`]*)$/.exec(token);
    if (bare && isSecretName(bare[2])) {
      out.push(token);
      pending = { kind: 'value', name: bare[2] };
      continue;
    }
    const header = /^(["'`]*)([A-Za-z][\w-]*):(\s*)(?!\/\/)(\S[\s\S]*)$/.exec(token);
    if (header && isSecretName(header[2])) {
      const [, lead, name, space, value] = header;
      out.push(`${lead}${name}:${space}${hide(value, name)}`);
      continue;
    }
    if (AUTH_SCHEMES.has(core.toLowerCase())) {
      out.push(token);
      pending = { kind: 'value', name: core.toLowerCase() };
      continue;
    }
    out.push(maskStandalone(token, found));
  }
  return out;
}

/** The launch arguments of a stdio server with the secrets masked. */
export function maskArgs(args: string[]): string[] {
  return maskTokens(args, []);
}

/** The credentials found in a server's launch command and arguments, as written. */
export function secretsInCommand(command: string, args: string[]): string[] {
  const found: string[] = [];
  maskTokens(command.split(/\s+/).filter(Boolean), found);
  maskTokens(args, found);
  return found;
}

/** Free text that may quote a command or a credential (an environment hint, a param provider command), word by word. */
export function maskText(text: string): string {
  // A mask holds a space; it stays inside one word so that masking a masked text changes nothing.
  const pieces = text.match(new RegExp(`(?:${MASK_SOURCE}|\\S)+|\\s+`, 'g')) ?? [];
  const isWord = (piece: string): boolean => !/^\s/.test(piece);
  const words = maskTokens(pieces.filter(isWord), []);
  let next = 0;
  return pieces.map((piece) => (isWord(piece) ? words[next++] : piece)).join('');
}

/** The command line of a stdio server as one line, secrets masked. */
export function maskCommandLine(command: string, args: string[]): string {
  return [maskText(command), ...maskArgs(args)].join(' ').trim();
}

function maskParamProvider(provider: ParamProviderConfig): ParamProviderConfig {
  return {
    ...provider,
    command: maskText(provider.command),
    ...(provider.args === undefined ? {} : { args: maskArgs(provider.args) }),
  };
}

/** A field this module has no rule for: a string under a secret-looking key is hidden, wherever it is nested. */
function maskUnknown(value: unknown, key: string): unknown {
  if (typeof value === 'string') return isSecretName(key) ? maskConfiguredValue(key, value) : value;
  if (Array.isArray(value)) return value.map((item) => maskUnknown(item, key));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskUnknown(item, name)]));
  }
  return value;
}

function maskTransport(transport: TransportConfig): TransportConfig {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(transport)) {
    if (key === 'command' && typeof value === 'string') masked[key] = maskText(value);
    else if (key === 'args' && Array.isArray(value)) masked[key] = maskArgs(value.map(String));
    else if ((key === 'env' || key === 'headers') && typeof value === 'object' && value !== null) masked[key] = maskRecord(value as Record<string, string>);
    else if (key === 'url' && typeof value === 'string') masked[key] = maskUrl(value);
    else if (key === 'auth') masked[key] = value;
    else masked[key] = maskUnknown(value, key);
  }
  return masked as unknown as TransportConfig;
}

/**
 * A copy of the entry that is safe to print: environment values, header values, launch arguments,
 * URL secrets, param provider commands, environment hints and any nested secret-looking field are
 * masked. Fields the registry may gain later are kept, and the key order is unchanged.
 */
export function maskEntryForDisplay<T extends ServerEntry>(entry: T): T {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'transport' && typeof value === 'object' && value !== null) masked[key] = maskTransport(value as TransportConfig);
    else if (key === 'paramProvider' && typeof value === 'object' && value !== null) masked[key] = maskParamProvider(value as ParamProviderConfig);
    else if (key === 'envHints' && typeof value === 'object' && value !== null) {
      masked[key] = Object.fromEntries(Object.entries(value).map(([name, hint]) => [name, typeof hint === 'string' ? maskText(hint) : hint]));
    } else masked[key] = maskUnknown(value, key);
  }
  return masked as unknown as T;
}
