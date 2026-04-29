import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
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

const DEFAULT_SELECTED_TYPES: AssetType[] = ['main', 'detail', 'sku'];
const VALID_ASSET_TYPES = new Set<AssetType>(['main', 'detail', 'sku', 'unknown']);
const DEFAULT_DOWNLOAD_POLICY: DownloadPolicy = {
  safeMode: true,
  imageConcurrency: 2,
  requestDelayMs: 800,
};

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
    outputRoot = path.join(app.getPath('downloads'), 'jd-image-downloader');
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

            const style = node.getAttribute('style') || '';
            const styleUrls = style.match(/url\\(["']?([^"')]+)["']?\\)/g) || [];
            styleUrls.forEach((item) => add(item.replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '')));
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
        try {
          const json = JSON.parse(text);
          if (json.data) {
            if (typeof json.data === 'string') return json.data;
            if (typeof json.data.html === 'string') return json.data.html;
            if (typeof json.data.content === 'string') return json.data.content;
            if (typeof json.data.data && typeof json.data.data.html === 'string') return json.data.data.html;
          }
        } catch (e) { /* not JSON */ }
        return text;
      } catch (e) {
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
    await withTimeout(parseWindow.loadURL(normalizedUrl), 30_000, '页面加载超时');
    await wait(2_000);
    await assertNoJdSecurityRiskInElectron(parseWindow);
    await autoScrollElectronPage(parseWindow);
    await openJdDetailTabInElectron(parseWindow);
    await autoScrollElectronPage(parseWindow);
    await wait(1_000);
    await assertNoJdSecurityRiskInElectron(parseWindow);

    const sectionImageUrls = await collectJdSectionImageUrlsInElectron(parseWindow);
    const [html, pageTitle] = await Promise.all([
      executeInPage<string>(parseWindow, 'document.documentElement.outerHTML'),
      executeInPage<string>(parseWindow, 'document.title'),
    ]);
    const skuId = extractJdSkuId(normalizedUrl);
    const descriptionHtml = skuId ? await fetchJdDescriptionInElectron(parseWindow, skuId) : undefined;

    return parseJdAssetsFromSnapshot({
      sourceUrl: normalizedUrl,
      html,
      pageTitle,
      sectionImageUrls,
    }, descriptionHtml);
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
    title: '京东图片批量下载工具',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  void window.loadFile(path.join(__dirname, '../../dist/index.html'));
};

ipcMain.handle('app:get-version', () => app.getVersion());

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

ipcMain.handle('import:export-template', async () => {
  const result = await dialog.showSaveDialog({
    title: '导出商品链接模板',
    defaultPath: path.join(app.getPath('desktop'), '商品链接导入模板.xlsx'),
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

  await writeExcelTemplate(result.filePath);
  return {
    ok: true,
    canceled: false,
    filePath: result.filePath,
  };
});

ipcMain.handle('task:list', () => taskQueue.listTasks());

ipcMain.handle('task:start', () => taskQueue.start());

ipcMain.handle('task:retry-failed', () => taskQueue.retryFailed());

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

  createMainWindow();

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
