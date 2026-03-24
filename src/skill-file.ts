import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeSkillFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

export async function removeSkillDirectory(filePath: string): Promise<void> {
  await rm(dirname(filePath), { recursive: true, force: true });
}
