import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { TaskQueue } from '../core/tasks/taskQueue.js';
import type { DownloadTask } from '../core/tasks/types.js';

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

const waitUntil = async (predicate: () => boolean, timeoutMs = 3_000) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error('等待任务状态超时');
};

const main = async () => {
  run('npm', ['run', 'build']);

  let maxRunning = 0;
  let running = 0;
  const attempts = new Map<string, number>();
  const queue = new TaskQueue({
    concurrency: 2,
    processor: async (task, update) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      attempts.set(task.sourceUrl, (attempts.get(task.sourceUrl) || 0) + 1);

      if (task.sourceUrl.includes('100000000003') && attempts.get(task.sourceUrl) === 1) {
        running -= 1;
        throw new Error('mock failure');
      }

      update({
        status: 'downloading',
        title: `商品_${task.id}`,
        skuId: '100012043978',
        progress: {
          total: 2,
          success: 1,
          failed: 0,
        },
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      update({
        progress: {
          total: 2,
          success: 2,
          failed: 0,
        },
      });
      running -= 1;
    },
  });

  const added = queue.addTasks('jd', [
    'https://item.jd.com/100000000001.html',
    'https://item.jd.com/100000000002.html',
    'https://item.jd.com/100000000003.html?mock=fail',
    'https://item.jd.com/100000000001.html',
  ]);

  assert(added.length === 3, '重复任务应被过滤');
  assert(queue.listTasks().every((task) => task.status === 'pending'), '新增任务应为待处理状态');

  queue.start();
  await waitUntil(() => {
    const tasks = queue.listTasks();
    return (
      tasks.filter((task) => task.status === 'success').length === 2 &&
      tasks.filter((task) => task.status === 'failed').length === 1
    );
  });

  const afterRun = queue.listTasks();
  const failedTask = afterRun.find((task) => task.status === 'failed') as DownloadTask | undefined;

  assert(maxRunning <= 2, '并发限制未生效');
  assert(failedTask?.errorMessage === 'mock failure', '失败原因未记录');
  assert(
    afterRun
      .filter((task) => task.status === 'success')
      .every((task) => task.progress.total === 2 && task.progress.success === 2),
    '成功任务进度错误',
  );

  queue.retryFailed();
  await waitUntil(() => queue.listTasks().every((task) => task.status === 'success'));
  assert(attempts.get('https://item.jd.com/100000000003.html') === 2, '失败任务未重新执行');

  queue.clearCompleted();
  assert(queue.listTasks().every((task) => task.status !== 'success'), '完成任务清理失败');

  const appVue = readFileSync('src/App.vue', 'utf8');
  const preload = readFileSync('electron/preload.ts', 'utf8');
  const main = readFileSync('electron/main.ts', 'utf8');

  assert(appVue.includes('startTasks'), '页面缺少开始任务操作');
  assert(appVue.includes('retryFailed'), '页面缺少重试失败操作');
  assert(appVue.includes('progress-bar'), '页面缺少进度展示');
  assert(preload.includes('task:start'), 'preload 缺少任务启动 IPC');
  assert(main.includes('task:add-links'), '主进程缺少添加任务 IPC');

  console.log('\n第四阶段自动验收通过。');
  console.log(
    JSON.stringify(
      {
        added: added.length,
        maxRunning,
        remainingTasks: queue.listTasks().map((task) => ({
          sourceUrl: task.sourceUrl,
          status: task.status,
          errorMessage: task.errorMessage,
        })),
      },
      null,
      2,
    ),
  );
};

void main();
