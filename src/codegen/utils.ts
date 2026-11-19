/*!
 * Adapted from cloudflare/agents (packages/codemode), https://github.com/cloudflare/agents
 *
 * MIT License
 *
 * Copyright (c) 2025 Cloudflare, Inc.
 *
 * Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice
 * (including the next paragraph) shall be included in all copies or substantial
 * portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
 * ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
 * OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/** A name that can be written as a bare property key or method name in TypeScript. */
export function isIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

/** Escape a character as a unicode escape sequence if it is a control character, C1 controls included (U+009B is a CSI to some terminals). */
function escapeControlChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
    return '\\u' + code.toString(16).padStart(4, '0');
  }
  return ch;
}

/** Escape a string for use inside a double-quoted TypeScript string literal. */
export function escapeStringLiteral(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\u2028') out += '\\u2028';
    else if (ch === '\u2029') out += '\\u2029';
    else out += escapeControlChar(ch);
  }
  return out;
}

/**
 * Quote a property name if needed (reserved words are valid property names, so
 * only non-identifiers are quoted). Escapes backslashes, quotes and control characters.
 */
export function quoteProp(name: string): string {
  return isIdentifier(name) ? name : `"${escapeStringLiteral(name)}"`;
}

/**
 * Escape a string for use inside a JSDoc comment: prevents premature comment
 * closure from star-slash sequences and drops every control character other
 * than tab and newline (CR, ESC, the C1 controls, DEL) and the Unicode line
 * and paragraph separators, so a description cannot send a terminal sequence.
 */
export function escapeJsDoc(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (char) => (char === '\t' || char === '\n' ? char : ''))
    .replace(/\*\//g, '*\\/');
}
