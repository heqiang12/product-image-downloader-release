import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { TaskQueue } from '../core/tasks/taskQueue';
import {
  isSupportedProductUrl,
  platformAdapters,
  resolvePlatformLink,
} from '../core/platforms/registry';
import { createProductTaskProcessor } from '../core/tasks/productTaskProcessor';
import { downloadProductAssets } from '../core/downloader/downloadManager';
import { AppStateStore } from '../core/storage/appStateStore';
import { AuthProfileManager } from '../core/auth/profileManager';
import { importExcelLinksFromFile, writeExcelTemplate } from '../core/importers/excelImporter';
import type { DownloadPolicy, DownloadTask, TaskMode } from '../core/tasks/types';
import type { PlatformCookie } from '../core/platforms/types';
import type { AssetType } from '../core/parsers/types';
import { parseJdAssetsFromSnapshot } from '../core/parsers/jdParser';
import { extractJdSkuId, normalizeJdProductUrl } from '../core/parsers/jdUrl';

let outputRoot = '';
let taskQueue: TaskQueue;
let appStateStore: AppStateStore;
let authProfileManager: AuthProfileManager;
let mainWindow: BrowserWindow | null = null;
let queueNotificationActive = false;
let lastPauseNotificationAt = 0;
let updateCheckStarted = false;

const DEFAULT_SELECTED_TYPES: AssetType[] = ['main', 'detail', 'sku'];
const VALID_ASSET_TYPES = new Set<AssetType>(['main', 'detail', 'sku', 'unknown']);
const DEFAULT_DOWNLOAD_POLICY: DownloadPolicy = {
  safeMode: true,
  imageConcurrency: 2,
  requestDelayMs: 800,
};
const APP_DISPLAY_NAME = '商品图片下载助手';
const APP_USER_MODEL_ID = 'com.product-image-downloader.app';

app.setName(APP_DISPLAY_NAME);

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

const normalizeSelectedTypes = (value: unknown): AssetType[] => {
  if (!Array.isArray(value)) {
    return [...DEFAULT_SELECTED_TYPES];
  }

  const selectedTypes = value.filter((item): item is AssetType => VALID_ASSET_TYPES.has(item));
  return selectedTypes.length ? selectedTypes : [...DEFAULT_SELECTED_TYPES];
};

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(numberValue)));
};

const normalizeDownloadPolicy = (value: unknown): DownloadPolicy => {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_DOWNLOAD_POLICY };
  }

  const candidate = value as Partial<DownloadPolicy>;
  const safeMode = candidate.safeMode !== false;

  if (safeMode) {
    return { ...DEFAULT_DOWNLOAD_POLICY };
  }

  return {
    safeMode: false,
    imageConcurrency: clampNumber(candidate.imageConcurrency, 1, 8, 5),
    requestDelayMs: clampNumber(candidate.requestDelayMs, 0, 5_000, 0),
  };
};

const normalizeTaskMode = (value: unknown): TaskMode =>
  value === 'parseOnly' ? 'parseOnly' : 'download';

const extractLinkCandidates = (rawInput: string): string[] => {
  const candidates = new Set<string>();
  const urlMatches = rawInput.match(/https?:\/\/[^\s]+/gi) || [];

  for (const url of urlMatches) {
    candidates.add(url.trim());
  }

  for (const line of rawInput.split(/\r?\n/)) {
    const value = line.trim();

    if (value) {
      candidates.add(value);
    }
  }

  const compactInput = rawInput.replace(/\s+/g, '');
  if (compactInput.startsWith('http')) {
    candidates.add(compactInput);
  }

  return Array.from(candidates);
};

const getOutputRoot = () => {
  if (!outputRoot) {
    outputRoot = path.join(app.getPath('downloads'), 'product-image-downloader');
  }

  return outputRoot;
};

const saveAppState = async (tasks = taskQueue?.listTasks() || []) => {
  if (!appStateStore) {
    return;
  }

  await appStateStore.save({
    outputRoot: getOutputRoot(),
    tasks,
    auth: authProfileManager?.toJSON() || [],
    updatedAt: Date.now(),
  });
};

