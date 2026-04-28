import path from 'node:path';
import type { AssetItem, AssetType, ProductAssets } from '../parsers/types.js';
import { ensureDir, writeJsonFile } from '../utils/fs.js';
import { buildProductFolderName } from '../utils/filename.js';
import { saveAssetFile } from './fileWriter.js';
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
    for (const asset of product.images[type] || []) {
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
        await sleep(150 * attempt);
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

  const worker = async () => {
    while (cursor < assets.length) {
      const currentIndex = cursor;
      cursor += 1;

      const asset = assets[currentIndex];
      progress.current = asset.url;
      options.onProgress?.({ ...progress });

      if (requestDelayMs > 0 && currentIndex > 0) {
        await sleep(requestDelayMs);
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

  const metaPath = path.join(outputDir, 'meta.json');
  const result: ProductDownloadResult = {
    product,
    outputDir,
    metaPath,
    progress,
    assets: results,
  };

  await writeJsonFile(metaPath, {
    product: {
      platform: product.platform,
      skuId: product.skuId,
      title: product.title,
      sourceUrl: product.sourceUrl,
    },
    progress,
    assets: results,
    generatedAt: new Date().toISOString(),
  });

  return result;
};
