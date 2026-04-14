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

    expect(JSON.parse(result)).toEqual({
      tool: 'ping',
      arguments: { ok: true },
    });
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
    expect(JSON.parse(result)).toEqual({
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