const getTaskCounts = (tasks: DownloadTask[]) => ({
  total: tasks.length,
  pending: tasks.filter((task) => task.status === 'pending').length,
  running: tasks.filter((task) => task.status === 'parsing' || task.status === 'downloading').length,
  success: tasks.filter((task) => task.status === 'success').length,
  failed: tasks.filter((task) => task.status === 'failed').length,
});

const focusMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
};

const showSystemNotification = (title: string, body: string) => {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title,
    body,
  });

  notification.on('click', focusMainWindow);
  notification.show();
};

const showAppMessageBox = (options: Electron.MessageBoxOptions) =>
  mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);

const handleQueueChangeForNotifications = (tasks: DownloadTask[]) => {
  if (!queueNotificationActive) {
    return;
  }

  const counts = getTaskCounts(tasks);
  const queueFinished = counts.running === 0 && counts.pending === 0;

  if (!queueFinished) {
    return;
  }

  queueNotificationActive = false;

  const title = counts.failed > 0 ? '下载完成，有任务失败' : '图片下载完成';
  const body =
    counts.failed > 0
      ? `共 ${counts.total} 个任务，成功 ${counts.success} 个，失败 ${counts.failed} 个。`
      : `共 ${counts.success} 个任务已完成。`;

  showSystemNotification(title, body);
};

const showPauseNotification = (tasks: DownloadTask[]) => {
  const now = Date.now();
  if (now - lastPauseNotificationAt < 1_500) {
    return;
  }

  lastPauseNotificationAt = now;
  const counts = getTaskCounts(tasks);
  const pendingText =
    counts.pending > 0 ? `${counts.pending} 个未开始任务已暂停` : '没有未开始任务需要暂停';
  const runningText =
    counts.running > 0 ? `${counts.running} 个正在执行的任务会完成当前步骤后停止` : '当前没有正在执行的任务';

  showSystemNotification('队列已暂停', `${pendingText}，${runningText}。`);
};

