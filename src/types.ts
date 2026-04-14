// Transport types
export type TransportType = 'stdio' | 'http' | 'sse';
export type AuthType = 'oauth';
export type RuntimeMode = 'ephemeral' | 'persistent';

export const DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC = 15 * 60;

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
}

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
  oauth?: OAuthConfig;
}

export interface SseTransportConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  auth?: AuthType;
  oauth?: OAuthConfig;
}

export type TransportConfig = StdioTransportConfig | HttpTransportConfig | SseTransportConfig;

// Param provider — runs a command before each tool call and merges JSON output into params
export interface ParamProviderConfig {
  command: string;    // shell command to run (e.g. "eiamcli iamticket")
  args?: string[];    // optional arguments
  ttl?: number;       // cache TTL in seconds (default: 0 = no cache)
}

export interface ServerRuntimeConfig {
  mode: RuntimeMode;
  idleTimeoutSec?: number;
}

// Registry types
export interface ServerEntry {
  name: string;
  transport: TransportConfig;
  description?: string;
  paramProvider?: ParamProviderConfig;
  runtime?: ServerRuntimeConfig;
  toolCount: number;
  agents: AgentType[];
  agentSelectionMode?: AgentSelectionMode;
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
export type AgentType = 'claude-code' | 'cursor' | 'codex' | 'windsurf' | 'augment' | 'openclaw';

export const ALL_AGENTS: AgentType[] = ['claude-code', 'cursor', 'codex', 'windsurf', 'augment', 'openclaw'];

export type AgentSelectionMode = 'defaults' | 'explicit';

export type Scope = 'global' | 'project';

export interface AgentSettings {
  version: 1;
  enabledAgents: AgentType[];
  updatedAt: string;
}

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
