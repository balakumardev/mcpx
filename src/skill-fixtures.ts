import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getGenerator } from './generators/index.js';
import type { AgentType, GeneratorContext, ToolInfo } from './types.js';

/** Helpers for tests that lay out skill directories the way mcpkit and users do. */

const echoTool: ToolInfo = { name: 'echo', description: 'Echo a message', inputSchema: { type: 'object' } };

/** The context a registered stdio server is generated from. */
export function skillContext(serverName: string, tools: ToolInfo[] = [echoTool]): GeneratorContext {
  return { serverName, tools, transport: { type: 'stdio', command: 'node', args: ['server.js'] }, scope: 'global' };
}

/** The global skill file of `serverName` for `agent`, and the content mcpkit generates for it. */
export async function generatedSkill(agent: AgentType, serverName: string, tools?: ToolInfo[]): Promise<{ path: string; dir: string; content: string }> {
  const skill = (await getGenerator(agent))(skillContext(serverName, tools));
  return { path: skill.filePath, dir: dirname(skill.filePath), content: skill.content };
}

/** Write the skill mcpkit would generate for `serverName`; returns where it went and what it holds. */
export async function writeGeneratedSkill(agent: AgentType, serverName: string, tools?: ToolInfo[]): Promise<{ path: string; dir: string; content: string }> {
  const skill = await generatedSkill(agent, serverName, tools);
  await mkdir(skill.dir, { recursive: true });
  await writeFile(skill.path, skill.content, 'utf-8');
  return skill;
}

/** A skill directory somebody wrote by hand, named like one of ours. */
export async function writeUserSkill(agent: AgentType, dirName: string, content = `---\nname: ${dirName}\ndescription: "mine"\n---\n\n# Mine\n`): Promise<{ path: string; dir: string; content: string }> {
  const lookalike = await generatedSkill(agent, 'placeholder');
  const dir = join(dirname(lookalike.dir), dirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  await writeFile(path, content, 'utf-8');
  return { path, dir, content };
}

/** Every path under `dir` (files and directories, symlinks as they are) with the content of each file, sorted. */
export async function treeOf(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const lines = await Promise.all(entries.map(async (entry) => {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) return `${path} ${await readFile(path, 'utf-8')}`;
    return `${path}${entry.isSymbolicLink() ? ' ->' : '/'}`;
  }));
  return lines.sort();
}
