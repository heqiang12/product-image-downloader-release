import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthProfileManager } from '../core/auth/profileManager.js';
import { AppStateStore } from '../core/storage/appStateStore.js';
import { jdPlatformAdapter } from '../core/platforms/jd/adapter.js';

const rootDir = process.cwd();

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const run = (command: string, args: string[]) => {
  console.log(`\n> ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
};

const main = async () => {
  run('npm', ['run', 'build']);

  assert(jdPlatformAdapter.loginUrl?.includes('passport.jd.com'), '京东 adapter 缺少登录地址');
  assert(jdPlatformAdapter.authCookieNames?.includes('pt_key'), '京东 adapter 缺少登录 Cookie 标识');
  assert(
    jdPlatformAdapter.authCookieGroups?.some((group) => group.includes('thor') && group.includes('pin')),
    '京东 adapter 缺少网页端登录 Cookie 组合',
  );

  const profileManager = new AuthProfileManager();
  const initialStatus = profileManager.getStatus(jdPlatformAdapter);
  assert(!initialStatus.isLoggedIn, '初始登录状态应为未登录');
  assert(
    initialStatus.profilePartition === 'persist:jd-image-downloader-jd',
    '平台 Profile 分区命名错误',
  );

  const loggedInStatus = profileManager.updateStatus(jdPlatformAdapter, ['pt_key', 'pt_pin']);
  assert(loggedInStatus.isLoggedIn, '必要 Cookie 存在时应识别为已登录');
  assert(loggedInStatus.cookieCount === 2, 'Cookie 数量记录错误');

  const webLoginStatus = profileManager.updateStatus(jdPlatformAdapter, ['thor', 'pin']);
  assert(webLoginStatus.isLoggedIn, '网页端 Cookie 组合存在时应识别为已登录');

  const noisyNotLoggedInStatus = profileManager.updateStatus(
    jdPlatformAdapter,
    Array.from({ length: 199 }, (_item, index) => `noise_${index}`),
  );
  assert(!noisyNotLoggedInStatus.isLoggedIn, '只有无关 Cookie 时不应识别为已登录');

  profileManager.clearStatus('jd');
  assert(!profileManager.getStatus(jdPlatformAdapter).isLoggedIn, '清除登录状态失败');

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jd-image-downloader-stage56-'));
  const store = new AppStateStore(path.join(tempDir, 'app-state.json'));

  try {
    profileManager.updateStatus(jdPlatformAdapter, ['pt_key', 'pt_pin', 'thor']);
    await store.save({
      outputRoot: '',
      tasks: [],
      auth: profileManager.toJSON(),
      updatedAt: Date.now(),
    });

    const loadedState = await store.load();
    const restoredManager = new AuthProfileManager(loadedState.auth);
    assert(restoredManager.getStatus(jdPlatformAdapter).isLoggedIn, '持久化登录状态恢复失败');

    const mainSource = readFileSync('electron/main.ts', 'utf8');
    const preloadSource = readFileSync('electron/preload.ts', 'utf8');
    const appSource = readFileSync('src/App.vue', 'utf8');
    const jdParserSource = readFileSync('core/parsers/jdParser.ts', 'utf8');

    assert(mainSource.includes("ipcMain.handle('auth:login'"), '主进程缺少登录 IPC');
    assert(mainSource.includes('session.fromPartition'), '主进程未使用持久化 Profile 分区');
    assert(mainSource.includes('cookies.get'), '主进程未读取 Cookie');
    assert(mainSource.includes('profilePartition'), '主进程未向解析上下文传递 Profile 信息');
    assert(preloadSource.includes('loginPlatform'), 'preload 缺少登录 API');
    assert(preloadSource.includes('refreshPlatformAuth'), 'preload 缺少刷新登录状态 API');
    assert(appSource.includes('平台登录'), '页面缺少平台登录区');
    assert(appSource.includes('loginPlatform'), '页面缺少登录操作');
    assert(jdParserSource.includes('context.addCookies'), '京东解析器未注入 Cookie');

    console.log('\n阶段 5.6 自动验收通过。');
    console.log(
      JSON.stringify(
        {
          status: restoredManager.getStatus(jdPlatformAdapter),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

void main();
