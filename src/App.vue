<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type {
  AssetType,
  DownloadPolicy,
  DownloadTask,
  PlatformAuthStatus,
  TaskMode,
  TaskStatus,
} from './types/electron';

const rawLinks = ref('');
const appVersion = ref('');
const outputRoot = ref('');
const message = ref('等待导入或粘贴商品链接。');
const tasks = ref<DownloadTask[]>([]);
const platforms = ref<PlatformAuthStatus[]>([]);
const selectedPlatformId = ref('jd');
const selectedTaskId = ref('');
const selectedAssetTypes = ref<AssetType[]>(['main', 'detail']);
const safeMode = ref(true);
const debugMode = ref(false);
const customImageConcurrency = ref(5);
const customRequestDelayMs = ref(0);
const pauseRequested = ref(false);
let refreshTimer: number | undefined;

const canAddTasks = computed(() => rawLinks.value.trim().length > 0);
const hasTasks = computed(() => tasks.value.length > 0);
const hasFailedTasks = computed(() => tasks.value.some((task) => task.status === 'failed'));
const hasCompletedTasks = computed(() => tasks.value.some((task) => task.status === 'success'));
const pendingTaskCount = computed(() => tasks.value.filter((task) => task.status === 'pending').length);
const selectedTask = computed(
  () => tasks.value.find((task) => task.id === selectedTaskId.value) || tasks.value[0],
);
const parsedImageLog = computed(() => {
  const task = selectedTask.value;
  if (!task?.parsedImageUrls) {
    return null;
  }
  const { main, detail } = task.parsedImageUrls;
  const lines: string[] = [];
  lines.push(`轮播图 (${main.length} 张):`);
  main.forEach((url, i) => lines.push(`  ${i + 1}. ${url}`));
  lines.push(`详情图 (${detail.length} 张):`);
  detail.forEach((url, i) => lines.push(`  ${i + 1}. ${url}`));
  return lines.join('\n');
});
const taskSummary = computed(() => ({
  total: tasks.value.length,
  running: tasks.value.filter((task) => task.status === 'parsing' || task.status === 'downloading')
    .length,
  success: tasks.value.filter((task) => task.status === 'success').length,
  failed: tasks.value.filter((task) => task.status === 'failed').length,
}));
const shouldShowPauseNotice = computed(
  () => pauseRequested.value && (pendingTaskCount.value > 0 || taskSummary.value.running > 0),
);
const pauseNoticeText = computed(() => {
  const pendingText =
    pendingTaskCount.value > 0
      ? `${pendingTaskCount.value} 个未开始任务已暂停`
      : '没有未开始任务需要暂停';
  const runningText =
    taskSummary.value.running > 0
      ? `${taskSummary.value.running} 个正在执行的任务会完成当前步骤后停止`
      : '当前没有正在执行的任务';

  return `${pendingText}，${runningText}。`;
});
const currentDownloadPolicy = computed<DownloadPolicy>(() => {
  if (safeMode.value) {
    return {
      safeMode: true,
      imageConcurrency: 2,
      requestDelayMs: 800,
    };
  }

  return {
    safeMode: false,
    imageConcurrency: Math.min(8, Math.max(1, Math.round(customImageConcurrency.value || 5))),
    requestDelayMs: Math.min(5_000, Math.max(0, Math.round(customRequestDelayMs.value || 0))),
  };
});
const policySummary = computed(() => formatDownloadPolicy(currentDownloadPolicy.value));
const pendingSettingsSummary = computed(
  () => `${selectedAssetTypeLabels(selectedAssetTypes.value)} · ${policySummary.value}`,
);

const statusText: Record<TaskStatus, string> = {
  pending: '待处理',
  parsing: '解析中',
  downloading: '下载中',
  success: '已完成',
  failed: '失败',
  paused: '已暂停',
};

const statusClass: Record<TaskStatus, string> = {
  pending: 'status-pending',
  parsing: 'status-running',
  downloading: 'status-running',
  success: 'status-success',
  failed: 'status-failed',
  paused: 'status-paused',
};

const modeText: Record<TaskMode, string> = {
  download: '下载',
  parseOnly: '只解析',
};

const assetTypeOptions: Array<{ value: AssetType; label: string }> = [
  { value: 'main', label: '轮播主图' },
  { value: 'detail', label: '详情图' },
];

