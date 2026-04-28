import type { AssetType } from '../parsers/types.js';

export type TaskStatus =
  | 'pending'
  | 'parsing'
  | 'downloading'
  | 'success'
  | 'failed'
  | 'paused';

export interface TaskProgress {
  total: number;
  success: number;
  failed: number;
}

export interface DownloadPolicy {
  safeMode: boolean;
  imageConcurrency: number;
  requestDelayMs: number;
}

export interface AssetCounts {
  main: number;
  detail: number;
  sku: number;
  unknown: number;
  selected: number;
  total: number;
}

export type TaskMode = 'download' | 'parseOnly';

export interface DownloadTask {
  id: string;
  platform?: string;
  sourceUrl: string;
  skuId?: string;
  title?: string;
  selectedTypes?: AssetType[];
  downloadPolicy?: DownloadPolicy;
  mode?: TaskMode;
  assetCounts?: AssetCounts;
  status: TaskStatus;
  progress: TaskProgress;
  errorMessage?: string;
  outputDir?: string;
  createdAt: number;
  updatedAt: number;
}

export type TaskPatch = Partial<
  Pick<
    DownloadTask,
    | 'platform'
    | 'skuId'
    | 'title'
    | 'selectedTypes'
    | 'downloadPolicy'
    | 'mode'
    | 'assetCounts'
    | 'status'
    | 'progress'
    | 'errorMessage'
    | 'outputDir'
  >
>;

export type TaskProcessor = (
  task: DownloadTask,
  update: (patch: TaskPatch) => void,
) => Promise<void>;

export interface TaskQueueOptions {
  concurrency?: number;
  processor: TaskProcessor;
  initialTasks?: DownloadTask[];
  onChange?: (tasks: DownloadTask[]) => void;
}
