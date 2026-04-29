import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppStateStore } from '../core/storage/appStateStore.js';
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

const createTask = (id: string, status: DownloadTask['status']): DownloadTask => ({
  id,
  platform: 'jd',
  sourceUrl: `https://item.jd.com/${id}.html`,
  skuId: id,
  title: `商品_${id}`,
  status,
  progress: {
    total: status === 'downloading' ? 10 : 0,
    success: status === 'downloading' ? 4 : 0,
    failed: 0,
  },
  outputDir: status === 'success' ? `D:\\downloads\\${id}` : undefined,
  errorMessage: status === 'failed' ? '历史失败' : undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const main = async () => {
  run('npm', ['run', 'build']);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jd-image-downloader-stage5-'));
  const statePath = path.join(tempDir, 'app-state.json');
  const store = new AppStateStore(statePath);

  try {
    const successTask = createTask('100000000001', 'success');
    const runningTask = createTask('100000000002', 'downloading');
    const failedTask = createTask('100000000003', 'failed');

    await store.save({
      outputRoot: 'D:\\downloads\\jd',
      tasks: [successTask, runningTask, failedTask],
      auth: [
        {
          platform: 'jd',
          isLoggedIn: true,
          cookieCount: 2,
          updatedAt: 123,
        },
      ],
      updatedAt: 123,
    });

    const loadedState = await store.load();
    assert(loadedState.outputRoot === 'D:\\downloads\\jd', '保存目录未正确恢复');
    assert(loadedState.tasks.length === 3, '任务列表未正确恢复');
    assert(loadedState.auth[0]?.platform === 'jd', '登录状态未正确恢复');
    assert(loadedState.tasks[2].errorMessage === '历史失败', '失败原因未正确恢复');

    let changedTasks: DownloadTask[] = [];
    const queue = new TaskQueue({
      initialTasks: loadedState.tasks,
      onChange: (tasks) => {
        changedTasks = tasks;
      },
      processor: async (_task, update) => {
        update({
          status: 'success',
          progress: {
            total: 1,
            success: 1,
            failed: 0,
          },
        });
      },
    });

    const restoredRunningTask = queue.getTask('100000000002');
    if (!restoredRunningTask) {
      throw new Error('运行中任务未恢复');
    }

    assert(restoredRunningTask.status === 'pending', '运行中任务恢复后应重新排队');
    assert(restoredRunningTask.progress.total === 0, '运行中任务恢复后进度应重置');

    queue.addTasks('jd', ['https://item.jd.com/100000000004.html']);
    assert(changedTasks.length === 4, '任务变更回调未触发');

    await store.save({
      outputRoot: 'D:\\downloads\\new-jd',
      tasks: queue.listTasks(),
      auth: loadedState.auth,
      updatedAt: 456,
    });

    const savedContent = JSON.parse(await readFile(statePath, 'utf8')) as {
      outputRoot: string;
      tasks: DownloadTask[];
    };
    assert(savedContent.outputRoot === 'D:\\downloads\\new-jd', '状态文件保存目录错误');
    assert(savedContent.tasks.length === 4, '状态文件任务数量错误');

    const electronMain = readFileSync('electron/main.ts', 'utf8');
    assert(electronMain.includes('AppStateStore'), '主进程未接入 AppStateStore');
    assert(electronMain.includes('app-state.json'), '主进程未指定状态文件');
    assert(electronMain.includes('initialTasks'), '主进程未恢复历史任务');
    assert(electronMain.includes('onChange'), '主进程未监听队列变更保存状态');

    console.log('\n第五阶段自动验收通过。');
    console.log(
      JSON.stringify(
        {
          statePath,
          restoredTasks: queue.listTasks().map((task) => ({
            id: task.id,
            status: task.status,
            outputDir: task.outputDir,
            errorMessage: task.errorMessage,
          })),
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
