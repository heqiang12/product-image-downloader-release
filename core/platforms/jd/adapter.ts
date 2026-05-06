import { parseJdProductAssets } from '../../parsers/jdParser.js';
import { extractJdSkuId, isJdProductUrl, normalizeJdProductUrl } from '../../parsers/jdUrl.js';
import type { PlatformAdapter } from '../types.js';

export const jdPlatformAdapter: PlatformAdapter = {
  id: 'jd',
  name: '京东',
  loginUrl: 'https://passport.jd.com/new/login.aspx',
  homeUrl: 'https://www.jd.com/',
  authCookieNames: ['pt_key', 'pt_pin'],
  authCookieGroups: [
    ['pt_key', 'pt_pin'],
    ['thor', 'pin'],
    ['thor', 'unick'],
    ['TrackID', 'pin'],
    ['TrackID', 'unick'],
  ],
  matchUrl: isJdProductUrl,
  normalizeUrl: normalizeJdProductUrl,
  parseSkuId: extractJdSkuId,
  parseProductAssets: ({ sourceUrl, cookies }) => parseJdProductAssets(sourceUrl, { cookies }),
};
