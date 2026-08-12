import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  compareVersions,
  downloadFile,
  GITLAB_UPDATE_CONFIG,
  getLatestReleaseInfo,
} from '../core/updater/gitlabUpdater';
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
import type { TaskFailureKind } from '../core/tasks/types';
import { DEFAULT_DOWNLOAD_POLICY, RISK_PACE_PRESETS } from '../core/tasks/downloadPolicy';
import type { RiskPaceLevel } from '../core/tasks/types';

// ── 错误分类：用于标记任务失败原因，安全类错误触发一次即暂停 ──
class JdSecurityRiskError extends Error {
  readonly failureKind: TaskFailureKind = 'securityRisk';
}

class JdCaptchaRequiredError extends Error {
  readonly failureKind: TaskFailureKind = 'captcha';
}

class JdAuthExpiredError extends Error {
  readonly failureKind: TaskFailureKind = 'authExpired';
}

let outputRoot = '';
let taskQueue: TaskQueue;
let appStateStore: AppStateStore;
let authProfileManager: AuthProfileManager;
let mainWindow: BrowserWindow | null = null;
let queueNotificationActive = false;
let lastPauseNotificationAt = 0;
let lastSecurityRiskNotificationAt = 0;

const DEFAULT_SELECTED_TYPES: AssetType[] = ['main', 'detail', 'sku'];
const VALID_ASSET_TYPES = new Set<AssetType>([
  'main',
  'detail',
  'sku',
  'unknown',
  'currentPrice',
  'originalPrice',
]);
const APP_DISPLAY_NAME = '商品图片下载助手';
const APP_USER_MODEL_ID = 'com.product-image-downloader.app';

// 反自动化检测：禁用 Chromium 的 AutomationControlled 标志
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

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
    const paceLevels: RiskPaceLevel[] = ['fast', 'standard', 'conservative'];
    const pace = paceLevels.includes(candidate.riskPaceLevel as RiskPaceLevel)
      ? (candidate.riskPaceLevel as RiskPaceLevel)
      : 'standard';
    return { ...RISK_PACE_PRESETS[pace] };
  }

  // 自定义模式：每个字段独立校验，不合法时使用宽松的默认值
  return {
    safeMode: false,
    imageConcurrency: clampNumber(candidate.imageConcurrency, 1, 8, 5),
    requestDelayMs: clampNumber(candidate.requestDelayMs, 0, 5_000, 0),
    taskCooldownMin: clampNumber(candidate.taskCooldownMin, 1, 300, 5),
    taskCooldownMax: clampNumber(candidate.taskCooldownMax, 1, 600, 15),
    browsePauseMin: clampNumber(candidate.browsePauseMin, 1, 600, 15),
    browsePauseMax: clampNumber(candidate.browsePauseMax, 1, 1200, 45),
    browseInterval: clampNumber(candidate.browseInterval, 1, 100, 10),
    enablePrewarm: candidate.enablePrewarm === true,
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

const showSecurityRiskNotification = () => {
  const now = Date.now();
  // 同类通知 3 秒内只发一次（防抖）
  if (now - lastSecurityRiskNotificationAt < 3_000) {
    return;
  }

  lastSecurityRiskNotificationAt = now;
  showSystemNotification(
    '京东需要手动验证',
    '队列已暂停，请打开验证页面完成京东安全验证后重试。',
  );
};

/** 打开手动验证窗口，供 IPC handler 和弹窗按钮共用 */
const openManualVerifyWindow = async (platformId: string, taskId?: string): Promise<{ ok: boolean; errorMessage?: string }> => {
  const task = taskId ? taskQueue.getTask(taskId) : undefined;
  const platform = platformAdapters.find((item) => item.id === platformId);
  const targetUrl = task?.sourceUrl || platform?.homeUrl || platform?.loginUrl;

  if (!targetUrl) {
    return { ok: false, errorMessage: '无法确定验证页面地址' };
  }

  const verifyWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: '京东手动验证',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: authProfileManager.getPartition(platformId),
    },
  });

  injectStealthScripts(verifyWindow);
  await verifyWindow.loadURL(targetUrl);

  return { ok: true };
};

