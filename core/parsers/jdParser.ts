import { collectJdImageUrlsFromText, createAssetItems, normalizeAssetUrl, uniqueAssetItems } from './assetUrl.js';
import { extractJdSkuId, normalizeJdProductUrl } from './jdUrl.js';
import type {
  AssetItem,
  JdHtmlSnapshot,
  JdParseOptions,
  JdSectionImageUrls,
  ProductAssets,
} from './types.js';

const TITLE_PATTERNS = [
  /<div[^>]+class=["'][^"']*sku-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  /<title[^>]*>([\s\S]*?)<\/title>/i,
];

const stripTags = (value: string): string =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeTitle = (title: string, skuId: string): string => {
  const cleanedTitle = title
    .replace(/【.*?】/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\s*[-_]\s*京东(?:JD\.COM)?.*$/i, '')
    .replace(/\s*京东\s*JD\.COM\s*$/i, '')
    .replace(/\s*[-_]\s*京东.*$/i, '')
    .replace(/\s*京东$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleanedTitle || `京东商品_${skuId}`;
};

export const extractJdTitleFromHtml = (html: string, skuId: string, pageTitle?: string): string => {
  if (pageTitle && pageTitle.trim()) {
    return normalizeTitle(pageTitle, skuId);
  }

  for (const pattern of TITLE_PATTERNS) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return normalizeTitle(stripTags(match[1]), skuId);
    }
  }

  return `京东商品_${skuId}`;
};

const collectSectionHtml = (html: string, sectionPattern: RegExp): string => {
  const match = html.match(sectionPattern);
  return match?.[0] || '';
};

const collectSectionHtmls = (html: string, sectionPatterns: RegExp[]): string =>
  sectionPatterns.map((pattern) => collectSectionHtml(html, pattern)).filter(Boolean).join('\n');

const mergeUrls = (...urlGroups: Array<string[] | undefined>): string[] =>
  Array.from(new Set(urlGroups.flatMap((items) => items || [])));

// 将 DOM 直接收集的 URL 列表标准化（不走文本正则，直接对每个 URL 做规范化）
const normalizeUrlList = (urls: string[] | undefined): string[] =>
  Array.from(
    new Set(
      (urls || [])
        .map((url) => normalizeAssetUrl(url))
        .filter((url): url is string => Boolean(url)),
    ),
  );

const JD_SECURITY_RISK_PATTERNS = [
  /账号存在安全风险/,
  /暂无法在京东网页端使用/,
  /京东商城\s*APP/,
  /完成安全验证/,
  /安全风险/,
];

const assertNoJdSecurityRisk = async (page: import('playwright').Page): Promise<void> => {
  const pageText = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');

  if (JD_SECURITY_RISK_PATTERNS.some((pattern) => pattern.test(pageText))) {
    throw new Error(
      '京东提示账号存在安全风险，已停止本次解析。请先在京东商城 APP 完成安全验证，短时间内不要继续重复登录或批量下载。',
    );
  }
};

/**
 * Fetch detail HTML from JD description API.
 */
const fetchJdDescription = async (skuId: string, page: import('playwright').Page): Promise<string> => {
  try {
    const result = await page.evaluate(async (id: string) => {
      const url = `https://api.m.jd.com/description/channel?appid=item-v3&functionId=pc_description_channel&skuId=${id}&mainSkuId=${id}&charset=utf-8&cdn=2`;
      const response = await fetch(url, { credentials: 'include' });
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        if (json.data) {
          if (typeof json.data === 'string') return json.data;
          if (typeof json.data.html === 'string') return json.data.html;
          if (typeof json.data.content === 'string') return json.data.content;
          if (typeof json.data.data?.html === 'string') return json.data.data.html;
        }
      } catch { /* not JSON, return raw text */ }
      return text;
    }, skuId);
    return result || '';
  } catch {
    return '';
  }
};

