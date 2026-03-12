// Transport types
export type TransportType = 'stdio' | 'http' | 'sse';
export type AuthType = 'oauth';

export interface StdioTransportConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HttpTransportConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  auth?: AuthType;
}

export interface SseTransportConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  auth?: AuthType;
}

export type TransportConfig = StdioTransportConfig | HttpTransportConfig | SseTransportConfig;

// Registry types
export interface ServerEntry {
  name: string;
  transport: TransportConfig;
  description?: string;
  toolCount: number;
  agents: AgentType[];
  createdAt: string;
  updatedAt: string;
}

export interface ServerRegistry {
  version: 1;
  servers: Record<string, ServerEntry>;
}

// Tool types
export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Agent types
export type AgentType = 'claude-code' | 'cursor' | 'codex' | 'windsurf' | 'augment';

export const ALL_AGENTS: AgentType[] = ['claude-code', 'cursor', 'codex', 'windsurf', 'augment'];

export type Scope = 'global' | 'project';

// Server metadata from MCP initialize + npm registry
export interface ServerMeta {
  name?: string;
  version?: string;
  instructions?: string;
  packageDescription?: string;
}

// Generator types
export interface GeneratedSkill {
  agent: AgentType;
  scope: Scope;
  filePath: string;
  content: string;
  isAppend: boolean;
}

export interface GeneratorContext {
  serverName: string;
  description?: string;
  serverMeta?: ServerMeta;
  tools: ToolInfo[];
  transport: TransportConfig;
  scope: Scope;
}
