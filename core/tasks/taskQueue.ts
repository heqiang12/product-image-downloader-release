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

// 安全模式默认策略（用于在无法获取 Policy 时的兜底）
const DEFAULT_POLICY: DownloadPolicy = {
  safeMode: true,
  imageConcurrency: 2,
  requestDelayMs: 800,
  taskCooldownMin: 20,
  taskCooldownMax: 50,
  browsePauseMin: 60,
  browsePauseMax: 180,
  browseInterval: 5,
  enablePrewarm: true,
};

const createTaskId = (): string =>
  `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TaskQueue {
  private readonly processor: TaskProcessor;

  private readonly concurrency: number;

  private readonly onChange?: (tasks: DownloadTask[]) => void;

  private readonly getActivePolicyFn?: () => DownloadPolicy | undefined;

  private readonly onBrowseCooldown?: (browsePauseMin: number, browsePauseMax: number) => Promise<void>;

  private readonly tasks = new Map<string, DownloadTask>();

  private runningCount = 0;

  private isStarted = false;

  private completedCount = 0;

  // 下一次触发模拟浏览时的已完成任务数阈值
  private nextBrowseAt = 0;

  consecutiveFailures = 0;

  autoPaused = false;

  static readonly AUTO_PAUSE_THRESHOLD = 3;

  constructor(options: TaskQueueOptions) {
    this.processor = options.processor;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.onChange = options.onChange;
    this.getActivePolicyFn = options.getActivePolicyFn;
    this.onBrowseCooldown = options.onBrowseCooldown;
    // 初始 nextBrowseAt 在 start() 时根据 Policy 重置
    this.nextBrowseAt = 0;

    for (const task of options.initialTasks || []) {
      this.tasks.set(task.id, this.normalizeInitialTask(task));
    }
  }

  /** 获取当前活跃 Policy，无法获取时用安全模式兜底 */
  private getPolicy(): DownloadPolicy {
    return this.getActivePolicyFn?.() ?? DEFAULT_POLICY;
  }

  /** 计算本次浏览触发的下一个阈值 */
  private nextBrowseThreshold(policy: DownloadPolicy): number {
    // 在 browseInterval 上下 20% 随机抖动，避免固定节律
    const base = policy.browseInterval;
    const jitter = Math.floor(base * 0.2);
    return this.completedCount + base - jitter + Math.floor(Math.random() * (jitter * 2 + 1));
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
    const policy = this.getPolicy();
    this.isStarted = true;
    this.autoPaused = false;
    this.consecutiveFailures = 0;
    this.completedCount = 0;
    this.nextBrowseAt = this.nextBrowseThreshold(policy);
    this.pump();
    return this.listTasks();
  }

  pause(): DownloadTask[] {
    this.isStarted = false;
    this.emitChange();
    return this.listTasks();
  }

  retryFailed(): DownloadTask[] {
    let retriedCount = 0;

    for (const task of this.tasks.values()) {
      if (task.status === 'failed') {
        retriedCount += 1;
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

    if (retriedCount > 0) {
      const policy = this.getPolicy();
      this.isStarted = true;
      this.autoPaused = false;
      this.consecutiveFailures = 0;
      this.completedCount = 0;
      this.nextBrowseAt = this.nextBrowseThreshold(policy);
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

  clearPending(): DownloadTask[] {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending') {
        this.tasks.delete(task.id);
      }
    }

    this.emitChange();
    return this.listTasks();
  }

  removeTask(id: string): DownloadTask[] {
    const task = this.tasks.get(id);

    if (!task || task.status === 'parsing' || task.status === 'downloading') {
      return this.listTasks();
    }

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
          this.consecutiveFailures = 0;
          this.completedCount += 1;
        }
      })
      .catch((error: unknown) => {
        this.patchTask(task.id, {
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        this.consecutiveFailures += 1;

        // 连续失败达到阈值，自动暂停队列
        if (this.consecutiveFailures >= TaskQueue.AUTO_PAUSE_THRESHOLD) {
          this.isStarted = false;
          this.autoPaused = true;
        }
      })
      .finally(async () => {
        this.runningCount -= 1;

        const hasMorePending = this.listTasks().some((t) => t.status === 'pending');

        if (hasMorePending && this.isStarted) {
          const policy = this.getPolicy();

          // 达到浏览休息阈值：触发模拟浏览/长休
          if (
            this.nextBrowseAt > 0 &&
            this.onBrowseCooldown &&
            this.completedCount >= this.nextBrowseAt
          ) {
            this.nextBrowseAt = this.nextBrowseThreshold(policy);
            try {
              await this.onBrowseCooldown(policy.browsePauseMin, policy.browsePauseMax);
            } catch {
              // 浏览模拟失败不影响主流程
            }
          } else {
            // 渐进式冷却：随任务累积自动拉长间隔，降低被计数器命中的风险
            // 每完成 8 个任务增加 20% 冷却时长，最高 2.5 倍
            const progressFactor = Math.min(2.5, 1 + Math.floor(this.completedCount / 8) * 0.2);
            const minMs = policy.taskCooldownMin * 1_000 * progressFactor;
            const maxMs = policy.taskCooldownMax * 1_000 * progressFactor;
            const cooldownMs = minMs + Math.random() * (maxMs - minMs);
            console.log(
              `[COOLDOWN] 任务间冷却 ${Math.round(cooldownMs / 1000)}s` +
              ` (已完成第 ${this.completedCount} 个, 渐进系数 ${progressFactor.toFixed(1)}x)`,
            );
            await sleep(cooldownMs);
          }
        }

        if (this.isStarted) {
          this.pump();
        } else {
          this.emitChange();
        }
      });
  }
}