const assetTypeText: Record<AssetType, string> = {
  main: '轮播主图',
  detail: '详情图',
  sku: 'SKU 图',
  unknown: '未分类图',
};

function formatDownloadPolicy(policy?: DownloadPolicy) {
  const value =
    policy || {
      safeMode: true,
      imageConcurrency: 2,
      requestDelayMs: 800,
    };

  return `${value.safeMode ? '安全模式' : '自定义模式'} · 并发 ${value.imageConcurrency} · 间隔 ${value.requestDelayMs}ms`;
}

const selectedAssetTypeLabels = (types?: AssetType[]) =>
  (types?.length ? types : (['main', 'detail', 'sku'] as AssetType[]))
    .map((type) => assetTypeText[type])
    .filter(Boolean)
    .join('、');

const toggleAssetType = (type: AssetType, checked: boolean) => {
  if (checked) {
    selectedAssetTypes.value = Array.from(new Set([...selectedAssetTypes.value, type]));
    return;
  }

  const nextTypes = selectedAssetTypes.value.filter((item) => item !== type);
  selectedAssetTypes.value = nextTypes.length ? nextTypes : [type];
};

const onAssetTypeChange = (type: AssetType, event: Event) => {
  toggleAssetType(type, (event.target as HTMLInputElement).checked);
};

const getPercent = (task: DownloadTask) => {
  if (task.progress.total === 0) {
    return task.status === 'success' ? 100 : 0;
  }

  return Math.round(((task.progress.success + task.progress.failed) / task.progress.total) * 100);
};

const isTaskPausedByQueue = (task: DownloadTask) => pauseRequested.value && task.status === 'pending';

const getTaskStatusText = (task: DownloadTask) =>
  isTaskPausedByQueue(task) ? '已暂停' : statusText[task.status];

const getTaskStatusClass = (task: DownloadTask) =>
  isTaskPausedByQueue(task) ? 'status-paused' : statusClass[task.status];

const formatAssetCounts = (task?: DownloadTask) => {
  if (!task?.assetCounts) {
    return '-';
  }

  return `轮播 ${task.assetCounts.main} / 详情 ${task.assetCounts.detail} / SKU ${task.assetCounts.sku} / 未分类 ${task.assetCounts.unknown}`;
};

const refreshTasks = async () => {
  tasks.value = await window.jdDownloader.listTasks();

  if (!selectedTaskId.value && tasks.value[0]) {
    selectedTaskId.value = tasks.value[0].id;
  }
};

const refreshPlatforms = async () => {
  platforms.value = await window.jdDownloader.listPlatforms();
};

const addTasks = async (mode: TaskMode = 'download') => {
  try {
    const result = await window.jdDownloader.validateLinks(selectedPlatformId.value, rawLinks.value);

    if (result.validLinks.length === 0) {
      message.value = `未添加任务：共 ${result.total} 行，没有识别到有效商品链接。`;
      return;
    }

    const addedTasks = await window.jdDownloader.addLinks(
      selectedPlatformId.value,
      rawLinks.value,
      [...selectedAssetTypes.value],
      { ...currentDownloadPolicy.value },
      mode,
    );

    await refreshTasks();

    if (addedTasks.length === 0) {
      const existingTask = tasks.value.find((task) =>
        result.validLinks.some((link) => task.sourceUrl.includes(link) || link.includes(task.sourceUrl)),
      );

      if (existingTask) {
        selectedTaskId.value = existingTask.id;
      }

      message.value = `未新增任务：识别到 ${result.validLinks.length} 个有效链接，但任务区已有相同商品。可以先删除旧任务或直接重试失败任务。`;
      return;
    }

    selectedTaskId.value = addedTasks[0].id;
    rawLinks.value = '';
    message.value = `粘贴导入：共 ${result.total} 行，有效 ${result.validLinks.length} 个，新增 ${addedTasks.length} 个${mode === 'parseOnly' ? '解析' : '下载'}任务。`;
  } catch (error) {
    message.value = `添加链接失败：${error instanceof Error ? error.message : String(error)}`;
  }
};

const startTasks = async () => {
  pauseRequested.value = false;
  tasks.value = await window.jdDownloader.startTasks();
  message.value = '任务已开始处理。';
};

