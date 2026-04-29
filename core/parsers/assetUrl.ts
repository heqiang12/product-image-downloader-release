import type { AssetItem, AssetType } from './types.js';

// 京东图片 CDN 域名：包含旧版 360buyimg.com 和新版 x-jd.com、img*.jd.com
const IMAGE_HOST_PATTERN = /(^|\.)360buyimg\.com$|(^|\.)x-jd\.com$|(^|\.)(?:img\d+|imgzone|storage)\.jd\.com$/i;
const IMAGE_EXT_PATTERN = /\.(avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
// 同时匹配两套 CDN 主机
const JD_IMAGE_URL_PATTERN =
  /(?:(?:https?:)?\/\/)?(?:img\d{2}|m|imgzone|storage)\.360buyimg\.com\/[^\s"'<>\\)]+|(?:(?:https?:)?\/\/)?(?:img\d*)\.x-jd\.com\/[^\s"'<>\\)]+|(?:(?:https?:)?\/\/)?(?:img\d+|imgzone|storage)\.jd\.com\/[^\s"'<>\\)]+/gi;
const NOISY_PATH_PATTERN =
  /\/(?:imagetools|babel|channel2022|assets|sprite|icons?|logo|jshop|cms|devfe|uba|da|cc|libres|retail-mall|jsresource)\/|sprite-|\.svg/i;
const PRODUCT_IMAGE_PATH_PATTERN =
  /\/(?:n\d+|sku|imgzone|popWareDetail|vc|jfs|img)\/|\/jfs\//i;
// 小尺寸缩略图路径（宽或高 < 200px），视为图标/角标，不采集
const THUMBNAIL_PATH_PATTERN = /\/s(?:[1-9]\d?|1\d\d)x(?:[1-9]\d?|1\d\d)_/i;

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export const normalizeAssetUrl = (rawUrl: string): string | null => {
  let cleanedUrl = decodeHtmlEntities(rawUrl).trim().replace(/^['"]|['"]$/g, '');

  if (!cleanedUrl || cleanedUrl.startsWith('data:') || cleanedUrl.startsWith('blob:')) {
    return null;
  }

  cleanedUrl = cleanedUrl.replace(/\/n\d+\/s\d+x\d+_jfs\//i, '/n1/jfs/');
  cleanedUrl = cleanedUrl.replace(/\/s\d+x\d+_jfs\//i, '/jfs/');

  const absoluteUrl = cleanedUrl.startsWith('//') ? `https:${cleanedUrl}` : cleanedUrl;

  try {
    const url = new URL(absoluteUrl);

    if (!IMAGE_HOST_PATTERN.test(url.hostname)) {
      return null;
    }

    url.pathname = url.pathname
      .replace(/\/{2,}/g, '/')
      .replace(/^\/n0\/jfs\//i, '/n1/jfs/');

    // 先检查是否为商品图路径（优先级最高，直接放行，不被噪声规则误杀）
    if (PRODUCT_IMAGE_PATH_PATTERN.test(url.pathname)) {
      // 但过滤掉宽或高 < 200px 的小尺寸缩略图（通常是角标/图标）
      if (THUMBNAIL_PATH_PATTERN.test(url.pathname)) {
        return null;
      }
      url.protocol = 'https:';
      url.hash = '';
      return url.toString();
    }

    // 再排除明确的噪声路径（图标、logo、模板等资源）
    if (NOISY_PATH_PATTERN.test(url.pathname)) {
      return null;
    }

    url.protocol = 'https:';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

export const collectJdImageUrlsFromText = (text: string): string[] => {
  const matches = decodeHtmlEntities(text).match(JD_IMAGE_URL_PATTERN) || [];
  const urls = matches
    .map((item) => normalizeAssetUrl(item))
    .filter((item): item is string => Boolean(item))
    .filter((item) => IMAGE_EXT_PATTERN.test(item) || item.includes('/jfs/'));

  return Array.from(new Set(urls));
};

export const createAssetItems = (
  urls: string[],
  type: AssetType,
  referer: string,
  source: AssetItem['source'],
): AssetItem[] =>
  urls.map((url) => ({
    url,
    type,
    referer,
    source,
  }));

export const uniqueAssetItems = (items: AssetItem[]): AssetItem[] => {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (seen.has(item.url)) {
      return false;
    }

    seen.add(item.url);
    return true;
  });
};
