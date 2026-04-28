import type { AssetItem, AssetType } from './types.js';

const IMAGE_HOST_PATTERN = /(^|\.)360buyimg\.com$/i;
const IMAGE_EXT_PATTERN = /\.(avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
const JD_IMAGE_URL_PATTERN =
  /(?:(?:https?:)?\/\/)?(?:img\d{2}|m|imgzone|storage)\.360buyimg\.com\/[^\s"'<>\\)]+/gi;
const NOISY_PATH_PATTERN =
  /\/(?:imagetools|babel|channel2022|assets|sprite|icons?|logo|jshop|cms|devfe|uba|da|cc|libres|retail-mall|jsresource)\/|sprite-|\.svg/i;
const PRODUCT_IMAGE_PATH_PATTERN =
  /\/(?:n\d+|sku|imgzone|popWareDetail|vc|jfs|img)\/|\/jfs\/|\/s\d+x\d+_/i;

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

    if (NOISY_PATH_PATTERN.test(url.pathname)) {
      return null;
    }

    if (!PRODUCT_IMAGE_PATH_PATTERN.test(url.pathname)) {
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
