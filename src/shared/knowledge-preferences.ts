import type { KnowledgePreferences } from './knowledge';

export function defaultKnowledgePreferences(): KnowledgePreferences {
  return { displayName: '我的本地知识库', fileTypes: ['txt', 'md', 'docx', 'pdf'], excludeDirectories: [], autoSyncEnabled: true, syncIntervalMinutes: 5, maxFileSizeMb: 50 };
}

/** Shared validation; preferences never become shell arguments or arbitrary paths. */
export function normalizeKnowledgePreferences(value: unknown): KnowledgePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('知识库个性化设置格式无效。');
  const input = value as Record<string, unknown>;
  const allowed = ['displayName', 'fileTypes', 'excludeDirectories', 'autoSyncEnabled', 'syncIntervalMinutes', 'maxFileSizeMb'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('知识库设置包含不支持的字段。');
  if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 60) throw new Error('知识库名称应为1到60个字符。');
  if (!Array.isArray(input.fileTypes) || !input.fileTypes.length || input.fileTypes.length > 4 || input.fileTypes.some(type => !['txt', 'md', 'docx', 'pdf'].includes(type))) throw new Error('请至少选择一种受支持的资料格式。');
  if (!Array.isArray(input.excludeDirectories) || input.excludeDirectories.length > 32) throw new Error('排除目录最多设置32项。');
  const directories = input.excludeDirectories.map(item => {
    if (typeof item !== 'string' || item.length > 512) throw new Error('排除目录应为有效的相对目录。');
    const directory = item.trim().replaceAll('\\', '/').replace(/\/+$/, '');
    if (!directory || directory.startsWith('/') || /[\u0000-\u001f:*?<>"|]/u.test(directory) || directory.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('排除目录请填写资料目录内的相对路径，不支持绝对路径、上级路径或通配符。');
    return directory;
  });
  if (typeof input.autoSyncEnabled !== 'boolean' || !Number.isInteger(input.syncIntervalMinutes) || Number(input.syncIntervalMinutes) < 5 || Number(input.syncIntervalMinutes) > 1440) throw new Error('自动同步间隔应为5到1440分钟。');
  if (!Number.isInteger(input.maxFileSizeMb) || Number(input.maxFileSizeMb) < 1 || Number(input.maxFileSizeMb) > 50) throw new Error('单文件读取上限应为1到50 MiB。');
  return { displayName: input.displayName.trim(), fileTypes: [...new Set(input.fileTypes)] as KnowledgePreferences['fileTypes'], excludeDirectories: [...new Set(directories)], autoSyncEnabled: input.autoSyncEnabled, syncIntervalMinutes: Number(input.syncIntervalMinutes), maxFileSizeMb: Number(input.maxFileSizeMb) };
}

/** A running review keeps its old scope, while newly tightened settings also apply. */
export function intersectKnowledgePreferences(a: KnowledgePreferences, b: KnowledgePreferences): KnowledgePreferences {
  return { ...a, fileTypes: a.fileTypes.filter(type => b.fileTypes.includes(type)), excludeDirectories: [...new Set([...a.excludeDirectories, ...b.excludeDirectories])], maxFileSizeMb: Math.min(a.maxFileSizeMb, b.maxFileSizeMb) };
}
