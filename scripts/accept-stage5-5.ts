import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platformAdapters, resolvePlatformLink } from '../core/platforms/registry.js';
import { jdPlatformAdapter } from '../core/platforms/jd/adapter.js';
import { TaskQueue } from '../core/tasks/taskQueue.js';

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

  assert(platformAdapters.some((platform) => platform.id === 'jd'), '京东平台未注册');
  assert(jdPlatformAdapter.name === '京东', '京东 adapter 元信息错误');
  assert(
    jdPlatformAdapter.matchUrl('https://item.jd.com/100012043978.html'),
    '京东 adapter URL 匹配失败',
  );

  const resolvedLink = resolvePlatformLink(
    'https://item.m.jd.com/product/100012043978.html?scene=1',
  );

  if (!resolvedLink) {
    throw new Error('平台识别失败');
  }

  assert(resolvedLink.platform.id === 'jd', '平台识别失败');
  assert(
    resolvedLink.normalizedUrl === 'https://item.jd.com/100012043978.html',
    '平台链接标准化失败',
  );
  assert(resolvedLink.skuId === '100012043978', '平台 SKU 识别失败');

  const queue = new TaskQueue({
    processor: async () => undefined,
  });
  const added = queue.addTasks([
    'https://item.m.jd.com/product/100012043978.html?scene=1',
    'https://example.com/100012043978.html',
  ]);

  assert(added.length === 1, '队列应只接收已支持平台链接');
  assert(added[0].platform === 'jd', '任务未写入平台标识');
  assert(
    added[0].sourceUrl === 'https://item.jd.com/100012043978.html',
    '任务未使用标准化链接',
  );
  assert(added[0].skuId === '100012043978', '任务未写入平台 SKU');

  const mainSource = readFileSync('electron/main.ts', 'utf8');
  const registrySource = readFileSync('core/platforms/registry.ts', 'utf8');
  const appSource = readFileSync('src/App.vue', 'utf8');

  assert(mainSource.includes('isSupportedProductUrl'), '主进程未使用通用平台 URL 判断');
  assert(mainSource.includes('resolvePlatformLink'), '主进程未使用平台解析分发');
  assert(!mainSource.includes('isJdProductUrl'), '主进程仍直接依赖京东 URL 判断');
  assert(registrySource.includes('platformAdapters'), '缺少平台注册表');
  assert(appSource.includes('task.platform'), '页面未展示任务平台');

  console.log('\n阶段 5.5 自动验收通过。');
  console.log(
    JSON.stringify(
      {
        platforms: platformAdapters.map((platform) => ({
          id: platform.id,
          name: platform.name,
        })),
        task: added[0],
      },
      null,
      2,
    ),
  );
};

void main();
