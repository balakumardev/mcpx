import { describe, it, expect, afterEach, vi } from 'vitest';

type MockRequest = { name: string; arguments?: Record<string, unknown> };

interface MockSdkState {
  transports: Array<{ close: ReturnType<typeof vi.fn> }>;
  clients: Array<{
    connect: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    getServerVersion: ReturnType<typeof vi.fn>;
  }>;
  callToolImpl: (request: MockRequest) => Promise<Record<string, unknown>>;
}

function createMockSdkState(): MockSdkState {
  return {
    transports: [],
    clients: [],
    callToolImpl: async (request: MockRequest) => ({
      structuredContent: {
        tool: request.name,
        arguments: request.arguments ?? {},
      },
    }),
  };
}

async function importClientWithMocks(state: MockSdkState) {
  vi.resetModules();
  (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__ = 'test';

  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => {
    class MockClient {
      connect = vi.fn(async (_transport: unknown) => {});
      callTool = vi.fn(async (request: MockRequest) => state.callToolImpl(request));
      listTools = vi.fn(async () => ({ tools: [] }));
      getServerVersion = vi.fn(() => undefined);

      constructor() {
        state.clients.push(this);
      }
    }

    return { Client: MockClient };
  });

  const createTransportModule = (exportName: string) => () => {
    class MockTransport {
      close = vi.fn(async () => {});

      constructor(_config: unknown) {
        state.transports.push(this);
      }
    }

    return { [exportName]: MockTransport };
  };

  vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', createTransportModule('StdioClientTransport'));
  vi.doMock('@modelcontextprotocol/sdk/client/sse.js', createTransportModule('SSEClientTransport'));
  vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', createTransportModule('StreamableHTTPClientTransport'));

  return await import('./client.js');
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__;
  vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
  vi.doUnmock('@modelcontextprotocol/sdk/client/stdio.js');
  vi.doUnmock('@modelcontextprotocol/sdk/client/sse.js');
  vi.doUnmock('@modelcontextprotocol/sdk/client/streamableHttp.js');
  vi.resetModules();
  vi.clearAllMocks();
});

describe('tool session lifecycle', () => {
  it('closes the transport after a one-shot call', async () => {
    const state = createMockSdkState();
    const { callTool } = await importClientWithMocks(state);

    const result = await callTool(
      { type: 'stdio', command: 'mock-server', args: [] },
      'ping',
      { ok: true },
    );

    expect(JSON.parse(result.text)).toEqual({
      tool: 'ping',
      arguments: { ok: true },
    });
    expect(result.isError).toBe(false);
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0].connect).toHaveBeenCalledTimes(1);
    expect(state.transports).toHaveLength(1);
    expect(state.transports[0].close).toHaveBeenCalledTimes(1);
  });

  it('keeps a connected session open until the caller closes it', async () => {
    const state = createMockSdkState();
    const { connectToolSession } = await importClientWithMocks(state);

    const session = await connectToolSession({ type: 'stdio', command: 'mock-server', args: [] });

    expect(state.transports).toHaveLength(1);
    expect(state.transports[0].close).not.toHaveBeenCalled();

    const result = await session.callTool('ping', { ok: true });
    expect(JSON.parse(result.text)).toEqual({
      tool: 'ping',
      arguments: { ok: true },
    });
    expect(state.transports[0].close).not.toHaveBeenCalled();

    await session.close();
    await session.close();
    expect(state.transports[0].close).toHaveBeenCalledTimes(1);
  });

  it('reuses one connected session for chained calls', async () => {
    const state = createMockSdkState();
    state.callToolImpl = async (request: MockRequest) => {
      if (request.name === 'login') {
        return { structuredContent: { token: 'secret-token' } };
      }

      return {
        structuredContent: {
          tool: request.name,
          arguments: request.arguments ?? {},
        },
      };
    };

    const { callToolsChained } = await importClientWithMocks(state);

    const results = await callToolsChained(
      { type: 'stdio', command: 'mock-server', args: [] },
      [
        { toolName: 'login', params: {} },
        { toolName: 'search', params: { token: '$prev.token' } },
      ],
    );

    expect(results.map((output) => output.isError)).toEqual([false, false]);
    expect(results).toHaveLength(2);
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0].connect).toHaveBeenCalledTimes(1);
    expect(state.clients[0].callTool).toHaveBeenCalledTimes(2);
    expect(state.clients[0].callTool.mock.calls[1][0]).toEqual({
      name: 'search',
      arguments: { token: 'secret-token' },
    });
    expect(state.transports[0].close).toHaveBeenCalledTimes(1);
  });
});

