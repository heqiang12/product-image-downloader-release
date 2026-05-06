import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetItem } from '../parsers/types.js';
import { ensureDir } from '../utils/fs.js';
import {
  buildAssetFilename,
  getExtensionFromContentType,
  getExtensionFromUrl,
} from '../utils/filename.js';

const ASSET_TYPE_DIR_NAMES: Record<AssetItem['type'], string> = {
  main: '轮播图',
  detail: '详情图',
  sku: '规格图',
  unknown: '其他图片',
};

export interface SaveAssetInput {
  asset: AssetItem;
  index: number;
  outputDir: string;
  data: ArrayBuffer;
  contentType: string;
}

export interface SaveAssetResult {
  filePath: string;
  filename: string;
}

export const saveAssetFile = async ({
  asset,
  index,
  outputDir,
  data,
  contentType,
}: SaveAssetInput): Promise<SaveAssetResult> => {
  const typeDir = path.join(outputDir, ASSET_TYPE_DIR_NAMES[asset.type]);
  await ensureDir(typeDir);

  const extension =
    getExtensionFromContentType(contentType) || getExtensionFromUrl(asset.url) || '.jpg';
  const filename = asset.filename || buildAssetFilename(asset.type, index, extension);
  const filePath = path.join(typeDir, filename);

  await writeFile(filePath, Buffer.from(data));

  return {
    filePath,
    filename,
  };
};
