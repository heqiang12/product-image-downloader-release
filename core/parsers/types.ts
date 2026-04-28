export type AssetType = 'main' | 'detail' | 'sku' | 'unknown';

export interface AssetItem {
  url: string;
  type: AssetType;
  filename?: string;
  referer?: string;
  source?: 'dom' | 'script' | 'network';
}

export interface ProductAssets {
  platform: 'jd';
  skuId: string;
  title: string;
  sourceUrl: string;
  images: {
    main: AssetItem[];
    detail: AssetItem[];
    sku: AssetItem[];
    unknown: AssetItem[];
  };
  debug: {
    pageTitle?: string;
    collectedAt: string;
    warnings: string[];
  };
}

export interface JdSectionImageUrls {
  main?: string[];
  detail?: string[];
  sku?: string[];
}

export interface JdParseOptions {
  timeoutMs?: number;
  browserExecutablePath?: string;
  headless?: boolean;
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
}

export interface JdHtmlSnapshot {
  sourceUrl: string;
  html: string;
  pageTitle?: string;
  networkTexts?: string[];
  sectionImageUrls?: JdSectionImageUrls;
}
