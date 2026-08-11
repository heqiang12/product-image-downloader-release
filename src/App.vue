<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type {
  AssetType,
  DownloadPolicy,
  DownloadTask,
  PlatformAuthStatus,
  QueueRunState,
  RiskPaceLevel,
  TaskFailureKind,
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
const riskPaceLevel = ref<RiskPaceLevel>('standard');
const debugMode = ref(false);
const showAdvancedPolicy = ref(false); // 高级反风控设置是否展开
// ── 图片下载参数 ──
const customImageConcurrency = ref(5);
const customRequestDelayMs = ref(0);
// ── 反风控节奏参数（自定义模式专用） ──
const customTaskCooldownMin = ref(5);
const customTaskCooldownMax = ref(15);
const customBrowsePauseMin = ref(15);
const customBrowsePauseMax = ref(45);
const customBrowseInterval = ref(10);
const customEnablePrewarm = ref(false);
const pauseRequested = ref(false);
const autoPaused = ref(false);
const autoPauseThreshold = ref(3);
const queueRunState = ref<QueueRunState>('idle');
const queueCooldownUntil = ref<number | undefined>();
const queueLastErrorMessage = ref('');
const queueLastFailureKind = ref<TaskFailureKind | undefined>();
const queueCurrentTask = ref<{ id: string; title?: string; skuId?: string; sourceUrl: string; status: TaskStatus } | undefined>();
const queueCounts = ref({ total: 0, pending: 0, running: 0, success: 0, failed: 0 });
const cooldownRemainingSec = ref(0);
let refreshTimer: number | undefined;
let cooldownTimer: number | undefined;
let disposeUpdateProgress: (() => void) | undefined;
let disposeUpdateError: (() => void) | undefined;

const canAddTasks = computed(() => rawLinks.value.trim().length > 0);
const hasTasks = computed(() => tasks.value.length > 0);
const hasFailedTasks = computed(() => tasks.value.some((task) => task.status === 'failed'));
const hasCompletedTasks = computed(() => tasks.value.some((task) => task.status === 'success'));
const securityRiskKinds: TaskFailureKind[] = ['securityRisk', 'captcha', 'authExpired'];
const hasSecurityRiskTasks = computed(() =>
  tasks.value.some((task) => task.status === 'failed' && task.failureKind && securityRiskKinds.includes(task.failureKind)),
);
const firstSecurityRiskTask = computed(() =>
  tasks.value.find((task) => task.status === 'failed' && task.failureKind && securityRiskKinds.includes(task.failureKind)),
);
const hasPendingTasks = computed(() => tasks.value.some((task) => task.status === 'pending'));
const pendingTaskCount = computed(() => tasks.value.filter((task) => task.status === 'pending').length);
const failedTasks = computed(() => tasks.value.filter((task) => task.status === 'failed'));
const selectedPlatform = computed(() =>
  platforms.value.find((platform) => platform.platform === selectedPlatformId.value),
);
const isSelectedPlatformLoggedIn = computed(() => selectedPlatform.value?.isLoggedIn === true);
const runnableTasks = computed(() =>
  tasks.value.filter((task) => task.status === 'pending' || task.status === 'paused'),
);
const loginRequiredPlatforms = computed(() => {
  const platformIds = new Set(runnableTasks.value.map((task) => task.platform).filter(Boolean));

  return platforms.value.filter(
    (platform) => platformIds.has(platform.platform) && !platform.isLoggedIn,
  );
});
const failedLoginRequiredPlatforms = computed(() => {
  const platformIds = new Set(failedTasks.value.map((task) => task.platform).filter(Boolean));

  return platforms.value.filter(
    (platform) => platformIds.has(platform.platform) && !platform.isLoggedIn,
  );
});
const requiresLoginBeforeStart = computed(
  () =>
    loginRequiredPlatforms.value.length > 0 &&
    tasks.value.every((task) => task.status !== 'parsing' && task.status !== 'downloading'),
);
const selectedTask = computed(
  () => tasks.value.find((task) => task.id === selectedTaskId.value) || tasks.value[0],
);
const failedSummaryText = computed(() => {
  if (failedTasks.value.length === 0) {
    return '';
  }

  const firstError = failedTasks.value.find((task) => task.errorMessage)?.errorMessage;
  return firstError
    ? `${failedTasks.value.length} 个任务失败：${firstError}`
    : `${failedTasks.value.length} 个任务失败，请选择任务查看详情。`;
});
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
const isQueueActive = computed(() => queueRunState.value === 'running' || queueRunState.value === 'cooling');
const shouldShowPauseNotice = computed(
  () => pauseRequested.value && (pendingTaskCount.value > 0 || isQueueActive.value),
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
const RISK_PACE_PRESETS: Record<RiskPaceLevel, DownloadPolicy> = {
  fast: {
    safeMode: true,
    riskPaceLevel: 'fast',
    imageConcurrency: 2,
    requestDelayMs: 800,
    taskCooldownMin: 30,
    taskCooldownMax: 75,
    browsePauseMin: 180,
    browsePauseMax: 360,
    browseInterval: 12,
    enablePrewarm: false,
  },
  standard: {
    safeMode: true,
    riskPaceLevel: 'standard',
    imageConcurrency: 2,
    requestDelayMs: 800,
    taskCooldownMin: 60,
    taskCooldownMax: 150,
    browsePauseMin: 300,
    browsePauseMax: 600,
    browseInterval: 10,
    enablePrewarm: false,
  },
  conservative: {
    safeMode: true,
    riskPaceLevel: 'conservative',
    imageConcurrency: 1,
    requestDelayMs: 1200,
    taskCooldownMin: 120,
    taskCooldownMax: 300,
    browsePauseMin: 600,
    browsePauseMax: 1200,
    browseInterval: 6,
    enablePrewarm: false,
  },
};

const currentDownloadPolicy = computed<DownloadPolicy>(() => {
  if (safeMode.value) {
    return { ...RISK_PACE_PRESETS[riskPaceLevel.value] };
  }

  return {
    safeMode: false,
    imageConcurrency: Math.min(8, Math.max(1, Math.round(customImageConcurrency.value || 5))),
    requestDelayMs: Math.min(5_000, Math.max(0, Math.round(customRequestDelayMs.value || 0))),
    taskCooldownMin: Math.min(300, Math.max(1, Math.round(customTaskCooldownMin.value || 5))),
    taskCooldownMax: Math.min(600, Math.max(1, Math.round(customTaskCooldownMax.value || 15))),
    browsePauseMin: Math.min(600, Math.max(1, Math.round(customBrowsePauseMin.value || 15))),
    browsePauseMax: Math.min(1200, Math.max(1, Math.round(customBrowsePauseMax.value || 45))),
    browseInterval: Math.min(100, Math.max(1, Math.round(customBrowseInterval.value || 10))),
    enablePrewarm: customEnablePrewarm.value,
  };
});
const policySummary = computed(() => formatDownloadPolicy(currentDownloadPolicy.value));
const pendingSettingsSummary = computed(
  () => `${selectedAssetTypeLabels(selectedAssetTypes.value)} · ${policySummary.value}`,
);
const loginHintText = computed(() => {
  if (isSelectedPlatformLoggedIn.value) {
    return '当前平台已登录，可以开始解析和下载。';
  }

  return selectedPlatform.value
    ? `当前选择 ${selectedPlatform.value.name}，下载前建议先登录并刷新状态。`
    : '下载前建议先完成平台登录。';
});

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
  { value: 'currentPrice', label: '当前价格' },
  { value: 'originalPrice', label: '划线价' },
];

const assetTypeText: Record<AssetType, string> = {
  main: '轮播主图',
  detail: '详情图',
  sku: 'SKU 图',
  unknown: '未分类图',
  currentPrice: '当前价格',
  originalPrice: '划线价',
};

const riskPaceLabel: Record<RiskPaceLevel, string> = {
  fast: '快速',
  standard: '标准',
  conservative: '保守',
};

function formatDownloadPolicy(policy?: DownloadPolicy) {
  const value = policy || {
    safeMode: true,
    riskPaceLevel: 'standard' as RiskPaceLevel,
    imageConcurrency: 2,
    requestDelayMs: 800,
    taskCooldownMin: 60,
    taskCooldownMax: 150,
    browsePauseMin: 300,
    browsePauseMax: 600,
    browseInterval: 10,
    enablePrewarm: false,
  };

  const cooldown = `冷却 ${value.taskCooldownMin ?? 5}~${value.taskCooldownMax ?? 15}s`;

  if (value.safeMode) {
    const pace = value.riskPaceLevel || 'standard';
    return `安全模式 · ${riskPaceLabel[pace]} · ${cooldown} · 每 ${value.browseInterval} 个休息 ${Math.round((value.browsePauseMin ?? 300) / 60)}~${Math.round((value.browsePauseMax ?? 600) / 60)}min`;
  }

  return `自定义模式 · 并发 ${value.imageConcurrency} · 间隔 ${value.requestDelayMs}ms · ${cooldown}`;
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

const canRemoveTask = (task: DownloadTask) =>
  task.status !== 'parsing' && task.status !== 'downloading';

const formatAssetCounts = (task?: DownloadTask) => {
  if (!task?.assetCounts) {
    return '-';
  }

  return `轮播 ${task.assetCounts.main} / 详情 ${task.assetCounts.detail} / SKU ${task.assetCounts.sku} / 未分类 ${task.assetCounts.unknown}`;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const refreshTasks = async () => {
  tasks.value = await window.jdDownloader.listTasks();

  if (!selectedTaskId.value && tasks.value[0]) {
    selectedTaskId.value = tasks.value[0].id;
  }

  const status = await window.jdDownloader.getQueueStatus();
  autoPaused.value = status.autoPaused;
  autoPauseThreshold.value = status.threshold;
  queueRunState.value = status.state;
  queueCooldownUntil.value = status.cooldownUntil;
  queueLastErrorMessage.value = status.lastErrorMessage || '';
  queueLastFailureKind.value = status.lastFailureKind;
  queueCurrentTask.value = status.currentTask;
  queueCounts.value = status.counts;

  // 冷却倒计时：每秒更新剩余秒数
  if (status.cooldownUntil) {
    startCooldownTimer();
  } else {
    stopCooldownTimer();
  }
};

const startCooldownTimer = () => {
  if (cooldownTimer) return;
  cooldownTimer = window.setInterval(() => {
    if (!queueCooldownUntil.value) {
      stopCooldownTimer();
      return;
    }
    const remain = Math.max(0, Math.round((queueCooldownUntil.value - Date.now()) / 1000));
    cooldownRemainingSec.value = remain;
    if (remain <= 0) {
      stopCooldownTimer();
    }
  }, 1000);
};

const stopCooldownTimer = () => {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = undefined;
  }
  cooldownRemainingSec.value = 0;
};

const formatCooldown = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

const openLoginForSelectedPlatform = async () => {
  if (!selectedPlatform.value) {
    message.value = '未找到当前平台，请刷新后重试。';
    return;
  }

  await loginPlatform(selectedPlatform.value);
};

const ensureCanStartTasks = () => {
  if (!hasTasks.value) {
    message.value = '任务区还没有任务，请先添加商品链接。';
    return false;
  }

  if (requiresLoginBeforeStart.value) {
    const names = loginRequiredPlatforms.value.map((platform) => platform.name).join('、');
    message.value = `开始前需要先登录 ${names}：点击左侧“登录”，完成后点“刷新”，再开始下载。`;
    return false;
  }

  return true;
};

const startTasks = async () => {
  if (!ensureCanStartTasks()) {
    return;
  }

  pauseRequested.value = false;
  autoPaused.value = false;
  tasks.value = await window.jdDownloader.startTasks();
  message.value = '任务已开始处理，正在解析商品图片。';
};

const startParseTasks = async () => {
  if (!ensureCanStartTasks()) {
    return;
  }

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
  if (failedLoginRequiredPlatforms.value.length > 0) {
    const names = failedLoginRequiredPlatforms.value.map((platform) => platform.name).join('、');
    message.value = `重试前需要先登录 ${names}，完成后点”刷新”再重试。`;
    return;
  }

  pauseRequested.value = false;
  autoPaused.value = false;
  tasks.value = await window.jdDownloader.retryFailed();
  message.value = '失败任务已重新排队并开始处理。';
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

const clearPending = async () => {
  tasks.value = await window.jdDownloader.clearPending();
  selectedTaskId.value = tasks.value[0]?.id || '';
  message.value = '已清空待处理任务。';
};

const removeTask = async (task: DownloadTask) => {
  if (!canRemoveTask(task)) {
    message.value = '任务正在执行，暂不能删除。可以先暂停队列，等待当前任务完成后再删除。';
    return;
  }

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
  const latest = platforms.value.find((item) => item.platform === platform.platform);
  message.value = latest?.isLoggedIn
    ? `${platform.name}登录状态已刷新：已登录，Cookie ${latest.cookieCount}。`
    : `${platform.name}登录状态已刷新：仍未登录。`;
};

const openManualVerify = async () => {
  const platformId = firstSecurityRiskTask.value?.platform || selectedPlatformId.value;
  const taskId = firstSecurityRiskTask.value?.id;
  const result = await window.jdDownloader.openManualVerify(platformId, taskId);
  message.value = result.ok
    ? '已打开京东验证页面，请在页面中手动完成验证后回到应用重试。'
    : result.errorMessage || '打开验证页面失败。';
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
  disposeUpdateProgress = window.jdDownloader.onUpdateDownloadProgress((progress) => {
    message.value = `正在下载更新：${progress.percent}%（${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}）`;
  });
  disposeUpdateError = window.jdDownloader.onUpdateError((errorMessage) => {
    message.value = `更新检查失败：${errorMessage}`;
  });
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
  stopCooldownTimer();
  disposeUpdateProgress?.();
  disposeUpdateError?.();
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
              <small :class="platform.isLoggedIn ? 'auth-ok' : 'auth-missing'">
                {{ platform.isLoggedIn ? '已登录' : '未登录' }}
                · Cookie {{ platform.cookieCount }}
              </small>
            </div>
            <div class="mini-actions">
              <button type="button" @click="loginPlatform(platform)">{{ platform.isLoggedIn ? '查看' : '登录' }}</button>
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
          <div
            class="login-hint"
            :class="isSelectedPlatformLoggedIn ? 'login-hint-ok' : 'login-hint-warning'"
          >
            <span>{{ loginHintText }}</span>
            <button
              v-if="!isSelectedPlatformLoggedIn"
              type="button"
              class="secondary-button"
              @click="openLoginForSelectedPlatform"
            >
              去登录
            </button>
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
              <!-- 高级反风控设置 -->
              <div class="advanced-policy-toggle">
                <button
                  v-if="!safeMode"
                  type="button"
                  class="secondary-button toggle-btn"
                  @click="showAdvancedPolicy = !showAdvancedPolicy"
                >
                  {{ showAdvancedPolicy ? '▾ 收起高级设置' : '▸ 高级反风控设置' }}
                </button>
                <span v-else class="safe-mode-hint">安全模式会使用更保守的解析节奏，降低连续访问强度</span>
              </div>
              <div v-if="safeMode" class="risk-pace-selector">
                <span class="risk-pace-label">安全节奏</span>
                <label v-for="level in (['fast', 'standard', 'conservative'] as RiskPaceLevel[])" :key="level" class="risk-pace-option">
                  <input
                    type="radio"
                    name="riskPaceLevel"
                    :value="level"
                    v-model="riskPaceLevel"
                  />
                  {{ riskPaceLabel[level] }}
                </label>
                <span class="risk-pace-desc">
                  <template v-if="riskPaceLevel === 'fast'">适合少量商品，速度更快，风险相对更高</template>
                  <template v-else-if="riskPaceLevel === 'standard'">推荐，速度与稳定性折中</template>
                  <template v-else>适合触发过风控后使用，速度较慢</template>
                </span>
              </div>
              <div v-if="!safeMode && showAdvancedPolicy" class="advanced-policy-fields">
                <div class="advanced-policy-row">
                  <label>
                    任务冷却最小(s)
                    <input
                      type="number" min="1" max="300"
                      v-model.number="customTaskCooldownMin"
                    />
                  </label>
                  <label>
                    任务冷却最大(s)
                    <input
                      type="number" min="1" max="600"
                      v-model.number="customTaskCooldownMax"
                    />
                  </label>
                </div>
                <div class="advanced-policy-row">
                  <label>
                    浏览休息最小(s)
                    <input
                      type="number" min="1" max="600"
                      v-model.number="customBrowsePauseMin"
                    />
                  </label>
                  <label>
                    浏览休息最大(s)
                    <input
                      type="number" min="1" max="1200"
                      v-model.number="customBrowsePauseMax"
                    />
                  </label>
                </div>
                <div class="advanced-policy-row">
                  <label>
                    每 N 个任务休息
                    <input
                      type="number" min="1" max="100"
                      v-model.number="customBrowseInterval"
                    />
                  </label>
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="customEnablePrewarm" />
                    预热导航
                  </label>
                </div>
              </div>
              <p>{{ policySummary }}</p>
            </div>
          </div>
        </section>
        <div class="panel-heading">
          <h2>任务区</h2>
          <div class="toolbar">
            <button v-if="isQueueActive" type="button" class="secondary-button" @click="pauseTasks">暂停队列</button>
            <button v-else type="button" :disabled="!hasTasks" @click="startTasks">开始下载</button>
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
            <button type="button" :disabled="!hasPendingTasks" @click="clearPending">
              清空待处理
            </button>
          </div>
        </div>

        <div v-if="requiresLoginBeforeStart" class="action-notice auth-notice" role="alert">
          <div>
            <strong>开始下载前需要登录</strong>
            <p>
              待处理任务包含未登录平台：{{ loginRequiredPlatforms.map((platform) => platform.name).join('、') }}。
              请先登录并刷新状态，避免任务直接失败。
            </p>
          </div>
          <button type="button" @click="openLoginForSelectedPlatform">去登录</button>
        </div>

        <div v-if="hasFailedTasks" class="action-notice failure-notice" role="status">
          <div>
            <strong>有任务处理失败</strong>
            <p>{{ failedSummaryText }}</p>
          </div>
          <button type="button" class="danger-button" @click="clearFailed">清空失败</button>
        </div>

        <div v-if="autoPaused" class="action-notice auto-pause-notice" role="alert">
          <div>
            <strong>连续失败，已自动暂停</strong>
            <p>连续 {{ autoPauseThreshold }} 个任务失败，可能是登录态失效或触发了平台风控。请检查登录状态后重试。</p>
          </div>
          <div class="auto-pause-actions">
            <button type="button" @click="openLoginForSelectedPlatform">检查登录</button>
            <button type="button" @click="retryFailed">重试失败</button>
          </div>
        </div>

        <div v-if="hasSecurityRiskTasks" class="action-notice security-risk-notice" role="alert">
          <div>
            <strong>京东需要手动验证</strong>
            <p>京东返回安全验证或账号风险页面，队列已暂停。请在打开的京东页面中手动完成验证或正常浏览当前商品，完成后返回应用重试失败任务。</p>
          </div>
          <div class="auto-pause-actions">
            <button type="button" @click="openManualVerify">打开验证页面</button>
            <button type="button" @click="retryFailed">我已完成验证，重试失败任务</button>
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

        <!-- 总状态栏 -->
        <div v-if="hasTasks" class="queue-status-bar" role="status" aria-live="polite">
          <div class="queue-status-row">
            <span class="queue-status-label">状态</span>
            <span :class="['queue-status-value', `queue-state-${queueRunState}`]">
              <template v-if="queueRunState === 'running'">运行中</template>
              <template v-else-if="queueRunState === 'cooling'">冷却中</template>
              <template v-else-if="queueRunState === 'paused'">已暂停</template>
              <template v-else-if="queueRunState === 'autoPaused'">自动暂停</template>
              <template v-else-if="queueRunState === 'securityBlocked'">风控中断</template>
              <template v-else-if="queueRunState === 'completed'">已完成</template>
              <template v-else-if="queueRunState === 'failed'">有失败</template>
              <template v-else>空闲</template>
            </span>
            <span class="queue-status-counts">
              成功 {{ queueCounts.success }} · 失败 {{ queueCounts.failed }} · 待处理 {{ queueCounts.pending }}
            </span>
          </div>
          <div v-if="queueCurrentTask" class="queue-status-row queue-status-current">
            <span class="queue-status-label">当前</span>
            <span class="queue-status-value">
              {{ queueCurrentTask.skuId || queueCurrentTask.title || queueCurrentTask.sourceUrl }}
            </span>
          </div>
          <div v-if="queueRunState === 'cooling' && cooldownRemainingSec > 0" class="queue-status-row queue-status-cooldown">
            <span class="queue-status-label">冷却</span>
            <span class="queue-status-value">剩余 {{ formatCooldown(cooldownRemainingSec) }}</span>
          </div>
          <div v-if="(queueRunState === 'autoPaused' || queueRunState === 'securityBlocked') && queueLastErrorMessage" class="queue-status-row queue-status-error">
            <span class="queue-status-label">异常</span>
            <span class="queue-status-value">{{ queueLastErrorMessage }}</span>
          </div>
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
                  <button
                    type="button"
                    class="danger-button"
                    :disabled="!canRemoveTask(task)"
                    @click.stop="removeTask(task)"
                  >
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
            <dt>当前价格</dt>
            <dd>{{ selectedTask.prices?.current || '-' }}</dd>
            <dt>划线价</dt>
            <dd>{{ selectedTask.prices?.original || '-' }}</dd>
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
