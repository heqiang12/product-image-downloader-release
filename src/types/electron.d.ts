export {};

export type TaskStatus =
  | 'pending'
  | 'parsing'
  | 'downloading'
  | 'success'
  | 'failed'
  | 'paused';

export type AssetType = 'main' | 'detail' | 'sku' | 'unknown';

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
  progress: {
    total: number;
    success: number;
    failed: number;
  };
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
        selectedTypes?: AssetType[],
        downloadPolicy?: DownloadPolicy,
        mode?: TaskMode,
      ) => Promise<ExcelImportResponse>;
      exportExcelTemplate: () => Promise<{
        ok: boolean;
        canceled: boolean;
        filePath?: string;
      }>;
      validateLinks: (rawInput: string) => Promise<{
        total: number;
        validLinks: string[];
      }>;
      addLinks: (
        rawInput: string,
        selectedTypes?: AssetType[],
        downloadPolicy?: DownloadPolicy,
        mode?: TaskMode,
      ) => Promise<DownloadTask[]>;
      listTasks: () => Promise<DownloadTask[]>;
      startTasks: () => Promise<DownloadTask[]>;
      retryFailed: () => Promise<DownloadTask[]>;
      clearCompleted: () => Promise<DownloadTask[]>;
      clearFailed: () => Promise<DownloadTask[]>;
      removeTask: (taskId: string) => Promise<DownloadTask[]>;
      openOutput: (taskId: string) => Promise<{
        ok: boolean;
        errorMessage?: string;
      }>;
    };
  }
}
