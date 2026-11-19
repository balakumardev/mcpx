/** A tool-call result reduced to the three things callers actually need. */
export interface NormalizedToolResult {
  /** The server flagged the call as failed (`isError: true`). */
  isError: boolean;
  /** Structured content, parsed JSON text, plain text, or `{ content }` for non-text parts. */
  value: unknown;
  /** Human-readable text: the text parts joined by newlines, else the structured content as JSON. */
  text: string;
}

interface TextPart {
  type: 'text';
  text: string;
}

function isTextPart(part: unknown): part is TextPart {
  return typeof part === 'object'
    && part !== null
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string';
}

/**
 * Normalise an MCP `tools/call` result.
 *
 * value: `structuredContent` when present; otherwise, if every content part is
 * text, the joined text parsed as JSON when it parses (else the string itself);
 * otherwise `{ content }` with the raw content parts.
 */
export function normalizeToolResult(raw: unknown): NormalizedToolResult {
  const result = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const isError = result.isError === true;
  const content: unknown[] = Array.isArray(result.content) ? result.content : [];
  const textParts = content.filter(isTextPart);
  const joined = textParts.map((part) => part.text).join('\n');
  const structured = result.structuredContent ?? undefined;

  const text = textParts.length > 0
    ? joined
    : structured !== undefined ? JSON.stringify(structured) : '';

  if (structured !== undefined) {
    return { isError, value: structured, text };
  }

  if (textParts.length === content.length) {
    try {
      return { isError, value: JSON.parse(joined), text };
    } catch {
      return { isError, value: joined, text };
    }
  }

  return { isError, value: { content }, text };
}

interface OmittedKind {
  /** What the parts have in common: a MIME type or a part type. */
  kind: string;
  count: number;
  bytes: number | undefined;
  /** The uri of a link or resource, shown only when the kind has a single part. */
  uri: string | undefined;
}

function sizeOfBase64(data: unknown): number | undefined {
  return typeof data === 'string' ? Buffer.byteLength(data, 'base64') : undefined;
}

/** The kind, size and uri of one non-text part. Sizes are the decoded bytes, never the base64 itself. */
function describePart(part: Record<string, unknown>): { kind: string; bytes?: number; uri?: string } {
  const type = typeof part.type === 'string' ? part.type : 'unknown';
  switch (type) {
    case 'image':
    case 'audio':
      return { kind: typeof part.mimeType === 'string' ? part.mimeType : type, bytes: sizeOfBase64(part.data) };
    case 'resource_link':
      return { kind: type, uri: typeof part.uri === 'string' ? part.uri : undefined };
    case 'resource': {
      const resource = (typeof part.resource === 'object' && part.resource !== null ? part.resource : {}) as Record<string, unknown>;
      return {
        kind: type,
        uri: typeof resource.uri === 'string' ? resource.uri : undefined,
        bytes: typeof resource.text === 'string' ? Buffer.byteLength(resource.text, 'utf-8') : sizeOfBase64(resource.blob),
      };
    }
    default:
      return { kind: type };
  }
}

/**
 * The non-text parts of a result's content list, which plain-text `call` output
 * never prints: one description per kind of part, such as `image/png 61969 bytes`,
 * `resource_link file:///a`, or `2 x image/png, 1500 bytes` for repeats. Empty
 * when every part is text. Server-provided words are not escaped here; the
 * caller escapes the line it prints.
 */
export function describeOmittedParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const kinds = new Map<string, OmittedKind>();
  for (const part of content) {
    if (typeof part !== 'object' || part === null || isTextPart(part)) continue;
    const { kind, bytes, uri } = describePart(part as Record<string, unknown>);
    const seen = kinds.get(kind);
    if (seen === undefined) {
      kinds.set(kind, { kind, count: 1, bytes, uri });
    } else {
      seen.count++;
      seen.bytes = seen.bytes === undefined && bytes === undefined ? undefined : (seen.bytes ?? 0) + (bytes ?? 0);
    }
  }

  return [...kinds.values()].map(({ kind, count, bytes, uri }) => {
    if (count > 1) return `${count} x ${kind}${bytes === undefined ? '' : `, ${bytes} bytes`}`;
    return [kind, uri, bytes === undefined ? undefined : `${bytes} bytes`].filter((word) => word !== undefined).join(' ');
  });
}
