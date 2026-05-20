export {};

export type TaskStatus =
  | 'pending'
  | 'parsing'
  | 'downloading'
  | 'success'
  | 'failed'
  | 'paused';

export type AssetType = 'main' | 'detail' | 'sku' | 'unknown';

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

export interface ParsedImageUrls {
  main: string[];
  detail: string[];
  sku: string[];
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
  parsedImageUrls?: ParsedImageUrls;
  status: TaskStatus;
  progress: {
    total: number;
    success: number;
    failed: number;
  };
  failureKind?: TaskFailureKind;
  errorMessage?: string;
  outputDir?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformAuthStatus {
  platform: string;
  name: string;
  loginUrl?: string;
  isLoggedIn: boolean;
  cookieCount: number;
  profilePartition: string;
  updatedAt?: number;
}

export interface ExcelImportResponse {
  canceled: boolean;
  totalRows: number;
  addedCount: number;
  invalidRows: Array<{
    rowNumber: number;
    reason: string;
  }>;
  tasks: DownloadTask[];
}

declare global {
  interface Window {
    jdDownloader: {
      getAppVersion: () => Promise<string>;
      checkUpdates: () => Promise<{
        ok: boolean;
        skipped?: boolean;
        message?: string;
      }>;
      onUpdateDownloadProgress: (
        callback: (progress: { percent: number; transferred: number; total: number }) => void,
      ) => () => void;
      onUpdateError: (callback: (message: string) => void) => () => void;
      getOutputRoot: () => Promise<string>;
      selectOutputRoot: () => Promise<string>;
      listPlatforms: () => Promise<PlatformAuthStatus[]>;
      loginPlatform: (platformId: string) => Promise<{
        ok: boolean;
        errorMessage?: string;
      }>;
      refreshPlatformAuth: (platformId: string) => Promise<PlatformAuthStatus[]>;
      clearPlatformAuth: (platformId: string) => Promise<{
        ok: boolean;
        errorMessage?: string;
      }>;
      importExcelLinks: (
        platformId: string,
        selectedTypes?: AssetType[],
        downloadPolicy?: DownloadPolicy,
        mode?: TaskMode,
      ) => Promise<ExcelImportResponse>;
      exportExcelTemplate: (platformId: string) => Promise<{
        ok: boolean;
        canceled: boolean;
        filePath?: string;
      }>;
      validateLinks: (platformId: string, rawInput: string) => Promise<{
        total: number;
        validLinks: string[];
      }>;
      addLinks: (
        platformId: string,
        rawInput: string,
        selectedTypes?: AssetType[],
        downloadPolicy?: DownloadPolicy,
        mode?: TaskMode,
      ) => Promise<DownloadTask[]>;
      listTasks: () => Promise<DownloadTask[]>;
      startTasks: () => Promise<DownloadTask[]>;
      pauseTasks: () => Promise<DownloadTask[]>;
      retryFailed: () => Promise<DownloadTask[]>;
      clearCompleted: () => Promise<DownloadTask[]>;
      clearFailed: () => Promise<DownloadTask[]>;
      clearPending: () => Promise<DownloadTask[]>;
      getQueueStatus: () => Promise<{
        state: QueueRunState;
        autoPaused: boolean;
        consecutiveFailures: number;
        threshold: number;
        cooldownUntil?: number;
        lastErrorMessage?: string;
        lastFailureKind?: TaskFailureKind;
        counts: {
          total: number;
          pending: number;
          running: number;
          success: number;
          failed: number;
        };
        currentTask?: {
          id: string;
          title?: string;
          skuId?: string;
          sourceUrl: string;
          status: TaskStatus;
        };
      }>;
      removeTask: (taskId: string) => Promise<DownloadTask[]>;
      openManualVerify: (platformId: string, taskId?: string) => Promise<{
        ok: boolean;
        errorMessage?: string;
      }>;
      openOutput: (taskId: string) => Promise<{
        ok: boolean;
        errorMessage?: string;
      }>;
    };
  }
}