const startParseTasks = async () => {
  pauseRequested.value = false;
  tasks.value = await window.jdDownloader.startTasks();
  message.value = '解析任务已开始处理，不会下载图片。';
};

const pauseTasks = async () => {
  tasks.value = await window.jdDownloader.pauseTasks();
  pauseRequested.value = true;
  message.value = `任务队列已暂停：${pauseNoticeText.value}`;
};

const retryFailed = async () => {
  tasks.value = await window.jdDownloader.retryFailed();
  message.value = '失败任务已重新排队。';
};

const clearCompleted = async () => {
  tasks.value = await window.jdDownloader.clearCompleted();
  selectedTaskId.value = tasks.value[0]?.id || '';
  message.value = '已清空完成任务。';
};

const clearFailed = async () => {
  tasks.value = await window.jdDownloader.clearFailed();
  selectedTaskId.value = tasks.value[0]?.id || '';
  message.value = '已清空失败任务。';
};

const removeTask = async (task: DownloadTask) => {
  tasks.value = await window.jdDownloader.removeTask(task.id);
  selectedTaskId.value = tasks.value[0]?.id || '';
  message.value = `已删除任务：${task.title || task.skuId || task.sourceUrl}`;
};

const selectOutputRoot = async () => {
  outputRoot.value = await window.jdDownloader.selectOutputRoot();
  message.value = '保存目录已更新。';
};

const openOutput = async (task: DownloadTask) => {
  const result = await window.jdDownloader.openOutput(task.id);
  message.value = result.ok ? '已打开输出目录。' : result.errorMessage || '打开目录失败。';
};

const loginPlatform = async (platform: PlatformAuthStatus) => {
  const result = await window.jdDownloader.loginPlatform(platform.platform);
  message.value = result.ok ? `已打开${platform.name}登录窗口。` : result.errorMessage || '登录失败。';
};

const refreshPlatformAuth = async (platform: PlatformAuthStatus) => {
  platforms.value = await window.jdDownloader.refreshPlatformAuth(platform.platform);
  message.value = `${platform.name}登录状态已刷新。`;
};

const clearPlatformAuth = async (platform: PlatformAuthStatus) => {
  const result = await window.jdDownloader.clearPlatformAuth(platform.platform);
  await refreshPlatforms();
  message.value = result.ok ? `${platform.name}登录状态已清除。` : result.errorMessage || '清除失败。';
};

const importExcelLinks = async () => {
  const result = await window.jdDownloader.importExcelLinks(
    selectedPlatformId.value,
    [...selectedAssetTypes.value],
    { ...currentDownloadPolicy.value },
    'download',
  );

  if (result.canceled) {
    message.value = '已取消 Excel 导入。';
    return;
  }

  tasks.value = result.tasks;
  selectedTaskId.value = tasks.value[0]?.id || '';
  message.value = `Excel 导入：共 ${result.totalRows} 行，新增 ${result.addedCount} 个任务，异常 ${result.invalidRows.length} 行。`;
};

const exportExcelTemplate = async () => {
  const result = await window.jdDownloader.exportExcelTemplate(selectedPlatformId.value);
  message.value = result.ok
    ? `模板已导出：${result.filePath}`
    : result.canceled
      ? '已取消模板导出。'
      : '模板导出失败。';
};

onMounted(async () => {
  appVersion.value = await window.jdDownloader.getAppVersion();
  outputRoot.value = await window.jdDownloader.getOutputRoot();
  await refreshPlatforms();
  await refreshTasks();
  refreshTimer = window.setInterval(refreshTasks, 800);
});

onUnmounted(() => {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }
});
</script>

