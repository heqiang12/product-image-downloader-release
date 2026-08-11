import path from 'node:path';
import type { AssetItem, AssetType, ProductAssets } from '../parsers/types.js';
import { ensureDir } from '../utils/fs.js';
import { buildProductFolderName } from '../utils/filename.js';
import { saveAssetFile } from './fileWriter.js';
import { writeMetaExcel } from './excelMetaWriter.js';
import type {
  DownloadedAsset,
  DownloadOptions,
  DownloadProgress,
  ProductDownloadResult,
} from './types.js';

const DEFAULT_SELECTED_TYPES: AssetType[] = ['main', 'detail', 'sku'];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const flattenSelectedAssets = (
  product: ProductAssets,
  selectedTypes: AssetType[] = DEFAULT_SELECTED_TYPES,
): AssetItem[] => {
  const seen = new Set<string>();
  const assets: AssetItem[] = [];

  for (const type of selectedTypes) {
    if (type === 'currentPrice' || type === 'originalPrice') {
      continue;
    }

    for (const asset of product.images[type as 'main' | 'detail' | 'sku' | 'unknown'] || []) {
      if (seen.has(asset.url)) {
        continue;
      }

      seen.add(asset.url);
      assets.push(asset);
    }
  }

  return assets;
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const downloadOneAsset = async (
  asset: AssetItem,
  index: number,
  outputDir: string,
  options: Required<Pick<DownloadOptions, 'retries' | 'timeoutMs' | 'fetchImpl'>>,
): Promise<DownloadedAsset> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        asset.url,
        {
          headers: {
            Referer: asset.referer || 'https://item.jd.com/',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        },
        options.timeoutMs,
        options.fetchImpl,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';

      if (!contentType.toLowerCase().startsWith('image/')) {
        throw new Error(`非图片响应: ${contentType || 'unknown'}`);
      }

      const savedFile = await saveAssetFile({
        asset,
        index,
        outputDir,
        data: await response.arrayBuffer(),
        contentType,
      });

      return {
        asset,
        status: 'success',
        filePath: savedFile.filePath,
        filename: savedFile.filename,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;

      if (attempt <= options.retries) {
        // 指数退避：500ms, 1000ms, 2000ms ... 上限 10 秒
        const backoffMs = Math.min(500 * Math.pow(2, attempt - 1), 10_000);
        await sleep(backoffMs);
      }
    }
  }

  return {
    asset,
    status: 'failed',
    errorMessage: lastError instanceof Error ? lastError.message : String(lastError),
    attempts: options.retries + 1,
  };
};

export const downloadProductAssets = async (
  product: ProductAssets,
  options: DownloadOptions,
): Promise<ProductDownloadResult> => {
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const retries = Math.max(0, options.retries ?? 2);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  const requestDelayMs = Math.max(0, options.requestDelayMs ?? 0);
  const fetchImpl = options.fetchImpl ?? fetch;
  const selectedTypes = options.selectedTypes ?? DEFAULT_SELECTED_TYPES;
  const assets = flattenSelectedAssets(product, selectedTypes);
  const outputDir = path.join(options.outputRoot, buildProductFolderName(product.title, product.skuId));
  const results: DownloadedAsset[] = [];
  const progress: DownloadProgress = {
    total: assets.length,
    success: 0,
    failed: 0,
  };

  await ensureDir(outputDir);

  let cursor = 0;
  let lastRequestTime = 0;

  // 全局速率限制：确保任意两次请求间隔不低于 minInterval（含 ±30% 随机抖动）
  const globalGate = async (minInterval: number) => {
    if (minInterval <= 0) return;
    const elapsed = Date.now() - lastRequestTime;
    const jitter = minInterval * (0.7 + Math.random() * 0.6); // 70%~130% 范围
    if (elapsed < jitter) {
      await sleep(jitter - elapsed);
    }
    lastRequestTime = Date.now();
  };

  const worker = async () => {
    while (cursor < assets.length) {
      const currentIndex = cursor;
      cursor += 1;

      const asset = assets[currentIndex];
      progress.current = asset.url;
      options.onProgress?.({ ...progress });

      if (currentIndex > 0) {
        await globalGate(requestDelayMs);
      }

      const result = await downloadOneAsset(asset, currentIndex + 1, outputDir, {
        retries,
        timeoutMs,
        fetchImpl,
      });

      results[currentIndex] = result;

      if (result.status === 'success') {
        progress.success += 1;
      } else {
        progress.failed += 1;
      }

      options.onProgress?.({ ...progress });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, assets.length) }, () => worker()),
  );

  delete progress.current;

  const metaPath = await writeMetaExcel({
    product,
    outputDir,
    progress,
    assets: results,
    selectedTypes,
  });

  const result: ProductDownloadResult = {
    product,
    outputDir,
    metaPath,
    progress,
    assets: results,
  };

  return result;
};