/** 安全风控强提示：系统通知 + 应用弹窗 */
const showSecurityRiskAlert = async (task?: DownloadTask) => {
  showSecurityRiskNotification();

  const result = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    title: '京东需要手动验证',
    message: '京东需要手动验证',
    detail: '京东返回安全验证或账号风险页面，队列已暂停。请打开验证页面手动完成验证或正常浏览当前商品，完成后回到应用重试失败任务。',
    buttons: ['打开验证页面', '稍后处理'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (result.response === 0) {
    const platformId = task?.platform || 'jd';
    const taskId = task?.id;
    await openManualVerifyWindow(platformId, taskId);
  }
};

// ── 更新检测：基于 GitLab Releases（核心逻辑在 core/updater/gitlabUpdater.ts）──
// electron-updater 官方 GitLabProvider 写死 https 且依赖 GitLab 14.3+ 接口，
// 自建 GitLab 13.8 + http 不可用，故自研。本文件只负责 Electron 侧的弹窗与静默安装。

const installUpdateSilently = (installerPath: string) => {
  // NSIS 安装包支持 /S 静默安装，装完自动启动新版本；当前进程退出让位。
  const child = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore' });
  child.unref();
  app.quit();
};

const checkForUpdates = async () => {
  if (!app.isPackaged) {
    return {
      ok: false,
      skipped: true,
      message: '开发环境不检查更新。',
    };
  }

  try {
    const { version: latestVersion, installerUrl } = await getLatestReleaseInfo();
    const currentVersion = app.getVersion();
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return { ok: true, upToDate: true };
    }

    const { response } = await showAppMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${latestVersion}，当前版本 ${currentVersion}`,
      detail: '是否现在下载更新？下载完成后会自动安装并重启应用。',
      buttons: ['下载更新', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      return { ok: true, skipped: true };
    }

    const target = path.join(app.getPath('temp'), `product-image-downloader-setup-${latestVersion}.exe`);
    await downloadFile(installerUrl, target, (received, total) => {
      if (total > 0) {
        mainWindow?.webContents.send('update:download-progress', {
          percent: Math.round((received / total) * 100),
          transferred: received,
          total,
        });
      }
    }, GITLAB_UPDATE_CONFIG.token);
    installUpdateSilently(target);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mainWindow?.webContents.send('update:error', message);
    return { ok: false, message };
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

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const randomWait = (minMs: number, maxMs: number) =>
  wait(minMs + Math.random() * (maxMs - minMs));

// 对数正态分布等待：大部分值在均值附近，偶尔出现较长停顿，更符合真人行为
const logNormalWait = (meanMs: number, sigma = 0.5): Promise<void> => {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const factor = Math.exp(sigma * z);
  const ms = Math.max(500, Math.round(meanMs * factor));
  return wait(ms);
};

// 对数正态分布随机数（不等待，只返回毫秒值）
const logNormalRandomMs = (meanMs: number, sigma = 0.5): number => {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const factor = Math.exp(sigma * z);
  return Math.max(500, Math.round(meanMs * factor));
};

// 反自动化检测：注入 stealth 脚本，覆盖常见自动化指纹检测点
const injectStealthScripts = (window: BrowserWindow): void => {
  window.webContents.on('dom-ready', () => {
    window.webContents.executeJavaScript(`
      (() => {
        // 移除 webdriver 标志
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        // 伪造 navigator.plugins
        if (navigator.plugins.length === 0) {
          Object.defineProperty(navigator, 'plugins', {
            get: () => {
              const p = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
              ];
              p.length = 3;
              return p;
            },
          });
        }

        // 伪造 window.chrome 对象
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', {
            get: () => ({ runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} }),
          });
        }

        // 设置语言为中文
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });

        // ③ 鼠标移动模拟：周期性派发 mousemove 事件，避免页面检测到无鼠标行为
        if (!window.__stealthMouseStarted) {
          window.__stealthMouseStarted = true;
          let mx = 300 + Math.floor(Math.random() * 600);
          let my = 200 + Math.floor(Math.random() * 400);
          setInterval(function() {
            mx = Math.max(10, Math.min(window.innerWidth - 10,  mx + (Math.random() - 0.5) * 180));
            my = Math.max(10, Math.min(window.innerHeight - 10, my + (Math.random() - 0.5) * 120));
            document.dispatchEvent(new MouseEvent('mousemove', {
              clientX: mx, clientY: my,
              screenX: mx + 120, screenY: my + 80,
              bubbles: true, cancelable: true,
            }));
          }, 1800 + Math.floor(Math.random() * 3200));
        }
      })();
    `).catch(() => {});
  });
};

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
    throw new JdSecurityRiskError(
      '京东提示账号存在安全风险，已停止本次解析。请先在京东商城 APP 完成安全验证，短时间内不要继续重复登录或批量下载。',
    );
  }
};

// ④ autoScrollElectronPage：变速滚动 + 随机停顿 + 偶尔回滚，模拟真人阅读式浏览
const autoScrollElectronPage = async (window: BrowserWindow) => {
  await executeInPage<void>(
    window,
    `(function() {
      return new Promise(function(resolve) {
        var lastHeight = 0;
        var stableTicks = 0;
        var maxTicks = 40;
        var stepsSincePause = 0;
        var pauseEvery = 2 + Math.floor(Math.random() * 4); // 每滚 2~5 步停一次
        function logNormalDelay(mean) {
          var u1 = Math.random() || 0.001;
          var u2 = Math.random();
          var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          return Math.max(800, Math.round(mean * Math.exp(0.5 * z)));
        }
        function step() {
          if (maxTicks <= 0) { resolve(); return; }
          maxTicks--;
          stepsSincePause++;
          // 10% 概率往回滚一小段（模拟"回头看"）
          if (Math.random() < 0.1 && document.documentElement.scrollTop > 300) {
            var backDist = 100 + Math.floor(Math.random() * 200);
            document.documentElement.scrollTop -= backDist;
            document.body.scrollTop -= backDist;
          }
          // 正常向下滚动，步长随机 300~900px
          var dist = 300 + Math.floor(Math.random() * 600);
          document.documentElement.scrollTop += dist;
          document.body.scrollTop += dist;
          var curH = document.body.scrollHeight;
          if (curH === lastHeight) { stableTicks++; } else { stableTicks = 0; lastHeight = curH; }
          var atBottom = (document.documentElement.scrollTop + document.documentElement.clientHeight >= curH - 10);
          if (atBottom && stableTicks >= 2) {
            // 到底后 50% 概率再往上滚一段（模拟回看）
            if (Math.random() < 0.5) {
              var upDist = 300 + Math.floor(Math.random() * 600);
              document.documentElement.scrollTop = Math.max(0, document.documentElement.scrollTop - upDist);
              document.body.scrollTop = document.documentElement.scrollTop;
              setTimeout(resolve, 1500 + Math.floor(Math.random() * 2000));
            } else {
              resolve();
            }
            return;
          }
          // 每滚 2~5 步后随机停顿 1.5~5 秒（模拟"在看内容"）
          if (stepsSincePause >= pauseEvery) {
            stepsSincePause = 0;
            pauseEvery = 2 + Math.floor(Math.random() * 4);
            var pauseMs = 1500 + Math.floor(Math.random() * 3500);
            setTimeout(function() { setTimeout(step, logNormalDelay(1500)); }, pauseMs);
          } else {
            setTimeout(step, logNormalDelay(1500));
          }
        }
        step();
      });
    })()`,
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

// 随机点击主图缩略图，模拟用户切换查看不同角度的商品图
const clickRandomMainImage = async (window: BrowserWindow) => {
  await executeInPage<void>(
    window,
    `(() => {
      const thumbs = document.querySelectorAll(
        '#spec-list li img, .image-carousel .item img, .image-carouse .item img, #preview img.image'
      );
      if (thumbs.length > 1) {
        const pick = thumbs[Math.floor(Math.random() * thumbs.length)];
        pick.click();
      }
    })()`,
  ).catch(() => undefined);
  await logNormalWait(2000);
};

// 点击评论 tab 停留一会儿再切回，模拟用户偶尔看评论
const clickCommentTab = async (window: BrowserWindow) => {
  await executeInPage<void>(
    window,
    `(() => {
      // 尝试多种评论 tab 选择器
      const selectors = [
        '#comment-tab-column',
        '[data-anchor="#comment"]',
        'a[href*="#comment"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el instanceof HTMLElement) { el.click(); return true; }
      }
      // 兜底：按文本匹配
      const byText = Array.from(document.querySelectorAll('a, li, div, span'))
        .find((node) => node.textContent && node.textContent.trim() === '评论');
      if (byText instanceof HTMLElement) { byText.click(); return true; }
      return false;
    })()`,
  ).catch(() => undefined);
  // 停留 2~5 秒再切回详情
  await logNormalWait(3000);
  await openJdDetailTabInElectron(window);
};

// 随机组合 3~6 个页面交互动作，使每个商品的浏览行为序列不同
const simulateRandomInteractions = async (window: BrowserWindow): Promise<void> => {
  type Action = { name: string; weight: number; run: () => Promise<void> };
  const actions: Action[] = [
    { name: '滚动浏览', weight: 40, run: () => autoScrollElectronPage(window) },
    { name: '点击主图', weight: 15, run: () => clickRandomMainImage(window) },
    { name: '详情tab', weight: 20, run: () => openJdDetailTabInElectron(window) },
    { name: '评论tab', weight: 10, run: () => clickCommentTab(window) },
    { name: '停留阅读', weight: 15, run: () => logNormalWait(3500) },
  ];
  const totalWeight = actions.reduce((s, a) => s + a.weight, 0);
  const pickAction = (): Action => {
    let r = Math.random() * totalWeight;
    for (const a of actions) { r -= a.weight; if (r <= 0) return a; }
    return actions[0];
  };

  const count = 3 + Math.floor(Math.random() * 4); // 3~6 个动作
  const executed: string[] = [];
  for (let i = 0; i < count; i++) {
    const action = pickAction();
    // 避免连续重复同一动作（除了滚动可以连续）
    if (executed.length > 0 && action.name === executed[executed.length - 1] && action.name !== '滚动浏览') {
      i--;
      continue;
    }
    console.log(`[交互] 动作${i + 1}/${count}: ${action.name}`);
    await action.run();
    executed.push(action.name);
    // 动作间短暂停顿
    await logNormalWait(1200);
  }
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

// ② 解析窗口复用管理器：避免每个任务创建/销毁 BrowserWindow
class ParseWindowManager {
  private win: BrowserWindow | null = null;
  private useCount = 0;
  private maxUses: number;
  private readonly partition: string;

  constructor(partition: string) {
    this.partition = partition;
    this.maxUses = 18 + Math.floor(Math.random() * 12);
  }

  async acquire(): Promise<BrowserWindow> {
    if (!this.win || this.win.isDestroyed() || this.useCount >= this.maxUses) {
      console.log(`[PARSE-WIN] ${this.win ? '回收旧窗口，已用' + this.useCount + '次' : '首次创建'}`);
      this.recycle();
      await wait(600);
    }
    this.useCount++;
    return this.win!;
  }

  // ⑦ 解析后释放窗口：导航到 about:blank 避免额外京东访问
  async release(): Promise<void> {
    if (!this.win || this.win.isDestroyed()) return;
    await this.win.loadURL('about:blank').catch(() => undefined);
    await randomWait(300, 800);
  }

  invalidate(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.useCount = 0;
  }

  private recycle(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    const VIEWPORTS = [
      { width: 1280, height: 800 }, { width: 1366, height: 768 },
      { width: 1440, height: 900 }, { width: 1536, height: 864 },
      { width: 1600, height: 900 }, { width: 1920, height: 1080 },
    ];
    const vp = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
    this.win = new BrowserWindow({
      width: vp.width, height: vp.height, show: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        partition: this.partition, backgroundThrottling: false,
      },
    });
    injectStealthScripts(this.win);
    this.useCount = 0;
    this.maxUses = 18 + Math.floor(Math.random() * 12);
    console.log(`[PARSE-WIN] 新窗口 ${vp.width}x${vp.height}，最多复用 ${this.maxUses} 次`);
  }
}

let parseWindowManager: ParseWindowManager | null = null;

// 轻量滚动：只滚动 1-2 次，短暂停留，用于按需补充详情图
const lightScrollElectronPage = async (window: BrowserWindow): Promise<void> => {
  const scrolls = 1 + Math.floor(Math.random() * 2); // 1~2 次
  await executeInPage<void>(
    window,
    `(function() {
      return new Promise(function(resolve) {
        var count = 0;
        var scrolls = ${scrolls};
        var timer = setInterval(function() {
          var distance = 400 + Math.floor(Math.random() * 400);
          document.documentElement.scrollTop += distance;
          document.body.scrollTop += distance;
          count++;
          if (count >= scrolls) {
            clearInterval(timer);
            resolve();
          }
        }, 800 + Math.floor(Math.random() * 600));
      });
    })()`,
  ).catch(() => undefined);
  await randomWait(1_500, 3_000);
};

// 判断采集结果是否足够：主图存在且详情图达到阈值
const hasEnoughImages = (sectionImageUrls: { main: string[]; detail: string[]; sku: string[] }) =>
  sectionImageUrls.main.length > 0 && sectionImageUrls.detail.length >= 3;

const parseJdProductAssetsWithElectronSession = async (
  sourceUrl: string,
  profilePartition: string,
  downloadPolicy?: DownloadPolicy,
) => {
  const normalizedUrl = normalizeJdProductUrl(sourceUrl);
  const enablePrewarm = downloadPolicy?.enablePrewarm ?? DEFAULT_DOWNLOAD_POLICY.enablePrewarm;

  if (!parseWindowManager) {
    parseWindowManager = new ParseWindowManager(profilePartition);
  }

  const parseWindow = await parseWindowManager.acquire();

  try {
    // ⑤ 多样化入口路径（25% 搜索词进入、40% 分类页、35% 直接导航）
    if (enablePrewarm) {
      const roll = Math.random();
      if (roll < 0.25) {
        // ⑧ 搜索词进入
        const kws = ['手机', '家电', '数码配件', '生活用品', '服装', '运动户外'];
        const kw = kws[Math.floor(Math.random() * kws.length)];
        console.log(`[PREWARM] 搜索进入: "${kw}"`);
        await parseWindow.loadURL(
          `https://search.jd.com/Search?keyword=${encodeURIComponent(kw)}&enc=utf-8`,
        ).catch(() => undefined);
        await randomWait(2_500, 5_000);
      } else if (roll < 0.65) {
        const pages = [
          'https://www.jd.com/',
          'https://channel.jd.com/electronic.html',
          'https://channel.jd.com/allasite.html',
          'https://sale.jd.com/',
        ];
        const pg = pages[Math.floor(Math.random() * pages.length)];
        console.log(`[PREWARM] 入口页预热: ${pg}`);
        await parseWindow.loadURL(pg).catch(() => undefined);
        await randomWait(2_000, 4_500);
      } else {
        console.log('[PREWARM] 直接导航（无预热）');
      }
    }

    try {
      await withTimeout(parseWindow.loadURL(normalizedUrl), 30_000, '页面加载超时');
    } catch (loadError: unknown) {
      const msg = loadError instanceof Error ? loadError.message : String(loadError);
      if (msg.includes('ERR_ABORTED')) {
        if (msg.includes('risk_handler') || msg.includes('cfe.m.jd.com')) {
          throw new JdCaptchaRequiredError('拦截到京东滑块验证！请点击左侧平台【登录】按钮，在弹出的窗口中浏览该商品完成验证，再重试此任务。');
        }
        // 对于其他的 ERR_ABORTED（通常是因为内部重定向或被追踪器拦截），可以选择忽略并尝试继续解析
      } else {
        throw loadError;
      }
    }
    // 等待首屏自然加载
    const isSafeMode = downloadPolicy?.safeMode !== false;
    const initialWaitMs = isSafeMode
      ? 6_000 + Math.floor(Math.random() * 6_000)   // 安全模式：6~12 秒
      : 3_000 + Math.floor(Math.random() * 3_000);   // 自定义模式：3~6 秒
    await logNormalWait(initialWaitMs);
    await assertNoJdSecurityRiskInElectron(parseWindow);

    // 第一次 DOM 采集：主图、SKU 图、已渲染详情图
    let sectionImageUrls = await collectJdSectionImageUrlsInElectron(parseWindow);
    const firstCollectDetailCount = sectionImageUrls.detail.length;
    console.log('[PARSE] 首次采集: main=%d, detail=%d, sku=%d',
      sectionImageUrls.main.length, sectionImageUrls.detail.length, sectionImageUrls.sku.length);

    // 判断采集结果是否足够，不足时按需补充动作
    if (!hasEnoughImages(sectionImageUrls)) {
      console.log('[PARSE] 详情图不足，执行补充动作');

      if (isSafeMode) {
        // 安全模式：轻量动作 — 点击详情 tab + 轻滚动，不做随机交互
        await openJdDetailTabInElectron(parseWindow);
        await lightScrollElectronPage(parseWindow);
      } else {
        // 自定义模式：使用完整随机交互
        const pageLoadDone = Date.now();
        const minDwellMs = logNormalRandomMs(18_000, 0.3);
        await simulateRandomInteractions(parseWindow);
        const elapsed = Date.now() - pageLoadDone;
        if (elapsed < minDwellMs) {
          const remainMs = minDwellMs - elapsed;
          console.log(`[交互] 补足停留时间: ${Math.round(remainMs / 1000)}s`);
          await logNormalWait(remainMs);
        }
      }

      await assertNoJdSecurityRiskInElectron(parseWindow);

      // 第二次 DOM 采集
      sectionImageUrls = await collectJdSectionImageUrlsInElectron(parseWindow);
      console.log('[PARSE] 二次采集: main=%d, detail=%d, sku=%d',
        sectionImageUrls.main.length, sectionImageUrls.detail.length, sectionImageUrls.sku.length);
    } else {
      // 采集足够，补足最低停留时间（安全模式 6~12s 已在 initialWaitMs 中覆盖）
      if (!isSafeMode) {
        await logNormalWait(logNormalRandomMs(8_000, 0.3));
      }
    }

    const skuId = extractJdSkuId(normalizedUrl);
    // 详情 API 按需调用：仅在 DOM 详情图不足时调用
    let descriptionHtml: string | undefined;
    const shouldFetchDesc =
      skuId &&
      sectionImageUrls.detail.length < 3 &&
      (!isSafeMode || Math.random() < 0.5);
    if (shouldFetchDesc) {
      console.log('[PARSE] 详情图仍不足，调用详情 API');
      await logNormalWait(2000);
      descriptionHtml = await fetchJdDescriptionInElectron(parseWindow, skuId!);
    } else if (skuId && sectionImageUrls.detail.length >= 3) {
      console.log('[PARSE] 详情图足够，跳过详情 API');
    }

    const [html, pageTitle] = await Promise.all([
      executeInPage<string>(parseWindow, 'document.documentElement.outerHTML'),
      executeInPage<string>(parseWindow, 'document.title'),
    ]);
    console.log('[DEBUG] pageTitle:', pageTitle);
    console.log('[DEBUG] html length:', html.length);
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
    console.log('[PARSE] 最终结果: main=%d, detail=%d, sku=%d, unknown=%d',
      result.images.main.length, result.images.detail.length,
      result.images.sku.length, result.images.unknown.length);
    console.log('[PARSE] 详情补图摘要: 首次DOM=%d, 二次DOM=%d, API调用=%s, 最终详情=%d',
      firstCollectDetailCount,
      sectionImageUrls.detail.length,
      shouldFetchDesc ? '是' : '否',
      result.images.detail.length);

    return result;
  } catch (err) {
    // 安全风险或频繁失败时，让窗口作废，下次重建
    parseWindowManager?.invalidate();
    throw err;
  } finally {
    // ⑦ 解析后导航到中性页，不直接关闭窗口
    await parseWindowManager?.release();
  }
};

