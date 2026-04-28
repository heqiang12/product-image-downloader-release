import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredPlatformAuth } from '../auth/types.js';
import type { DownloadTask } from '../tasks/types.js';
import { ensureDir } from '../utils/fs.js';

export interface AppState {
  outputRoot: string;
  tasks: DownloadTask[];
  auth: StoredPlatformAuth[];
  updatedAt: number;
}

const DEFAULT_STATE: AppState = {
  outputRoot: '',
  tasks: [],
  auth: [],
  updatedAt: 0,
};

export class AppStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AppState> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as Partial<AppState>;

      return {
        outputRoot: typeof parsed.outputRoot === 'string' ? parsed.outputRoot : '',
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isValidTask) : [],
        auth: Array.isArray(parsed.auth) ? parsed.auth.filter(isValidAuthState) : [],
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  async save(state: AppState): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

const isValidTask = (task: unknown): task is DownloadTask => {
  if (!task || typeof task !== 'object') {
    return false;
  }

  const candidate = task as Partial<DownloadTask>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.sourceUrl === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number' &&
    typeof candidate.progress?.total === 'number' &&
    typeof candidate.progress.success === 'number' &&
    typeof candidate.progress.failed === 'number'
  );
};

const isValidAuthState = (authState: unknown): authState is StoredPlatformAuth => {
  if (!authState || typeof authState !== 'object') {
    return false;
  }

  const candidate = authState as Partial<StoredPlatformAuth>;
  return (
    typeof candidate.platform === 'string' &&
    typeof candidate.isLoggedIn === 'boolean' &&
    typeof candidate.cookieCount === 'number' &&
    typeof candidate.updatedAt === 'number'
  );
};