const setupAutoUpdater = () => {
  if (updateCheckStarted || !app.isPackaged) {
    return;
  }

  updateCheckStarted = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    void showAppMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${info.version}`,
      detail: '是否现在下载更新？下载完成后可以立即安装并重启应用。',
      buttons: ['下载更新', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
    })
      .then(({ response }) => {
        if (response === 0) {
          void autoUpdater.downloadUpdate();
        }
      });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:download-progress', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    void showAppMessageBox({
      type: 'info',
      title: '更新已下载',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '是否立即安装？应用会自动关闭并启动安装程序。',
      buttons: ['立即安装', '稍后安装'],
      defaultId: 0,
      cancelId: 1,
    })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall(false, true);
        }
      });
  });

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    mainWindow?.webContents.send('update:error', message);
  });
};

const checkForUpdates = async () => {
  if (!app.isPackaged) {
    return {
      ok: false,
      skipped: true,
      message: '开发环境不检查更新。',
    };
  }

  setupAutoUpdater();

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

const refreshPlatformAuthStatus = async (platformId: string) => {
  const platform = platformAdapters.find((item) => item.id === platformId);

  if (!platform) {
    throw new Error(`未知平台: ${platformId}`);
  }

  const profileSession = session.fromPartition(authProfileManager.getPartition(platform.id));
  const cookies = await profileSession.cookies.get({});
  const status = authProfileManager.updateStatus(
    platform,
    cookies.map((cookie) => cookie.name),
  );

  await saveAppState();
  return status;
};

const mapCookieSameSite = (
  sameSite: string | undefined,
): PlatformCookie['sameSite'] | undefined => {
  if (sameSite === 'strict') {
    return 'Strict';
  }

  if (sameSite === 'lax') {
    return 'Lax';
  }

  if (sameSite === 'no_restriction') {
    return 'None';
  }

  return undefined;
};

const getPlatformCookies = async (platformId: string) => {
  const profileSession = session.fromPartition(authProfileManager.getPartition(platformId));
  const cookies = await profileSession.cookies.get({});

  return cookies
    .filter((cookie) => Boolean(cookie.domain))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain as string,
      path: cookie.path,
      expires: cookie.expirationDate,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: mapCookieSameSite(cookie.sameSite),
    }));
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = <T>(promise: Promise<T>, ms: number, errorMessage = '操作超时'): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMessage)), ms)),
  ]);
};

const executeInPage = <T>(window: BrowserWindow, code: string): Promise<T> =>
  window.webContents.executeJavaScript(code, true) as Promise<T>;

const assertNoJdSecurityRiskInElectron = async (window: BrowserWindow) => {
  const pageText = await executeInPage<string>(
    window,
    'document.body ? document.body.innerText.slice(0, 2000) : ""',
  ).catch(() => '');

  if (/账号存在安全风险|暂无法在京东网页端使用|京东商城\s*APP|完成安全验证|安全风险/.test(pageText)) {
    throw new Error(
      '京东提示账号存在安全风险，已停止本次解析。请先在京东商城 APP 完成安全验证，短时间内不要继续重复登录或批量下载。',
    );
  }
};

const autoScrollElectronPage = async (window: BrowserWindow) => {
  await executeInPage<void>(
    window,
    `new Promise((resolve) => {
      let lastHeight = 0;
      let stableTicks = 0;
      let maxTicks = 40;
      const timer = window.setInterval(() => {
        maxTicks--;
        window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.8)));
        const currentHeight = document.body.scrollHeight;

        if (currentHeight === lastHeight) {
          stableTicks += 1;
        } else {
          stableTicks = 0;
          lastHeight = currentHeight;
        }

        if ((window.scrollY + window.innerHeight >= currentHeight - 8 && stableTicks >= 2) || maxTicks <= 0) {
          window.clearInterval(timer);
          resolve();
        }
      }, 350);
    })`,
  ).catch(() => undefined);
};

const openJdDetailTabInElectron = async (window: BrowserWindow) => {
  await executeInPage<void>(
    window,
    `(() => {
      const byId = document.querySelector('#SPXQ-tab-column');
      if (byId instanceof HTMLElement) {
        byId.click();
        return;
      }

      const byText = Array.from(document.querySelectorAll('a, li, div, span, button'))
        .find((node) => node.textContent && node.textContent.trim() === '商品详情');

      if (byText instanceof HTMLElement) {
        byText.click();
      }
    })()`,
  ).catch(() => undefined);
  await wait(2_000);
};

const collectJdSectionImageUrlsInElectron = async (window: BrowserWindow) =>
  executeInPage<{
    main: string[];
    detail: string[];
    sku: string[];
  }>(
    window,
    `(() => {
      const collectFromSelectors = (selectors) => {
        const urls = new Set();
        const add = (value) => {
          if (!value) return;
          String(value)
            .split(',')
            .map((item) => item.trim().split(/\\s+/)[0])
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
            ].join('\\n');
            const styleUrls = style.match(/url\\(["']?([^"')]+)["']?\\)/g) || [];
            styleUrls.forEach((item) => add(item.replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '')));
          });
        }

        return Array.from(urls);
      };

      return {
        // ── 主图区（每种格式来源加注释，遇新格式追加） ──────────────────────────────────
        main: (() => {
          const mainUrls = new Set();
          const addUrl = (value) => {
            if (!value || typeof value !== 'string') return;
            const u = value.trim().split(',')[0].trim().split(/\s+/)[0];
            if (u) mainUrls.add(u);
          };

          // 策略1（格式C）：新版轮播 .image-carousel / .image-carouse
          // 来源：HTML 分析 + jd_image_spider.py 验证
          // 关键：跳过含 .thumbnails-play-icon 的 .item（视频封面项），对齐 Python 脚本逻辑
          document.querySelectorAll(
            '.image-carousel .item, .image-carouse .item'
          ).forEach(item => {
            if (item.querySelector('.thumbnails-play-icon')) return; // 跳过视频项
            const img = item.querySelector('img.image');
            if (img) addUrl(img.getAttribute('src'));
          });

          // 策略2（格式A）：经典 PC 端 #spec-list 缩略图列表
          // 只取 img.image，避免抓到列表内的 UI 图标
          document.querySelectorAll('#spec-list img.image').forEach(img => addUrl(img.getAttribute('src')));

          // 策略3（格式A/B）：主图展示区 #spec-img（点击缩略图后更新的大图）
          // 注意：只取 #spec-img 本身，不用 #spec-n1 img（太宽，会抓到 .arrow 等 UI 图标）
          const specImg = document.querySelector('#spec-img');
          if (specImg instanceof HTMLImageElement) addUrl(specImg.getAttribute('src'));

          // 策略4（格式A）：#preview 预览区（仅取 img.image，排除 UI 元素）
          document.querySelectorAll('#preview img.image').forEach(img => addUrl(img.getAttribute('src')));

          // ── 新主图格式在此处追加 ──────────────────────────────────────────────────

          return Array.from(mainUrls);
        })(),
        detail: (() => {
          const detailUrls = new Set();
          const addUrl = (value) => {
            if (!value) return;
            String(value).split(',').map(s => s.trim().split(/\\s+/)[0]).filter(Boolean).forEach(u => detailUrls.add(u));
          };
          const extractBg = (el) => {
            const bg = window.getComputedStyle(el).backgroundImage || '';
            const m = bg.match(/url\\([\"']?([^\"')]+)[\"']?\\)/);
            return m ? m[1] : '';
          };

          // ── 详情图策略1：SSD 模块背景图（格式D：SPA 渲染，背景图模式）───────────────
          // 来源：jd_image_spider.py 验证，适用于京东新版店铺装修/SPA 商品详情页
          const ssdModules = document.querySelectorAll(
            '#detail-main > div > div > div.ssd-module-wrap > div.ssd-module, ' +
            '.ssd-module-wrap > .ssd-module'
          );
          ssdModules.forEach(el => addUrl(extractBg(el)));

          // ── 详情图策略2：detail-main / J-detail-content 内 img（格式E）─────────────
          // 来源：jd_image_spider.py 验证，适用于传统 POP 商家和自营详情页
          // 注意：跳过含 .thumbnails-play-icon 的视频缩略图父容器
          const detailImgs = document.querySelectorAll(
            '#detail-main > div > div img, ' +
            '#J-detail-content img, ' +
            '#J-detail-content [style*="background-image"]'
          );
          detailImgs.forEach(el => {
            if (el instanceof HTMLImageElement) {
              // 跳过视频播放图标的容器内图片
              if (el.closest('.thumbnails-play-icon, .video-thumb, .J-video-img')) return;
              addUrl(el.getAttribute('src'));
              addUrl(el.getAttribute('data-src'));
              addUrl(el.getAttribute('data-lazy-img'));
              addUrl(el.getAttribute('data-original'));
            } else {
              const bg = el.getAttribute('style') || '';
              const m = bg.match(/url\\([\"']?([^\"')]+)[\"']?\\)/);
              if (m) addUrl(m[1]);
            }
          });

          // ── 详情图策略3：其他已知精确容器（格式F/G）──────────────────────────────────
          // .graphicContent：部分店铺自定义装修使用的图文容器
          // .detail-content：早期通用详情区 class
          // ── 新格式在此处追加（每种新格式请加来源注释和对应的商品链接示例）────────────
          [
            '.graphicContent img',
            '.detail-content img',
            '.detail-content [style*="background-image"]',
            '.detail-content-img',
          ].forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
              if (el instanceof HTMLImageElement) {
                addUrl(el.getAttribute('src'));
                addUrl(el.getAttribute('data-src'));
                addUrl(el.getAttribute('data-lazy-img'));
              } else {
                const bg = window.getComputedStyle(el).backgroundImage || '';
                const m = bg.match(/url\\([\"']?([^\"')]+)[\"']?\\)/);
                if (m) addUrl(m[1]);
              }
            });
          });

          return Array.from(detailUrls);
        })(),
        // ── SKU 选项图 ──────────────────────────────────────────────────────────────────
        sku: collectFromSelectors([
          '#choose-attrs img',              // 格式A/B/C：SKU 选择区（颜色/尺寸图）
          '.choose-attrs img',              // 格式变体
          '.choose-attr img',               // 格式变体
          '.specification-item-sku-image',  // 格式D：新版规格选择器
          '[id^="choose-attr"] img',        // 格式E：动态生成的 SKU 选项容器
        ]),
      };
    })()`,

  );

const fetchJdDescriptionInElectron = async (window: BrowserWindow, skuId: string) => {
  return executeInPage<string>(
    window,
    `(async () => {
      try {
        const url = 'https://api.m.jd.com/description/channel?appid=item-v3&functionId=pc_description_channel&skuId=${skuId}&mainSkuId=${skuId}&charset=utf-8&cdn=2';
        const response = await fetch(url, { credentials: 'include' });
        const text = await response.text();
        console.log('[JD DESC API] status:', response.status, 'length:', text.length, 'preview:', text.slice(0, 300));
        try {
          const json = JSON.parse(text);
          // 尝试多种已知的数据结构
          if (json.data) {
            if (typeof json.data === 'string') return json.data;
            if (typeof json.data.html === 'string') return json.data.html;
            if (typeof json.data.content === 'string') return json.data.content;
            if (json.data.data && typeof json.data.data.html === 'string') return json.data.data.html;
            if (json.data.data && typeof json.data.data === 'string') return json.data.data;
          }
          if (json.result) {
            if (typeof json.result === 'string') return json.result;
            if (typeof json.result.html === 'string') return json.result.html;
          }
          // 如果解析不到已知字段，打印详细结构帮助调试
          console.log('[JD DESC API] unknown json structure, keys:', Object.keys(json).join(', '));
        } catch { /* 不是 JSON，直接当 HTML 返回 */ }
        // 如果 text 包含 img 标签，说明本身就是 HTML
        if (text.includes('<img') || text.includes('url(')) return text;
        return '';
      } catch (e) {
        console.log('[JD DESC API] fetch error:', String(e));
        return '';
      }
    })()`
  ).catch(() => '');
};

const parseJdProductAssetsWithElectronSession = async (
  sourceUrl: string,
  profilePartition: string,
) => {
  const normalizedUrl = normalizeJdProductUrl(sourceUrl);
  const parseWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: profilePartition,
    },
  });

  try {
    try {
      await withTimeout(parseWindow.loadURL(normalizedUrl), 30_000, '页面加载超时');
    } catch (loadError: unknown) {
      const msg = loadError instanceof Error ? loadError.message : String(loadError);
      if (msg.includes('ERR_ABORTED')) {
        if (msg.includes('risk_handler') || msg.includes('cfe.m.jd.com')) {
          throw new Error('拦截到京东滑块验证！请点击左侧平台【登录】按钮，在弹出的窗口中浏览该商品完成验证，再重试此任务。');
        }
        // 对于其他的 ERR_ABORTED（通常是因为内部重定向或被追踪器拦截），可以选择忽略并尝试继续解析
      } else {
        throw loadError;
      }
    }
    await wait(2_000);
    await assertNoJdSecurityRiskInElectron(parseWindow);
    await autoScrollElectronPage(parseWindow);
    await openJdDetailTabInElectron(parseWindow);
    await autoScrollElectronPage(parseWindow);
    await wait(1_000);
    await assertNoJdSecurityRiskInElectron(parseWindow);

    const sectionImageUrls = await collectJdSectionImageUrlsInElectron(parseWindow);

    // === 调试日志（主进程终端） ===
    console.log('[DEBUG] sectionImageUrls.main count:', sectionImageUrls.main.length);
    console.log('[DEBUG] sectionImageUrls.detail count:', sectionImageUrls.detail.length);
    if (sectionImageUrls.detail.length > 0) {
      console.log('[DEBUG] detail[0]:', sectionImageUrls.detail[0]);
    } else {
      console.log('[DEBUG] detail is EMPTY - DOM selectors did not match any detail images');
    }

    const [html, pageTitle] = await Promise.all([
      executeInPage<string>(parseWindow, 'document.documentElement.outerHTML'),
      executeInPage<string>(parseWindow, 'document.title'),
    ]);
    const skuId = extractJdSkuId(normalizedUrl);
    const descriptionHtml = skuId ? await fetchJdDescriptionInElectron(parseWindow, skuId) : undefined;
    console.log('[DEBUG] descriptionHtml length:', descriptionHtml?.length ?? 0);
    if (descriptionHtml && descriptionHtml.length > 0) {
      console.log('[DEBUG] descriptionHtml preview:', descriptionHtml.slice(0, 200));
    } else {
      console.log('[DEBUG] descriptionHtml is EMPTY - API returned nothing useful');
    }

    const result = parseJdAssetsFromSnapshot({
      sourceUrl: normalizedUrl,
      html,
      pageTitle,
      sectionImageUrls,
    }, descriptionHtml);
    console.log('[DEBUG] parsed detail count:', result.images.detail.length, '| unknown count:', result.images.unknown.length);
    if (result.images.unknown.length > 0) {
      console.log('[DEBUG] unknown[0]:', result.images.unknown[0].url);
    }
    return result;
  } finally {
    parseWindow.destroy();
  }
};

const createTaskQueue = (initialTasks: DownloadTask[]) =>
  new TaskQueue({
    concurrency: 1,
    initialTasks,
    onChange: (tasks) => {
      void saveAppState(tasks);
      handleQueueChangeForNotifications(tasks);
    },
    processor: createProductTaskProcessor({
      getOutputRoot,
      parseProductAssets: async (task) => {
        const platformId = task.platform;
        if (!platformId) throw new Error('任务缺少 platformId');
        
        const platform = platformAdapters.find((p) => p.id === platformId);
        if (!platform) throw new Error(`不支持或未知的平台: ${platformId}`);

        switch (platformId) {
          case 'jd':
            return parseJdProductAssetsWithElectronSession(
              task.sourceUrl,
              authProfileManager.getPartition(platformId),
            );
          default:
            return platform.parseProductAssets({
              sourceUrl: task.sourceUrl,
              profilePartition: authProfileManager.getPartition(platformId),
              cookies: await getPlatformCookies(platformId),
            });
        }
      },
      downloadProductAssets: (product, options) =>
        downloadProductAssets(product, {
          ...options,
          concurrency: options.downloadPolicy?.imageConcurrency ?? DEFAULT_DOWNLOAD_POLICY.imageConcurrency,
          retries: 2,
          timeoutMs: 30_000,
          requestDelayMs: options.downloadPolicy?.requestDelayMs ?? DEFAULT_DOWNLOAD_POLICY.requestDelayMs,
        }),
    }),
  });

const createMainWindow = () => {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: APP_DISPLAY_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = window;

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: 'detach' });
    return window;
  }

  void window.loadFile(path.join(__dirname, '../../dist/index.html'));
  return window;
};

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:check-updates', () => checkForUpdates());

ipcMain.handle('settings:get-output-root', () => getOutputRoot());

ipcMain.handle('settings:select-output-root', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择图片保存目录',
    defaultPath: getOutputRoot(),
    properties: ['openDirectory', 'createDirectory'],
  });

  if (!result.canceled && result.filePaths[0]) {
    outputRoot = result.filePaths[0];
    await saveAppState();
  }

  return getOutputRoot();
});

ipcMain.handle('auth:list-platforms', () => authProfileManager.listStatuses(platformAdapters));

ipcMain.handle('auth:refresh-status', async (_event, platformId: string) => {
  await refreshPlatformAuthStatus(platformId);
  return authProfileManager.listStatuses(platformAdapters);
});

ipcMain.handle('auth:login', async (_event, platformId: string) => {
  const platform = platformAdapters.find((item) => item.id === platformId);

  if (!platform?.loginUrl) {
    return {
      ok: false,
      errorMessage: `平台不支持登录: ${platformId}`,
    };
  }

  const loginWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    title: `${platform.name} 登录`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: authProfileManager.getPartition(platform.id),
    },
  });

  loginWindow.on('closed', () => {
    void refreshPlatformAuthStatus(platform.id);
  });

  await loginWindow.loadURL(platform.loginUrl);
  return {
    ok: true,
  };
});

ipcMain.handle('auth:clear', async (_event, platformId: string) => {
  const platform = platformAdapters.find((item) => item.id === platformId);

  if (!platform) {
    return {
      ok: false,
      errorMessage: `未知平台: ${platformId}`,
    };
  }

  const profileSession = session.fromPartition(authProfileManager.getPartition(platform.id));
  await profileSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'cachestorage', 'indexdb'],
  });
  authProfileManager.clearStatus(platform.id);
  await saveAppState();

  return {
    ok: true,
  };
});

ipcMain.handle('task:validate-links', (_event, platformId: string, rawInput: string) => {
  const platform = platformAdapters.find((p) => p.id === platformId);
  const links = extractLinkCandidates(rawInput);

  return {
    total: links.length,
    validLinks: platform ? links.filter((link) => platform.matchUrl(link)) : [],
  };
});

ipcMain.handle(
  'task:add-links',
  (
    _event,
    platformId: string,
    rawInput: string,
    selectedTypesInput?: unknown,
    downloadPolicyInput?: unknown,
    modeInput?: unknown,
  ) => {
  const platform = platformAdapters.find((p) => p.id === platformId);
  if (!platform) throw new Error(`Platform ${platformId} not found`);

  const links = extractLinkCandidates(rawInput).filter((item) => platform.matchUrl(item));

  return taskQueue.addTasks(
    platformId,
    links,
    normalizeSelectedTypes(selectedTypesInput),
    normalizeDownloadPolicy(downloadPolicyInput),
    normalizeTaskMode(modeInput),
  );
  },
);

ipcMain.handle(
  'import:excel-links',
  async (
    _event,
    platformId: string,
    selectedTypesInput?: unknown,
    downloadPolicyInput?: unknown,
    modeInput?: unknown,
  ) => {
  const result = await dialog.showOpenDialog({
    title: '导入商品链接 Excel',
    filters: [
      {
        name: 'Excel 文件',
        extensions: ['xlsx', 'xls'],
      },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      canceled: true,
      totalRows: 0,
      addedCount: 0,
      invalidRows: [],
      tasks: taskQueue.listTasks(),
    };
  }

  const importResult = await importExcelLinksFromFile(result.filePaths[0], platformId);
  const addedTasks = taskQueue.addTasks(
    platformId,
    importResult.validLinks.map((item) => item.url),
    normalizeSelectedTypes(selectedTypesInput),
    normalizeDownloadPolicy(downloadPolicyInput),
    normalizeTaskMode(modeInput),
  );

  return {
    canceled: false,
    totalRows: importResult.totalRows,
    addedCount: addedTasks.length,
    invalidRows: importResult.invalidRows,
    tasks: taskQueue.listTasks(),
  };
  },
);

ipcMain.handle('import:export-template', async (_event, platformId: string) => {
  const result = await dialog.showSaveDialog({
    title: '导出商品链接模板',
    defaultPath: path.join(app.getPath('desktop'), `商品链接导入模板_${platformId}.xlsx`),
    filters: [
      {
        name: 'Excel 文件',
        extensions: ['xlsx'],
      },
    ],
  });

  if (result.canceled || !result.filePath) {
    return {
      ok: false,
      canceled: true,
    };
  }

  await writeExcelTemplate(result.filePath, platformId);
  return {
    ok: true,
    canceled: false,
    filePath: result.filePath,
  };
});

ipcMain.handle('task:list', () => taskQueue.listTasks());

ipcMain.handle('task:start', () => {
  queueNotificationActive = true;
  return taskQueue.start();
});

ipcMain.handle('task:pause', () => {
  const tasks = taskQueue.pause();
  showPauseNotification(tasks);
  return tasks;
});

ipcMain.handle('task:retry-failed', () => {
  queueNotificationActive = true;
  return taskQueue.retryFailed();
});

ipcMain.handle('task:clear-completed', () => taskQueue.clearCompleted());

ipcMain.handle('task:clear-failed', () => taskQueue.clearFailed());

ipcMain.handle('task:remove', (_event, taskId: string) => taskQueue.removeTask(taskId));

ipcMain.handle('task:open-output', async (_event, taskId: string) => {
  const task = taskQueue.getTask(taskId);

  if (!task?.outputDir) {
    return { ok: false, errorMessage: '任务还没有输出目录' };
  }

  const errorMessage = await shell.openPath(task.outputDir);
  return {
    ok: !errorMessage,
    errorMessage: errorMessage || undefined,
  };
});

app.whenReady().then(async () => {
  appStateStore = new AppStateStore(path.join(app.getPath('userData'), 'app-state.json'));
  const savedState = await appStateStore.load();
  outputRoot = savedState.outputRoot;
  authProfileManager = new AuthProfileManager(savedState.auth);
  taskQueue = createTaskQueue(savedState.tasks);

  mainWindow = createMainWindow();
  setupAutoUpdater();
  setTimeout(() => {
    void checkForUpdates();
  }, 3_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