const simulateJdBrowse = async (profilePartition: string, browsePauseMin: number, browsePauseMax: number): Promise<void> => {
  // ⑥ 超长休眠：3% 概率触发 5~15 分钟完全休眠，模拟用户暂时离开
  if (Math.random() < 0.03) {
    const longMs = 300_000 + Math.random() * 600_000;
    console.log(`[COOLDOWN] ⏳ 超长休眠 ${Math.round(longMs / 60_000)} 分钟（模拟用户离开）`);
    await wait(longMs);
    return;
  }

  // 60% 概率只是普通暂停休息
  if (Math.random() < 0.6) {
    const pauseMs = browsePauseMin * 1_000 + Math.random() * (browsePauseMax - browsePauseMin) * 1_000;
    console.log(`[COOLDOWN] 暂停休息 ${Math.round(pauseMs / 1000)}s（范围 ${browsePauseMin}~${browsePauseMax}s）`);
    await wait(pauseMs);
    return;
  }

  const browseWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: profilePartition,
      backgroundThrottling: false, // 禁止后台节流，确保 setInterval 正常运行
    },
  });

  injectStealthScripts(browseWindow);

  // 随机选择起始页面
  const entryPages = [
    'https://www.jd.com/',
    'https://channel.jd.com/allasite.html',
    'https://www.jd.com/chaoshi.html',
    'https://channel.jd.com/electronic.html',
  ];
  const startUrl = entryPages[Math.floor(Math.random() * entryPages.length)];
  console.log('[COOLDOWN] 模拟浏览开始:', startUrl);

  try {
    await browseWindow.loadURL(startUrl);
    await randomWait(3_000, 6_000);

    // 随机执行 5~10 轮浏览动作
    const rounds = 5 + Math.floor(Math.random() * 6);
    for (let i = 0; i < rounds; i++) {
      // 检查窗口是否已被销毁
      if (browseWindow.isDestroyed()) break;

      const action = Math.random();

      if (action < 0.4) {
        // 动作1：点击页面上的随机链接（商品/分类/轮播）
        const clicked = await executeInPage<boolean>(
          browseWindow,
          `(() => {
            const candidates = Array.from(document.querySelectorAll('a[href]'))
              .filter(a => {
                const href = a.href || '';
                return (href.includes('item.jd.com') || href.includes('channel.jd.com')
                  || href.includes('list.jd.com') || href.includes('cate.jd.com'))
                  && a.offsetParent !== null;
              });
            if (candidates.length === 0) return false;
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            pick.click();
            return true;
          })()`,
        ).catch(() => false);

        if (clicked) {
          console.log(`[COOLDOWN] 动作${i + 1}: 点击链接，等待页面加载`);
          await randomWait(4_000, 8_000);
        } else {
          await scrollRandom(browseWindow, i + 1);
        }
      } else if (action < 0.7) {
        // 动作2：滚动浏览
        await scrollRandom(browseWindow, i + 1);
      } else {
        // 动作3：模拟阅读停留
        const pauseMs = 3_000 + Math.random() * 6_000;
        console.log(`[COOLDOWN] 动作${i + 1}: 停留阅读 ${Math.round(pauseMs / 1000)}s`);
        await wait(pauseMs);
      }
    }

    console.log('[COOLDOWN] 模拟浏览完成');
  } catch (e) {
    console.log('[COOLDOWN] 模拟浏览出错（不影响主流程）:', String(e));
  } finally {
    if (!browseWindow.isDestroyed()) {
      browseWindow.destroy();
    }
  }
};

