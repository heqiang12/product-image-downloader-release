import { jdPlatformAdapter } from './jd/adapter.js';
import type { PlatformAdapter, ResolvedPlatformLink } from './types.js';

export const platformAdapters: PlatformAdapter[] = [jdPlatformAdapter];

export const findPlatformByUrl = (url: string): PlatformAdapter | null =>
  platformAdapters.find((platform) => platform.matchUrl(url)) || null;

export const resolvePlatformLink = (url: string): ResolvedPlatformLink | null => {
  const platform = findPlatformByUrl(url);

  if (!platform) {
    return null;
  }

  try {
    const normalizedUrl = platform.normalizeUrl(url);

    return {
      platform,
      normalizedUrl,
      skuId: platform.parseSkuId(normalizedUrl),
    };
  } catch {
    return null;
  }
};

export const isSupportedProductUrl = (url: string): boolean => Boolean(resolvePlatformLink(url));