<template>
  <main class="app-shell">
    <header class="top-bar">
      <div>
        <p class="eyebrow">Product Image Downloader</p>
        <h1>商品图片下载助手</h1>
      </div>
      <div class="summary-strip">
        <span>总数 {{ taskSummary.total }}</span>
        <span>进行 {{ taskSummary.running }}</span>
        <span>完成 {{ taskSummary.success }}</span>
        <span>失败 {{ taskSummary.failed }}</span>
        <span>v{{ appVersion || '...' }}</span>
      </div>
    </header>

    <section class="workbench">
      <aside class="side-panel">
        <section class="panel-block platform-section">
          <div class="block-heading">
            <h2>平台登录</h2>
          </div>
          <div v-for="platform in platforms" :key="platform.platform" class="platform-row">
            <div>
              <strong>{{ platform.name }}</strong>
              <small>
                {{ platform.isLoggedIn ? '已登录' : '未登录' }}
                · Cookie {{ platform.cookieCount }}
              </small>
            </div>
            <div class="mini-actions">
              <button type="button" @click="loginPlatform(platform)">登录</button>
              <button type="button" class="secondary-button" @click="refreshPlatformAuth(platform)">
                刷新
              </button>
              <button type="button" class="secondary-button" @click="clearPlatformAuth(platform)">
                清除
              </button>
            </div>
          </div>
        </section>

        <section class="panel-block import-section">
          <div class="block-heading">
            <h2>导入任务</h2>
            <div class="mini-actions">
              <button type="button" @click="importExcelLinks">导入 Excel</button>
              <button type="button" class="secondary-button" @click="exportExcelTemplate">
                模板
              </button>
            </div>
          </div>
          <div class="platform-selector">
            <label v-for="platform in platforms" :key="platform.platform">
              <input type="radio" :value="platform.platform" v-model="selectedPlatformId" />
              {{ platform.name }}
            </label>
          </div>
          <textarea
            id="link-input"
            v-model="rawLinks"
            placeholder="https://item.jd.com/100012043978.html"
          />
          <p class="pending-settings">{{ pendingSettingsSummary }}</p>
          <div class="inline-actions">
            <button type="button" :disabled="!canAddTasks" @click="addTasks('download')">
              添加任务
            </button>
            <button
              v-if="debugMode"
              type="button"
              class="secondary-button"
              :disabled="!canAddTasks"
              @click="addTasks('parseOnly')"
            >
              添加解析
            </button>
            <button type="button" class="secondary-button" @click="selectOutputRoot">保存目录</button>
          </div>
          <p class="output-root" :title="outputRoot">{{ outputRoot }}</p>
        </section>
      </aside>

      <section class="task-panel">
        <section class="task-settings">
          <div class="settings-group">
            <h2>任务设置</h2>
            <div class="download-types">
              <span>下载内容</span>
              <label v-for="option in assetTypeOptions" :key="option.value">
                <input
                  type="checkbox"
                  :checked="selectedAssetTypes.includes(option.value)"
                  @change="onAssetTypeChange(option.value, $event)"
                />
                {{ option.label }}
              </label>
            </div>
          </div>
          <div class="settings-group">
            <div class="download-policy">
              <div class="policy-heading">
                <span>下载策略</span>
                <label style="margin-left: auto;">
                  <input type="checkbox" v-model="debugMode" />
                  调试模式
                </label>
                <label>
                  <input type="checkbox" v-model="safeMode" />
                  安全模式
                </label>
              </div>
              <div class="policy-fields">
                <label>
                  图片并发
                  <input
                    type="number"
                    min="1"
                    max="8"
                    :value="safeMode ? 2 : customImageConcurrency"
                    @input="customImageConcurrency = parseInt(($event.target as HTMLInputElement).value) || 1"
                    :disabled="safeMode"
                  />
                </label>
                <label>
                  请求间隔(ms)
                  <input
                    type="number"
                    min="0"
                    max="5000"
                    step="100"
                    :value="safeMode ? 800 : customRequestDelayMs"
                    @input="customRequestDelayMs = parseInt(($event.target as HTMLInputElement).value) || 0"
                    :disabled="safeMode"
                  />
                </label>
              </div>
              <p>{{ policySummary }}</p>
            </div>
          </div>
        </section>
        <div class="panel-heading">
          <h2>任务区</h2>
          <div class="toolbar">
            <button v-if="taskSummary.running === 0" type="button" :disabled="!hasTasks" @click="startTasks">开始下载</button>
            <button v-else type="button" class="secondary-button" @click="pauseTasks">暂停队列</button>
            <button v-if="debugMode" type="button" class="secondary-button" :disabled="!hasTasks" @click="startParseTasks">
              开始解析
            </button>
            <button type="button" :disabled="!hasFailedTasks" @click="retryFailed">重试失败</button>
            <button type="button" :disabled="!hasCompletedTasks" @click="clearCompleted">
              清空完成
            </button>
            <button
              type="button"
              class="danger-button"
              :disabled="!hasFailedTasks"
              @click="clearFailed"
            >
              清空失败
            </button>
          </div>
        </div>

        <div v-if="shouldShowPauseNotice" class="queue-pause-notice" role="status" aria-live="polite">
          <div class="pause-notice-icon" aria-hidden="true">
            <span></span>
            <span></span>
          </div>
          <div>
            <strong>队列已暂停</strong>
            <p>{{ pauseNoticeText }}</p>
          </div>
          <button type="button" @click="startTasks">继续下载</button>
        </div>

        <div class="table-wrap" v-if="tasks.length > 0">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th>平台</th>
                <th>链接</th>
                <th>状态</th>
                <th>进度</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="task in tasks"
                :key="task.id"
                :class="{ selected: task.id === selectedTask?.id, 'queue-paused-row': isTaskPausedByQueue(task) }"
                @click="selectedTaskId = task.id"
              >
                <td>
                  <div class="task-title-wrap">
                    <strong :title="task.title || '待解析商品'">{{ task.title || '待解析商品' }}</strong>
                    <div class="info-tip">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                      </svg>
                      <div class="tip-content">
                        <small v-if="task.skuId">SKU: {{ task.skuId }}</small>
                        <small>模式：{{ modeText[task.mode || 'download'] }}</small>
                        <small>内容：{{ selectedAssetTypeLabels(task.selectedTypes) }}</small>
                        <small>策略：{{ formatDownloadPolicy(task.downloadPolicy) }}</small>
                        <small v-if="task.assetCounts">解析：{{ formatAssetCounts(task) }}</small>
                      </div>
                    </div>
                  </div>
                </td>
                <td>{{ task.platform || '-' }}</td>
                <td class="link-cell">{{ task.sourceUrl }}</td>
                <td>
                  <span class="status" :class="getTaskStatusClass(task)">
                    {{ getTaskStatusText(task) }}
                  </span>
                  <small v-if="task.errorMessage" class="error-message">
                    {{ task.errorMessage }}
                  </small>
                </td>
                <td>
                  <div class="progress-track">
                    <div class="progress-bar" :style="{ width: `${getPercent(task)}%` }"></div>
                  </div>
                  <small>
                    {{ task.progress.success }}/{{ task.progress.total }}
                    <template v-if="task.progress.failed > 0">
                      ，失败 {{ task.progress.failed }}
                    </template>
                  </small>
                </td>
                <td class="row-actions">
                  <button type="button" class="danger-button" @click.stop="removeTask(task)">
                    删除
                  </button>
                  <button
                    type="button"
                    class="secondary-button"
                    :disabled="!task.outputDir"
                    @click.stop="openOutput(task)"
                  >
                    打开目录
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="empty-state">还没有任务</div>
      </section>
    </section>

    <section class="detail-panel">
      <div>
        <h2>任务详情</h2>
        <template v-if="selectedTask">
          <dl>
            <dt>商品</dt>
            <dd>{{ selectedTask.title || '待解析商品' }}</dd>
            <dt>链接</dt>
            <dd>{{ selectedTask.sourceUrl }}</dd>
            <dt>输出目录</dt>
            <dd>{{ selectedTask.outputDir || '-' }}</dd>
            <dt>下载内容</dt>
            <dd>{{ selectedAssetTypeLabels(selectedTask.selectedTypes) }}</dd>
            <dt>任务模式</dt>
            <dd>{{ modeText[selectedTask.mode || 'download'] }}</dd>
            <dt>解析数量</dt>
            <dd>{{ formatAssetCounts(selectedTask) }}</dd>
            <dt>下载策略</dt>
            <dd>{{ formatDownloadPolicy(selectedTask.downloadPolicy) }}</dd>
            <dt>错误</dt>
            <dd>{{ selectedTask.errorMessage || '-' }}</dd>
          </dl>
        </template>
        <p v-else class="muted">选择一个任务查看详情。</p>
      </div>
      <div>
        <h2>日志</h2>
        <p class="log-line">{{ message }}</p>
        <pre v-if="parsedImageLog" class="log-image-urls">{{ parsedImageLog }}</pre>
      </div>
    </section>
  </main>
</template>