export const parseJdAssetsFromSnapshot = (snapshot: JdHtmlSnapshot, descriptionHtml?: string): ProductAssets => {
  const skuId = extractJdSkuId(snapshot.sourceUrl);

  if (!skuId) {
    throw new Error(`无法从链接中识别京东 SKU ID: ${snapshot.sourceUrl}`);
  }

  const sourceUrl = normalizeJdProductUrl(snapshot.sourceUrl);
  const html = snapshot.html;
  const title = extractJdTitleFromHtml(html, skuId, snapshot.pageTitle);

  const mainHtml = collectSectionHtml(
    html,
    /<div[^>]+id=["']spec-list["'][\s\S]*?(?:<\/div>\s*){1,6}/i,
  );
  const detailHtmlFromDom = collectSectionHtmls(html, [
    /<div[^>]+id=["']J-detail-content["'][\s\S]*?(?:<\/div>\s*){1,12}/i,
    /<div[^>]+id=["']detail-main["'][\s\S]*?(?:<\/div>\s*){1,80}/i,
    /<div[^>]+class=["'][^"']*ssd-module-wrap[^"']*["'][\s\S]*?(?:<\/div>\s*){1,80}/i,
  ]);
  // Prefer API-fetched detail HTML over DOM (new JD SPA pages)
  const detailHtml = descriptionHtml && descriptionHtml.length > detailHtmlFromDom.length
    ? descriptionHtml
    : detailHtmlFromDom;
  const skuHtml = collectSectionHtml(
    html,
    /<div[^>]+id=["']choose-attrs["'][\s\S]*?(?:<\/div>\s*){1,12}/i,
  );

  const networkText = snapshot.networkTexts?.join('\n') || '';
  const mainUrls = mergeUrls(normalizeUrlList(snapshot.sectionImageUrls?.main), collectJdImageUrlsFromText(mainHtml));
  const detailUrls = mergeUrls(
    normalizeUrlList(snapshot.sectionImageUrls?.detail),
    collectJdImageUrlsFromText(detailHtml),
  );
  const skuUrls = mergeUrls(normalizeUrlList(snapshot.sectionImageUrls?.sku), collectJdImageUrlsFromText(skuHtml));
  const knownUrls = new Set([...mainUrls, ...detailUrls, ...skuUrls]);
  const fallbackUrls = collectJdImageUrlsFromText(`${html}\n${networkText}`).filter(
    (url) => !knownUrls.has(url),
  );
  const fallbackMainUrls = fallbackUrls.filter((url) => /\/pcpubliccms\//i.test(url)).slice(0, 10);
  const unknownUrls = fallbackUrls.filter((url) => !/\/pcpubliccms\//i.test(url));

  const rawMain = mergeUrls(mainUrls, fallbackMainUrls);
  const cappedMain = rawMain.length > 15 ? rawMain.slice(0, 15) : rawMain;

  const rawDetail = detailUrls;
  const fallbackDetailUrls = collectJdImageUrlsFromText(detailHtml).filter(
    (url) => !rawDetail.includes(url) && /\/(?:n\d+|sku|imgzone|img|cms)\/jfs\//i.test(url),
  ).slice(0, 100);
  const cappedDetail = mergeUrls(rawDetail, fallbackDetailUrls).slice(0, 200);

  const images = {
    main: uniqueAssetItems(createAssetItems(cappedMain, 'main', sourceUrl, 'dom')),
    detail: uniqueAssetItems(createAssetItems(cappedDetail, 'detail', sourceUrl, 'dom')),
    sku: uniqueAssetItems(createAssetItems(skuUrls, 'sku', sourceUrl, 'dom')),
    unknown: uniqueAssetItems(createAssetItems(unknownUrls, 'unknown', sourceUrl, 'script')),
  };

  return {
    platform: 'jd',
    skuId,
    title,
    sourceUrl,
    images,
    debug: {
      pageTitle: snapshot.pageTitle,
      collectedAt: new Date().toISOString(),
      warnings: buildWarnings(images),
    },
  };
};

const collectImageUrlsFromPage = async (
  page: import('playwright').Page,
): Promise<JdSectionImageUrls> => {
  return page.evaluate(() => {
    const collectFromSelectors = (selectors: string[]) => {
      const urls = new Set<string>();
      const add = (value: string | null) => {
        if (!value) {
          return;
        }

        value
          .split(',')
          .map((item) => item.trim().split(/\s+/)[0])
          .filter(Boolean)
          .forEach((url) => urls.add(url));
      };

      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((node) => {
          if (node instanceof HTMLImageElement || node instanceof HTMLSourceElement) {
            add(node.getAttribute('src'));
            add(node.getAttribute('data-src'));
            add(node.getAttribute('data-lazy-img'));
            add(node.getAttribute('data-original'));
            add(node.getAttribute('data-img'));
            add(node.getAttribute('srcset'));
          }

          add(node.getAttribute('data-url'));
          add(node.getAttribute('data-img'));

          const style = [
            node.getAttribute('style') || '',
            window.getComputedStyle(node).backgroundImage || '',
          ].join('\n');
          const styleUrls = style.match(/url\(["']?([^"')]+)["']?\)/g) || [];

          styleUrls.forEach((item) =>
            add(item.replace(/^url\(["']?/, '').replace(/["']?\)$/, '')),
          );
        });
      }

      return Array.from(urls);
    };

    return {
      main: collectFromSelectors([
        '#spec-list img',
        '#preview img',
        '#spec-n1 img',
        '#spec-img',
        '.image-carousel img.image',
        '.image-carouse img.image',
      ]),
      detail: collectFromSelectors([
        '#J-detail-content img',
        '#J-detail-content div',
        '#J-detail-content [style*="background-image"]',
        '#detail img',
        '#detail [style*="background-image"]',
        '#detail-main img',
        '#detail-top img',
        '#detail-footer img',
        '#related-layout-head img',
        '#related-layout-footer img',
        '.detail-content img',
        '.detail-content [style*="background-image"]',
        '.graphicContent img',
        '.graphicContent [style*="background-image"]',
        '.ssd-module-wrap img',
        '.ssd-module img',
        '.ssd-module',
        '.detail-content-img',
        '[class*="detail_img"]',
      ]),
      sku: collectFromSelectors([
        '#choose-attrs img',
        '.choose-attrs img',
        '.choose-attr img',
        '.specification-item-sku-image',
        '[id^="choose-attr"] img',
      ]),
    };
  });
};

const openJdDetailTab = async (page: import('playwright').Page): Promise<void> => {
  const waitForDetailImages = async () => {
    await page
      .waitForSelector(
        '#J-detail-content img, #detail-main img, #detail-top img, #detail-footer img, .graphicContent img, .ssd-module-wrap, .ssd-module',
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  };

  const detailTabById = page.locator('#SPXQ-tab-column').first();

  if ((await detailTabById.count()) > 0) {
    await detailTabById.click({ timeout: 3_000 }).catch(() => undefined);
    await waitForDetailImages();
    return;
  }

  const detailTabByText = page.getByText('商品详情', { exact: true }).first();

  if ((await detailTabByText.count()) > 0) {
    await detailTabByText.click({ timeout: 3_000 }).catch(() => undefined);
  }

  await waitForDetailImages();
};

const autoScrollPage = async (page: import('playwright').Page): Promise<void> => {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let lastHeight = 0;
      let stableTicks = 0;
      const timer = window.setInterval(() => {
        window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.8)));
        const currentHeight = document.body.scrollHeight;

        if (currentHeight === lastHeight) {
          stableTicks += 1;
        } else {
          stableTicks = 0;
          lastHeight = currentHeight;
        }

        if (window.scrollY + window.innerHeight >= currentHeight - 8 && stableTicks >= 2) {
          window.clearInterval(timer);
          resolve();
        }
      }, 350);
    });
  });
};

const buildWarnings = (images: ProductAssets['images']): string[] => {
  const warnings: string[] = [];

  if (images.main.length === 0) {
    warnings.push('未解析到主图');
  }

  if (images.detail.length === 0) {
    warnings.push('未解析到详情图');
  }

  if (images.sku.length === 0) {
    warnings.push('未解析到 SKU 图');
  }

  return warnings;
};

export const parseJdProductAssets = async (
  productUrl: string,
  options: JdParseOptions = {},
): Promise<ProductAssets> => {
  const sourceUrl = normalizeJdProductUrl(productUrl);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    executablePath: options.browserExecutablePath,
    headless: options.headless ?? true,
  });

  const networkTexts: string[] = [];

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    if (options.cookies?.length) {
      await context.addCookies(
        options.cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        })),
      );
    }

    const page = await context.newPage();

    page.on('response', async (response) => {
      const contentType = response.headers()['content-type'] || '';

      if (!/(json|javascript|html|text)/i.test(contentType)) {
        return;
      }

      try {
        const text = await response.text();

        if (text.includes('360buyimg.com')) {
          networkTexts.push(text.slice(0, 200_000));
        }
      } catch {
        // 网络响应可能被浏览器占用或不是文本，忽略即可。
      }
    });

    await page.goto(sourceUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs ?? 30_000,
    });
    await assertNoJdSecurityRisk(page);
    await page.waitForLoadState('networkidle', {
      timeout: options.timeoutMs ?? 30_000,
    });
    await assertNoJdSecurityRisk(page);
    await autoScrollPage(page);
    await openJdDetailTab(page);
    await autoScrollPage(page);
    await page.waitForTimeout(800);
    const sectionImageUrls = await collectImageUrlsFromPage(page);

    // Fetch detail content from JD API for SPA pages
    const skuId = extractJdSkuId(sourceUrl);
    const descriptionHtml = skuId ? await fetchJdDescription(skuId, page) : undefined;

    return parseJdAssetsFromSnapshot(
      {
        sourceUrl,
        html: await page.content(),
        pageTitle: await page.title(),
        networkTexts,
        sectionImageUrls,
      },
      descriptionHtml,
    );
  } finally {
    await browser.close();
  }
};

export const summarizeProductAssets = (assets: ProductAssets) => ({
  platform: assets.platform,
  skuId: assets.skuId,
  title: assets.title,
  sourceUrl: assets.sourceUrl,
  counts: {
    main: assets.images.main.length,
    detail: assets.images.detail.length,
    sku: assets.images.sku.length,
    unknown: assets.images.unknown.length,
    total: Object.values(assets.images).reduce(
      (total, items: AssetItem[]) => total + items.length,
      0,
    ),
  },
  warnings: assets.debug.warnings,
});
