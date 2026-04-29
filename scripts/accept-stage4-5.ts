import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ProductAssets } from '../core/parsers/types.js';
import { createProductTaskProcessor } from '../core/tasks/productTaskProcessor.js';
import type { DownloadTask, TaskPatch } from '../core/tasks/types.js';

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

const createMockProduct = (): ProductAssets => ({
  platform: 'jd',
  skuId: '100012043978',
  title: '真实闭环测试商品',
  sourceUrl: 'https://item.jd.com/100012043978.html',
  images: {
    main: [
      {
        url: 'https://img10.360buyimg.com/n5/jfs/t1/main-001.jpg',
        type: 'main',
      },
    ],
    detail: [
      {
        url: 'https://img11.360buyimg.com/sku/jfs/t1/detail-001.jpg',
        type: 'detail',
      },
    ],
    sku: [
      {
        url: 'https://img12.360buyimg.com/n1/jfs/t1/sku-001.jpg',
        type: 'sku',
      },
    ],
    unknown: [],
  },
  debug: {
    collectedAt: new Date().toISOString(),
    warnings: [],
  },
});

const main = async () => {
  run('npm', ['run', 'build']);

  const patches: TaskPatch[] = [];
  const processor = createProductTaskProcessor({
    getOutputRoot: () => 'D:\\downloads\\jd-test',
    parseProductAssets: async (task) => {
      assert(task.sourceUrl === 'https://item.jd.com/100012043978.html', '解析器收到的链接错误');
      return createMockProduct();
    },
    downloadProductAssets: async (product, options) => {
      assert(product.skuId === '100012043978', '下载器收到的商品数据错误');
      assert(options.outputRoot === 'D:\\downloads\\jd-test', '下载器收到的输出目录错误');
      options.onProgress({ total: 3, success: 1, failed: 0 });
      options.onProgress({ total: 3, success: 3, failed: 0 });

      return {
        product,
        outputDir: 'D:\\downloads\\jd-test\\真实闭环测试商品_100012043978',
        metaPath: 'D:\\downloads\\jd-test\\真实闭环测试商品_100012043978\\meta.json',
        progress: {
          total: 3,
          success: 3,
          failed: 0,
        },
        assets: [],
      };
    },
  });
  const task: DownloadTask = {
    id: 'task-stage-45',
    platform: 'jd',
    sourceUrl: 'https://item.jd.com/100012043978.html',
    status: 'pending',
    progress: {
      total: 0,
      success: 0,
      failed: 0,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await processor(task, (patch) => {
    patches.push(patch);
  });

  assert(patches.some((patch) => patch.status === 'parsing'), '任务未进入解析状态');
  assert(
    patches.some(
      (patch) =>
        patch.status === 'downloading' &&
        patch.title === '真实闭环测试商品' &&
        patch.skuId === '100012043978' &&
        patch.progress?.total === 3,
    ),
    '解析结果未正确回填任务',
  );
  assert(
    patches.some((patch) => patch.progress?.success === 3 && patch.progress.failed === 0),
    '下载进度未正确回填任务',
  );
  assert(
    patches.some(
      (patch) =>
        patch.status === 'success' &&
        patch.outputDir === 'D:\\downloads\\jd-test\\真实闭环测试商品_100012043978',
    ),
    '成功状态和输出目录未正确回填任务',
  );

  const mainSource = readFileSync('electron/main.ts', 'utf8');
  const appSource = readFileSync('src/App.vue', 'utf8');
  const preloadSource = readFileSync('electron/preload.ts', 'utf8');

  assert(mainSource.includes('resolvePlatformLink'), '主进程未通过平台注册表接入解析器');
  assert(mainSource.includes('downloadProductAssets'), '主进程未接入真实下载器');
  assert(mainSource.includes('settings:select-output-root'), '主进程缺少保存目录选择 IPC');
  assert(mainSource.includes('task:open-output'), '主进程缺少打开输出目录 IPC');
  assert(appSource.includes('selectOutputRoot'), '页面缺少保存目录选择');
  assert(appSource.includes('openOutput'), '页面缺少打开输出目录');
  assert(preloadSource.includes('selectOutputRoot'), 'preload 缺少保存目录 API');

  console.log('\n阶段 4.5 自动验收通过。');
  console.log(
    JSON.stringify(
      {
        patchCount: patches.length,
        finalPatch: patches[patches.length - 1],
      },
      null,
      2,
    ),
  );
};

void main();