describe('tool results', () => {
  it('returns the printable text, the normalised value and the error flag', async () => {
    const state = createMockSdkState();
    state.callToolImpl = async (request: MockRequest) => {
      switch (request.name) {
        case 'structured':
          return {
            content: [{ type: 'text', text: 'Found 2 items' }],
            structuredContent: { items: [1, 2] },
          };
        case 'json_text':
          return { content: [{ type: 'text', text: '{"a":1}' }] };
        case 'plain_text':
          return { content: [{ type: 'text', text: 'hello' }] };
        case 'image':
          return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
        case 'structured_image':
          return { structuredContent: { w: 1 }, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
        case 'legacy':
          return { toolResult: 'old-style' };
        default:
          return { isError: true, content: [{ type: 'text', text: 'boom' }] };
      }
    };
    const { connectToolSession } = await importClientWithMocks(state);
    const session = await connectToolSession({ type: 'stdio', command: 'mock-server', args: [] });

    expect(await session.callTool('structured', {})).toEqual({
      text: 'Found 2 items',
      value: { items: [1, 2] },
      isError: false,
    });
    expect(await session.callTool('json_text', {})).toEqual({ text: '{"a":1}', value: { a: 1 }, isError: false });
    expect(await session.callTool('plain_text', {})).toEqual({ text: 'hello', value: 'hello', isError: false });
    // An image is never part of the text: the raw part stays in the value, and `omitted` says what it was.
    expect(await session.callTool('image', {})).toEqual({
      text: '',
      value: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
      isError: false,
      omitted: ['image/png 3 bytes'],
    });
    expect(await session.callTool('structured_image', {})).toEqual({
      text: '{\n  "w": 1\n}',
      value: { w: 1 },
      isError: false,
      omitted: ['image/png 3 bytes'],
    });
    expect(await session.callTool('legacy', {})).toEqual({ text: 'old-style', value: 'old-style', isError: false });
    expect(await session.callTool('anything_else', {})).toEqual({ text: 'boom', value: 'boom', isError: true });

    await session.close();
  });

  it('stops a chain after the first call that reports isError', async () => {
    const state = createMockSdkState();
    state.callToolImpl = async (request: MockRequest) => (
      request.name === 'second'
        ? { isError: true, content: [{ type: 'text', text: 'second failed' }] }
        : { structuredContent: { ran: request.name } }
    );
    const { callToolsChained } = await importClientWithMocks(state);

    const outputs = await callToolsChained(
      { type: 'stdio', command: 'mock-server', args: [] },
      [
        { toolName: 'first', params: {} },
        { toolName: 'second', params: {} },
        { toolName: 'third', params: {} },
      ],
    );

    expect(outputs.map((output) => output.isError)).toEqual([false, true]);
    expect(outputs[1].text).toBe('second failed');
    expect(state.clients[0].callTool).toHaveBeenCalledTimes(2);
    expect(state.transports[0].close).toHaveBeenCalledTimes(1);
  });
});

describe('call timeout', () => {
  const stdio = { type: 'stdio' as const, command: 'mock-server', args: [] };

  afterEach(() => {
    delete process.env.MCPKIT_CALL_TIMEOUT_MS;
  });

  it('defaults to 15 minutes and honours MCPKIT_CALL_TIMEOUT_MS', async () => {
    const state = createMockSdkState();
    const { connectToolSession } = await importClientWithMocks(state);

    const session = await connectToolSession(stdio);
    await session.callTool('ping', {});
    expect(state.clients[0].callTool.mock.calls[0][2]).toEqual({ timeout: 900_000 });
    await session.close();

    process.env.MCPKIT_CALL_TIMEOUT_MS = '1234';
    const second = await connectToolSession(stdio);
    await second.callTool('ping', {});
    expect(state.clients[1].callTool.mock.calls[0][2]).toEqual({ timeout: 1234 });
    await second.close();
  });

  it('uses the timeoutMs option for single and chained calls, ahead of the environment variable', async () => {
    process.env.MCPKIT_CALL_TIMEOUT_MS = '1234';
    const state = createMockSdkState();
    const { connectToolSession } = await importClientWithMocks(state);

    const session = await connectToolSession(stdio, undefined, undefined, undefined, { timeoutMs: 7_000 });
    await session.callTool('one', {});
    await session.callToolsChained([
      { toolName: 'two', params: {} },
      { toolName: 'three', params: {} },
    ]);

    const timeouts = state.clients[0].callTool.mock.calls.map((call) => call[2]);
    expect(timeouts).toEqual([{ timeout: 7_000 }, { timeout: 7_000 }, { timeout: 7_000 }]);
    await session.close();
  });
});
