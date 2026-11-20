import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake OAuth-protected MCP server for tests, on 127.0.0.1 and an OS-chosen port: the MCP endpoint
 * answers 401 with OAuth metadata until a request carries the accepted bearer token, then speaks just
 * enough JSON-RPC for a client to connect and list one tool. The OAuth endpoints are real enough for
 * the SDK client to discover, register and refresh; /authorize only records that something was sent
 * there, because no test may drive a browser.
 */

export interface FakeOAuthServer {
  /** The MCP endpoint. */
  url: string;
  origin: string;
  /** "METHOD /path" of every request, in arrival order. */
  requests: string[];
  close(): Promise<void>;
}

export interface FakeOAuthOptions {
  /** The bearer token the MCP endpoint accepts. */
  accessToken?: string;
  /** The refresh token the token endpoint exchanges for `accessToken`. */
  refreshToken?: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf-8');
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeOAuthServer(options: FakeOAuthOptions = {}): Promise<FakeOAuthServer> {
  const accessToken = options.accessToken ?? 'good-access';
  const refreshToken = options.refreshToken ?? 'good-refresh';
  const requests: string[] = [];
  let origin = '';

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(`${req.method} ${path}`);
    const body = req.method === 'POST' ? await readBody(req) : '';

    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      sendJson(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      return;
    }
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      sendJson(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (path === '/register' && req.method === 'POST') {
      const metadata = JSON.parse(body || '{}') as Record<string, unknown>;
      sendJson(res, 201, { ...metadata, client_id: 'fake-client' });
      return;
    }
    if (path === '/authorize') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>consent</body></html>');
      return;
    }
    if (path === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === refreshToken) {
        sendJson(res, 200, { access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expires_in: 3600 });
      } else {
        sendJson(res, 400, { error: 'invalid_grant' });
      }
      return;
    }

    if (path !== '/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${accessToken}`) {
      sendJson(res, 401, { error: 'unauthorized' }, {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const result: Record<string, unknown> = message.method === 'initialize'
      ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-oauth', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'Answer pong.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: 'pong' }] };
    sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: `${origin}/mcp`,
    origin,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