const scrollRandom = async (window: BrowserWindow, step: number): Promise<void> => {
  const scrolls = 4 + Math.floor(Math.random() * 6);
  const intervalMs = 600 + Math.floor(Math.random() * 600); // 600~1200ms 间隔
  console.log(`[COOLDOWN] 动作${step}: 滚动 ${scrolls} 次，间隔 ${intervalMs}ms`);
  await executeInPage<void>(
    window,
    `(function() {
      return new Promise(function(resolve) {
        var count = 0;
        var scrolls = ${scrolls};
        var timer = setInterval(function() {
          var distance = 200 + Math.floor(Math.random() * 500);
          document.documentElement.scrollTop += distance;
          document.body.scrollTop += distance;
          count++;
          if (count >= scrolls) {
            clearInterval(timer);
            resolve();
          }
        }, ${intervalMs});
      });
    })()`,
  ).catch(() => undefined);
  await randomWait(1_500, 3_000);
};

const createTaskQueue = (initialTasks: DownloadTask[]) => {
  // 记录最近一个正在执行任务的 Policy，供 TaskQueue 读取冷却参数
  let activePolicy: DownloadPolicy | undefined;

  return new TaskQueue({
    concurrency: 1,
    initialTasks,
    getActivePolicyFn: () => activePolicy,
    // 安全模式下改为纯休眠，不再打开京东页面模拟浏览
    onBrowseCooldown: async (browsePauseMin, browsePauseMax) => {
      const pauseMs = browsePauseMin * 1_000 + Math.random() * (browsePauseMax - browsePauseMin) * 1_000;
      console.log(`[COOLDOWN] 纯休眠 ${Math.round(pauseMs / 1000)}s（范围 ${browsePauseMin}~${browsePauseMax}s）`);
      await wait(pauseMs);
    },
    onSecurityRisk: (task) => {
      void showSecurityRiskAlert(task);
    },
    onAutoPaused: () => {
      void (async () => {
        const counts = getTaskCounts(taskQueue.listTasks());
        await dialog.showMessageBox(mainWindow!, {
          type: 'warning',
          title: '队列已自动暂停',
          message: '连续失败次数过多，队列已自动暂停',
          detail: `已连续失败 ${counts.failed} 个任务。请检查网络或登录状态后重试。`,
          buttons: ['重试失败任务', '稍后处理'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        }).then((result) => {
          if (result.response === 0) {
            taskQueue.retryFailed();
          }
        });
      })();
    },
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

        // 将当前任务的 Policy 暴露给 TaskQueue
        activePolicy = task.downloadPolicy;

        switch (platformId) {
          case 'jd':
            return parseJdProductAssetsWithElectronSession(
              task.sourceUrl,
              authProfileManager.getPartition(platformId),
              task.downloadPolicy,
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
};

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

  injectStealthScripts(loginWindow);

  loginWindow.on('closed', () => {
    void refreshPlatformAuthStatus(platform.id);
  });

  const status = await refreshPlatformAuthStatus(platform.id);
  const targetUrl = status.isLoggedIn ? platform.homeUrl || platform.loginUrl : platform.loginUrl;

  await loginWindow.loadURL(targetUrl);
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

ipcMain.handle('task:clear-pending', () => taskQueue.clearPending());

ipcMain.handle('task:queue-status', () => taskQueue.getQueueStatus());

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

ipcMain.handle('task:open-manual-verify', async (_event, platformId: string, taskId?: string) =>
  openManualVerifyWindow(platformId, taskId),
);

app.whenReady().then(async () => {
  appStateStore = new AppStateStore(path.join(app.getPath('userData'), 'app-state.json'));
  const savedState = await appStateStore.load();
  outputRoot = savedState.outputRoot;
  authProfileManager = new AuthProfileManager(savedState.auth);
  taskQueue = createTaskQueue(savedState.tasks);

  mainWindow = createMainWindow();
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
  parseWindowManager?.invalidate();
  parseWindowManager = null;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
