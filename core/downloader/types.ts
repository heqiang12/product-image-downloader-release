import type { AssetItem, AssetType, ProductAssets } from '../parsers/types.js';

export type DownloadStatus = 'success' | 'failed';

export interface DownloadOptions {
  outputRoot: string;
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  requestDelayMs?: number;
  selectedTypes?: AssetType[];
  fetchImpl?: typeof fetch;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadProgress {
  total: number;
  success: number;
  failed: number;
  current?: string;
}

export interface DownloadedAsset {
  asset: AssetItem;
  status: DownloadStatus;
  filePath?: string;
  filename?: string;
  errorMessage?: string;
  attempts: number;
}

export interface ProductDownloadResult {
  product: ProductAssets;
  outputDir: string;
  metaPath: string;
  progress: DownloadProgress;
  assets: DownloadedAsset[];
}
