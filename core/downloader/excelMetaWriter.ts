import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import XLSX from 'xlsx';
import type { DownloadedAsset } from './types.js';
import type { ProductAssets } from '../parsers/types.js';

const ASSET_TYPE_LABEL: Record<string, string> = {
  main: '主图',
  detail: '详情图',
  sku: '规格图',
  unknown: '其他',
};

const STATUS_LABEL: Record<string, string> = {
  success: '成功',
  failed: '失败',
};

/**
 * Write download meta as Excel file into the product output directory.
 * Returns the absolute path of the written file.
 */
export const writeMetaExcel = async (params: {
  product: ProductAssets;
  outputDir: string;
  progress: { total: number; success: number; failed: number };
  assets: DownloadedAsset[];
}): Promise<string> => {
  const rows: Record<string, unknown>[] = [
    {
      商品名称: params.product.title,
      商品编码: params.product.skuId,
      商品链接: params.product.sourceUrl,
      平台: params.product.platform.toUpperCase(),
      下载时间: new Date().toISOString(),
      图片总数: params.progress.total,
      成功数: params.progress.success,
      失败数: params.progress.failed,
    },
  ];

  for (let i = 0; i < params.assets.length; i++) {
    const asset = params.assets[i];
    rows.push({
      商品名称: params.product.title,
      商品编码: params.product.skuId,
      商品链接: params.product.sourceUrl,
      图片类型: ASSET_TYPE_LABEL[asset.asset.type] ?? asset.asset.type,
      图片序号: i + 1,
      图片链接: asset.asset.url,
      文件名: asset.filename ?? '',
      本地路径: asset.filePath ? path.relative(params.outputDir, asset.filePath) : '',
      下载状态: STATUS_LABEL[asset.status] ?? asset.status,
      失败原因: asset.errorMessage ?? '',
      重试次数: asset.attempts,
    });
  }

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);

  // Column widths for better readability
  sheet['!cols'] = [
    { wch: 25 }, // 商品名称
    { wch: 16 }, // 商品编码
    { wch: 45 }, // 商品链接
    { wch: 8 },  // 平台
    { wch: 22 }, // 下载时间
    { wch: 8 },  // 图片总数
    { wch: 8 },  // 成功数
    { wch: 8 },  // 失败数
  ];

  XLSX.utils.book_append_sheet(workbook, sheet, '商品图片清单');

  const filePath = path.join(params.outputDir, '商品图片清单.xlsx');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  await writeFile(filePath, buffer);

  return filePath;
};
