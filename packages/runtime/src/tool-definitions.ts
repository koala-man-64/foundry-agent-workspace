import { z } from 'zod';
import type { ToolDefinition } from '../../protocol/src/index';

const RelativePath = z.string().min(1).max(4096);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ToolArguments = {
  list_directory: z.object({ path: z.string().max(4096).default('') }).strict(),
  read_file: z.object({ path: RelativePath }).strict(),
  search_text: z.object({ query: z.string().min(1).max(2000), path: z.string().max(4096).default('') }).strict(),
  write_file: z.object({ path: RelativePath, expectedHash: Hash, content: z.string().max(65536) }).strict(),
  replace_text: z.object({ path: RelativePath, expectedHash: Hash, oldText: z.string().min(1).max(65536), newText: z.string().max(65536) }).strict(),
  run_command: z.object({ command: z.string().min(1).max(16384), cwd: z.string().max(4096).default(''), environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).default({}), timeoutMs: z.number().int().min(100).max(600000).default(600000) }).strict()
} as const;
export type ToolName = keyof typeof ToolArguments;
const descriptions: Record<ToolName, string> = {
  list_directory: 'List a relative directory in the task worktree. The root path is an empty string. Secret files and Git metadata are unavailable.',
  read_file: 'Read a UTF-8 file and its SHA-256 content hash. Paths must be relative to the task worktree.',
  search_text: 'Find literal text in accessible worktree files. Results are bounded and report skipped content.',
  write_file: 'Propose full replacement of an existing file using its exact SHA-256 hash. New-file creation is unavailable through this tool. The user must review and approve the full change.',
  replace_text: 'Propose exactly one literal replacement in a file with the expected SHA-256 hash. The match must be unique. The user reviews and approves the change.',
  run_command: 'Propose a non-interactive PowerShell command in a relative directory. The user must approve the exact command, directory, shell, environment and timeout. Approval is not sandboxing.'
};
export const TOOL_DEFINITIONS: ToolDefinition[] = (Object.keys(ToolArguments) as ToolName[]).map(name => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(ToolArguments[name], { target: 'draft-7' }) as Record<string, unknown> }));
