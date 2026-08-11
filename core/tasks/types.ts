import type { AssetType } from '../parsers/types.js';

export type RiskPaceLevel = 'fast' | 'standard' | 'conservative';

export type QueueRunState =
  | 'idle'
  | 'running'
  | 'cooling'
  | 'paused'
  | 'autoPaused'
  | 'securityBlocked'
  | 'completed'
  | 'failed';

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
  riskPaceLevel?: RiskPaceLevel;
  imageConcurrency: number;
  requestDelayMs: number;
  // ── 反风控节奏控制参数 ──
  taskCooldownMin: number;   // 任务间最小冷却时间（秒）
  taskCooldownMax: number;   // 任务间最大冷却时间（秒）
  browsePauseMin: number;    // 模拟浏览/长休最短时长（秒）
  browsePauseMax: number;    // 模拟浏览/长休最长时长（秒）
  browseInterval: number;    // 每完成 N 个任务触发一次浏览休息
  enablePrewarm: boolean;    // 解析前是否先访问京东首页做预热导航
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

export type TaskFailureKind =
  | 'securityRisk'
  | 'captcha'
  | 'authExpired'
  | 'parseEmpty'
  | 'network'
  | 'download'
  | 'unknown';

export interface ParsedImageUrls {
  main: string[];
  detail: string[];
  sku: string[];
}

export interface DownloadTask {
  id: string;
  platform?: string;
  sourceUrl: string;
  skuId?: string;
  title?: string;
  prices?: {
    current?: string;
    original?: string;
  };
  selectedTypes?: AssetType[];
  downloadPolicy?: DownloadPolicy;
  mode?: TaskMode;
  assetCounts?: AssetCounts;
  parsedImageUrls?: ParsedImageUrls;
  status: TaskStatus;
  progress: TaskProgress;
  failureKind?: TaskFailureKind;
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
    | 'prices'
    | 'selectedTypes'
    | 'downloadPolicy'
    | 'mode'
    | 'assetCounts'
    | 'parsedImageUrls'
    | 'status'
    | 'progress'
    | 'failureKind'
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
  /** 获取当前活跃任务的下载策略，用于动态控制冷却和浏览休息节奏 */
  getActivePolicyFn?: () => DownloadPolicy | undefined;
  /** 模拟浏览/长休回调，接收最小/最大休息时长（秒），TaskQueue 会在达到阈值时调用 */
  onBrowseCooldown?: (browsePauseMin: number, browsePauseMax: number) => Promise<void>;
  /** 安全风控回调，当检测到安全类错误时调用，用于触发系统通知和 UI 提示 */
  onSecurityRisk?: (task: DownloadTask, failureKind: TaskFailureKind) => void;
  /** 连续失败自动暂停回调 */
  onAutoPaused?: (tasks: DownloadTask[]) => void;
}
