import type { ProductAssets } from '../parsers/types.js';

export interface ParseContext {
  sourceUrl: string;
  profilePartition?: string;
  cookies?: PlatformCookie[];
}

export interface PlatformCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface PlatformAdapter {
  id: string;
  name: string;
  loginUrl?: string;
  authCookieNames?: string[];
  authCookieGroups?: string[][];
  matchUrl: (url: string) => boolean;
  normalizeUrl: (url: string) => string;
  parseSkuId: (url: string) => string | null;
  parseProductAssets: (context: ParseContext) => Promise<ProductAssets>;
}

export interface ResolvedPlatformLink {
  platform: PlatformAdapter;
  normalizedUrl: string;
  skuId: string | null;
}
