import type { AssetType, ProductAssets } from '../parsers/types.js';
import type { ProductDownloadResult } from '../downloader/types.js';
import { resolvePlatformLink } from '../platforms/registry.js';
import type { AssetCounts, DownloadPolicy, ParsedImageUrls, TaskProcessor } from './types.js';

const DEFAULT_SELECTED_TYPES: AssetType[] = ['main', 'detail', 'sku'];
const DEFAULT_DOWNLOAD_POLICY: DownloadPolicy = {
  safeMode: true,
  imageConcurrency: 2,
  requestDelayMs: 800,
};

export type ProductParser = (sourceUrl: string) => Promise<ProductAssets>;

export type ProductDownloader = (
  product: ProductAssets,
  options: {
    outputRoot: string;
    selectedTypes?: AssetType[];
    downloadPolicy?: DownloadPolicy;
    onProgress: (progress: { total: number; success: number; failed: number }) => void;
  },
) => Promise<ProductDownloadResult>;

export interface ProductTaskProcessorOptions {
  getOutputRoot: () => string;
  parseProductAssets: ProductParser;
  downloadProductAssets: ProductDownloader;
}

const buildParsedImageUrls = (product: ProductAssets): ParsedImageUrls => ({
  main: product.images.main.map((item) => item.url),
  detail: product.images.detail.map((item) => item.url),
  sku: product.images.sku.map((item) => item.url),
});

const buildAssetCounts = (
  product: ProductAssets,
  selectedTypes: AssetType[],
): AssetCounts => ({
  main: product.images.main.length,
  detail: product.images.detail.length,
  sku: product.images.sku.length,
  unknown: product.images.unknown.length,
  selected: selectedTypes.reduce((sum, type) => sum + (product.images[type]?.length || 0), 0),
  total:
    product.images.main.length +
    product.images.detail.length +
    product.images.sku.length +
    product.images.unknown.length,
});

export const createProductTaskProcessor = ({
  getOutputRoot,
  parseProductAssets,
  downloadProductAssets,
}: ProductTaskProcessorOptions): TaskProcessor => {
  return async (task, update) => {
    const resolvedLink = resolvePlatformLink(task.sourceUrl);

    if (!resolvedLink) {
      throw new Error(`不支持的商品链接: ${task.sourceUrl}`);
    }

    update({
      status: 'parsing',
      platform: resolvedLink.platform.id,
      skuId: resolvedLink.skuId || task.skuId,
      progress: {
        total: 0,
        success: 0,
        failed: 0,
      },
    });

    const product = await parseProductAssets(resolvedLink.normalizedUrl);
    const selectedTypes =
      task.selectedTypes?.length ? task.selectedTypes : DEFAULT_SELECTED_TYPES;
    const downloadPolicy = task.downloadPolicy || DEFAULT_DOWNLOAD_POLICY;
    const assetCounts = buildAssetCounts(product, selectedTypes);
    const total = assetCounts.selected;

    if (task.mode === 'parseOnly') {
      update({
        status: 'success',
        title: product.title,
        skuId: product.skuId,
        selectedTypes,
        downloadPolicy,
        mode: 'parseOnly',
        assetCounts,
        parsedImageUrls: buildParsedImageUrls(product),
        progress: {
          total,
          success: total,
          failed: 0,
        },
      });
      return;
    }

    if (total === 0) {
      update({
        status: 'failed',
        title: product.title,
        skuId: product.skuId,
        selectedTypes,
        downloadPolicy,
        assetCounts,
        errorMessage: '未解析到勾选类型的商品图片',
        progress: {
          total: 0,
          success: 0,
          failed: 0,
        },
      });
      return;
    }

    update({
      status: 'downloading',
      title: product.title,
      skuId: product.skuId,
      selectedTypes,
      downloadPolicy,
      assetCounts,
      parsedImageUrls: buildParsedImageUrls(product),
      progress: {
        total,
        success: 0,
        failed: 0,
      },
    });

    const result = await downloadProductAssets(product, {
      outputRoot: getOutputRoot(),
      selectedTypes,
      downloadPolicy,
      onProgress: (progress) => {
        update({
          status: 'downloading',
          progress,
        });
      },
    });

    if (result.progress.failed > 0) {
      update({
        status: 'failed',
        outputDir: result.outputDir,
        errorMessage: `${result.progress.failed} 个资源下载失败`,
        progress: result.progress,
      });
      return;
    }

    update({
      status: 'success',
      outputDir: result.outputDir,
      progress: result.progress,
    });
  };
};
