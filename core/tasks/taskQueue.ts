import { platformAdapters } from '../platforms/registry.js';
import type { AssetType } from '../parsers/types.js';
import type {
  DownloadPolicy,
  DownloadTask,
  TaskMode,
  TaskPatch,
  TaskProcessor,
  TaskQueueOptions,
} from './types.js';

const createTaskId = (): string =>
  `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export class TaskQueue {
  private readonly processor: TaskProcessor;

  private readonly concurrency: number;

  private readonly onChange?: (tasks: DownloadTask[]) => void;

  private readonly tasks = new Map<string, DownloadTask>();

  private runningCount = 0;

  private isStarted = false;

  constructor(options: TaskQueueOptions) {
    this.processor = options.processor;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.onChange = options.onChange;

    for (const task of options.initialTasks || []) {
      this.tasks.set(task.id, this.normalizeInitialTask(task));
    }
  }

  addTasks(
    platformId: string,
    sourceUrls: string[],
    selectedTypes?: AssetType[],
    downloadPolicy?: DownloadPolicy,
    mode: TaskMode = 'download',
  ): DownloadTask[] {
    const platformAdapter = platformAdapters.find((p) => p.id === platformId);
    if (!platformAdapter) return [];

    const now = Date.now();
    const existingUrls = new Set(Array.from(this.tasks.values()).map((task) => task.sourceUrl));
    const tasks: DownloadTask[] = [];

    for (const sourceUrl of sourceUrls) {
      if (!platformAdapter.matchUrl(sourceUrl)) {
        continue;
      }

      const normalizedUrl = platformAdapter.normalizeUrl(sourceUrl);
      const skuId = platformAdapter.parseSkuId(normalizedUrl);

      if (existingUrls.has(normalizedUrl)) {
        continue;
      }

      const task: DownloadTask = {
        id: createTaskId(),
        platform: platformAdapter.id,
        sourceUrl: normalizedUrl,
        skuId: skuId || undefined,
        selectedTypes: selectedTypes?.length ? [...selectedTypes] : undefined,
        downloadPolicy: downloadPolicy ? { ...downloadPolicy } : undefined,
        mode,
        status: 'pending',
        progress: {
          total: 0,
          success: 0,
          failed: 0,
        },
        createdAt: now,
        updatedAt: now,
      };

      this.tasks.set(task.id, task);
      existingUrls.add(normalizedUrl);
      tasks.push(task);
    }

    this.pump();
    this.emitChange();
    return tasks;
  }

  listTasks(): DownloadTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  start(): DownloadTask[] {
    this.isStarted = true;
    this.pump();
    return this.listTasks();
  }

  pause(): DownloadTask[] {
    this.isStarted = false;
    this.emitChange();
    return this.listTasks();
  }

  retryFailed(): DownloadTask[] {
    for (const task of this.tasks.values()) {
      if (task.status === 'failed') {
        this.patchTask(task.id, {
          status: 'pending',
          errorMessage: undefined,
          progress: {
            total: 0,
            success: 0,
            failed: 0,
          },
        });
      }
    }

    this.pump();
    this.emitChange();
    return this.listTasks();
  }

  clearCompleted(): DownloadTask[] {
    for (const task of this.tasks.values()) {
      if (task.status === 'success') {
        this.tasks.delete(task.id);
      }
    }

    this.emitChange();
    return this.listTasks();
  }

  clearFailed(): DownloadTask[] {
    for (const task of this.tasks.values()) {
      if (task.status === 'failed') {
        this.tasks.delete(task.id);
      }
    }

    this.emitChange();
    return this.listTasks();
  }

  removeTask(id: string): DownloadTask[] {
    this.tasks.delete(id);
    this.emitChange();
    return this.listTasks();
  }

  getTask(id: string): DownloadTask | undefined {
    return this.tasks.get(id);
  }

  private patchTask(id: string, patch: TaskPatch): void {
    const task = this.tasks.get(id);

    if (!task) {
      return;
    }

    this.tasks.set(id, {
      ...task,
      ...patch,
      progress: patch.progress ? { ...patch.progress } : task.progress,
      updatedAt: Date.now(),
    });
    this.emitChange();
  }

  private emitChange(): void {
    this.onChange?.(this.listTasks());
  }

  private normalizeInitialTask(task: DownloadTask): DownloadTask {
    const resumableStatus = task.status === 'parsing' || task.status === 'downloading';

    return {
      ...task,
      status: resumableStatus ? 'pending' : task.status,
      errorMessage: resumableStatus ? undefined : task.errorMessage,
      progress: resumableStatus
        ? {
            total: 0,
            success: 0,
            failed: 0,
          }
        : { ...task.progress },
    };
  }

  private pump(): void {
    if (!this.isStarted) {
      return;
    }

    while (this.runningCount < this.concurrency) {
      const task = this.listTasks().find((item) => item.status === 'pending');

      if (!task) {
        if (this.runningCount === 0) {
          this.isStarted = false;
        }
        return;
      }

      this.runTask(task);
    }
  }

  private runTask(task: DownloadTask): void {
    this.runningCount += 1;
    this.patchTask(task.id, { status: 'parsing' });

    void this.processor(this.tasks.get(task.id) || task, (patch) => this.patchTask(task.id, patch))
      .then(() => {
        const currentTask = this.tasks.get(task.id);

        if (currentTask && currentTask.status !== 'failed') {
          this.patchTask(task.id, { status: 'success' });
        }
      })
      .catch((error: unknown) => {
        this.patchTask(task.id, {
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.runningCount -= 1;
        this.pump();
      });
  }
}
