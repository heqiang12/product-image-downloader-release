# 京东解析风控下一轮优化实施方案

本文档基于当前代码实际状态，整理下一轮可实施方案。

背景：

- 已经按上一版方案加入了错误分类、手动验证入口、安全模式慢速参数、解析动作减量。
- 实测仍会触发风控：有时十几个商品触发，有时约 80 个商品触发，表现不稳定。
- 当前判断：继续拉长时间不是最优解，应该先减少额外京东访问，再提供可配置节奏档位。

## 核心调整方向

本轮重点做四件事：

1. 去掉安全模式下的“中性页释放”京东访问。
2. 去掉安全模式下的“模拟浏览”京东访问，改为纯休眠。
3. 将安全模式拆成三个档位：快 / 中 / 慢，默认中档。
4. 强化异常提示和总状态栏，让用户明确知道当前是运行、冷却、暂停还是风控中断。

## 一、去掉额外京东访问

### 1.1 问题：解析后中性页释放会增加访问量

当前 `ParseWindowManager.release()` 会在每个商品解析后导航到以下页面之一：

- `https://www.jd.com/`
- `https://search.jd.com/Search?keyword=生活用品&enc=utf-8`
- `https://channel.jd.com/allasite.html`

原意是避免窗口最后停在商品页，但批量场景下这会让每个商品额外多一次京东访问。

在风控计数维度上，这可能从：

```text
商品页 × N
```

变成：

```text
商品页 × N + 首页/搜索/频道页 × N
```

这类“每个任务结束后都去中性页”的固定模式，也可能成为新的行为特征。

### 1.2 建议改法

安全模式下不要再导航京东中性页。

改为：

- `about:blank`
- 或只执行轻量 DOM 清理
- 或保持当前页面不动，等待下一次 `loadURL`

推荐方案：

```ts
async release(policy?: DownloadPolicy): Promise<void> {
  if (!this.win || this.win.isDestroyed()) return;

  if (policy?.safeMode !== false) {
    await this.win.loadURL('about:blank').catch(() => undefined);
    await randomWait(300, 800);
    return;
  }

  // 自定义模式如仍需要，可保留原来的中性页逻辑，但建议也默认关闭。
}
```

### 1.3 相关代码位置

- `electron/main.ts`
  - `ParseWindowManager.release`
  - `parseJdProductAssetsWithElectronSession` 的 `finally`

当前 `release()` 没有接收策略参数，建议改成：

```ts
await parseWindowManager?.release(downloadPolicy);
```

如果想进一步保守，可以直接全局改成 `about:blank`，不区分模式。

## 二、去掉安全模式下的模拟浏览

### 2.1 问题：模拟浏览反而增加京东行为量

当前 `simulateJdBrowse()` 在触发浏览休息时，有概率打开隐藏窗口并访问：

- 首页
- 频道页
- 京东超市
- 电子频道

并执行 5-10 轮动作，包括：

- 随机点击商品/频道/分类链接
- 滚动页面
- 阅读停留

这套逻辑在早期设计里用于“模拟用户休息”，但实测风控仍高时，它可能变成反效果：

- 增加访问次数。
- 增加隐藏窗口行为。
- 增加随机点击轨迹。
- 与批量解析商品页混在同一个登录分区里，服务端仍能看到连续活动。

### 2.2 建议改法

安全模式下，`onBrowseCooldown` 只做纯休眠，不打开任何京东页面。

推荐：

```ts
const sleepCooldown = async (browsePauseMin: number, browsePauseMax: number) => {
  const pauseMs = browsePauseMin * 1_000 + Math.random() * (browsePauseMax - browsePauseMin) * 1_000;
  console.log(`[COOLDOWN] 纯休眠 ${Math.round(pauseMs / 1000)}s`);
  await wait(pauseMs);
};
```

然后在 `createTaskQueue` 中替换：

```ts
onBrowseCooldown: (browsePauseMin, browsePauseMax) =>
  sleepCooldown(browsePauseMin, browsePauseMax),
```

如果仍想给自定义模式保留模拟浏览，可以加策略判断：

```ts
onBrowseCooldown: (browsePauseMin, browsePauseMax, policy) =>
  policy.safeMode ? sleepCooldown(...) : simulateJdBrowse(...),
```

但当前 `TaskQueueOptions.onBrowseCooldown` 还没有传 policy。为了减少改动，建议先全局改为纯休眠。

### 2.3 相关代码位置

- `electron/main.ts`
  - `simulateJdBrowse`
  - `createTaskQueue`
- `core/tasks/types.ts`
  - 如需要给 `onBrowseCooldown` 传 policy，需要改 `TaskQueueOptions`
- `core/tasks/taskQueue.ts`
  - 当前调用 `this.onBrowseCooldown(policy.browsePauseMin, policy.browsePauseMax)`

本轮建议最小改动：保留 `simulateJdBrowse` 函数但不再调用，新增 `sleepJdCooldown` 并替换调用。

## 三、安全模式三档配置

### 3.1 目标

现在安全模式只有一套参数，而且偏慢。用户需要根据批量规模和账号状态选择节奏。

建议提供三档：

- 快速：适合少量商品、临时解析、账号状态稳定。
- 标准：默认档，适合日常批量。
- 保守：适合刚触发过风控、账号较敏感、长批量任务。

默认使用“标准”。

### 3.2 新增类型

在 `core/tasks/types.ts` 和 `src/types/electron.d.ts` 中新增：

```ts
export type RiskPaceLevel = 'fast' | 'standard' | 'conservative';
```

扩展 `DownloadPolicy`：

```ts
export interface DownloadPolicy {
  safeMode: boolean;
  riskPaceLevel?: RiskPaceLevel;
  imageConcurrency: number;
  requestDelayMs: number;
  taskCooldownMin: number;
  taskCooldownMax: number;
  browsePauseMin: number;
  browsePauseMax: number;
  browseInterval: number;
  enablePrewarm: boolean;
}
```

说明：

- `riskPaceLevel` 只在安全模式下生效。
- 自定义模式仍使用用户手动输入的数值。

### 3.3 三档建议参数

建议先采用以下参数，后续根据实测再调。

| 档位 | 用途 | 任务冷却 | 每 N 个任务休息 | 休息时长 | 首屏等待 | 详情补图策略 |
| --- | --- | --- | --- | --- | --- | --- |
| 快速 `fast` | 少量商品、临时解析 | 30-75s | 10-15 | 3-6min | 4-8s | DOM 不足时先点详情 tab + 轻滚动 |
| 标准 `standard` | 默认日常批量 | 60-150s | 8-12 | 5-10min | 6-10s | DOM 不足时先点详情 tab + 轻滚动 |
| 保守 `conservative` | 触发过风控或长批量 | 120-300s | 5-8 | 10-20min | 8-14s | DOM 不足时先点详情 tab + 轻滚动，避免额外接口 |

对应 `DownloadPolicy` 参数：

```ts
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
```

### 3.4 默认档位

默认：

```ts
const defaultRiskPaceLevel: RiskPaceLevel = 'standard';
```

`DEFAULT_DOWNLOAD_POLICY` 应该来自 `RISK_PACE_PRESETS.standard`，不要在多个文件里手写散落常量。

建议新增共享文件：

```text
core/tasks/downloadPolicy.ts
```

导出：

```ts
export const RISK_PACE_PRESETS = ...
export const DEFAULT_RISK_PACE_LEVEL = 'standard'
export const DEFAULT_DOWNLOAD_POLICY = RISK_PACE_PRESETS[DEFAULT_RISK_PACE_LEVEL]
```

然后以下文件统一引用：

- `electron/main.ts`
- `core/tasks/taskQueue.ts`
- `core/tasks/productTaskProcessor.ts`
- 前端可复制同一份常量，或通过 IPC 获取配置。

短期可先在前端和主进程各放一份，但要保持一致。

### 3.5 前端 UI

在 `src/App.vue` 的安全模式区域加入三档选择：

```text
安全节奏：快速 / 标准 / 保守
```

建议用单选按钮或 segmented control。

显示文案：

- 快速：适合少量商品，速度更快，风险相对更高。
- 标准：推荐，速度与稳定性折中。
- 保守：适合触发过风控后使用，速度较慢。

当前摘要 `formatDownloadPolicy` 增加档位：

```text
安全模式 · 标准 · 冷却 60~150s · 每 10 个休息 5~10min
```

不要再写“最优反风控参数”，建议改为：

```text
安全模式会使用更保守的解析节奏，降低连续访问强度。
```

## 四、详情补图策略：保留标签页补采，详情 API 作为观察项

当前安全模式下，解析链路已经是分层的：

1. 首次采集 DOM 图片。
2. 如果详情图不足，先点击“商品详情”标签页。
3. 执行 1-2 次轻量滚动。
4. 二次采集 DOM 图片。
5. 二次采集后仍不足时，才可能调用详情 API。

这条链路里的“点击详情标签页 + 轻量滚动”必须保留。实测中很多商品首次采集详情图不足，需要点击详情标签页后才会渲染详情图。这里不是风控优化的重点，不应为了减少动作而砍掉。

当前详情 API 的逻辑：

```ts
sectionImageUrls.detail.length < 3 && Math.random() < 0.5
```

根据当前测试，详情 API 实际调用次数并不高，因此它暂时不应作为本轮主要优化点。本轮重点仍然是减少额外京东页面访问：

- 去掉解析后的中性页访问。
- 去掉长休期间的隐藏窗口模拟浏览。
- 保留必要的商品页内详情 tab 补采。

### 建议

短期不必强制修改详情 API 逻辑，只做日志观察：

- 记录每个任务首次采集详情图数量。
- 记录点击详情 tab + 轻滚动后二次采集详情图数量。
- 记录详情 API 是否调用、返回长度、是否补到了详情图。
- 如果日志证明详情 API 调用非常少，可以保持现状。

后续如果要按档位细化，可以只作为低优先级调整：

```ts
const shouldFetchDesc =
  skuId &&
  sectionImageUrls.detail.length < 3 &&
  (
    pace === 'conservative' ? false :
    Math.random() < 0.5
  );
```

这里仍然保持“二次 DOM 采集不足后才考虑 API”，不要跳过详情 tab 补采。

相关代码：

- `electron/main.ts`
  - `parseJdProductAssetsWithElectronSession`
  - `fetchJdDescriptionInElectron`

## 五、异常通知改成强提示

### 5.1 当前问题

当前 `showSecurityRiskNotification()` 有 5 分钟节流：

```ts
if (now - lastSecurityRiskNotificationAt < 300_000) return;
```

同时系统通知本身不保证弹出，可能受 Windows 通知设置、勿扰模式、应用焦点影响。

### 5.2 建议

只要出现异常，至少应用内弹窗必须出现。

建议分两层：

1. 系统通知：保留，但仅做 3 秒防抖。
2. 应用弹窗：安全类错误必弹，普通异常也弹一次。

### 5.3 安全类错误弹窗

`securityRisk` / `captcha` / `authExpired`：

```text
标题：京东需要手动验证
内容：京东返回安全验证或账号风险页面，队列已暂停。请打开验证页面手动完成验证或正常浏览当前商品，完成后回到应用重试失败任务。
按钮：打开验证页面 / 稍后处理
```

实现建议：

- 在 `onSecurityRisk` 回调里调用 `showSystemNotification`
- 同时调用 `dialog.showMessageBox`
- 如果用户点“打开验证页面”，直接调用打开验证窗口逻辑

可以抽出函数：

```ts
const showSecurityRiskAlert = async (task?: DownloadTask) => {
  showSystemNotification(...);

  const result = await showAppMessageBox({
    type: 'warning',
    title: '京东需要手动验证',
    message: '京东需要手动验证',
    detail: '京东返回安全验证或账号风险页面，队列已暂停。请打开验证页面手动完成验证或正常浏览当前商品，完成后回到应用重试失败任务。',
    buttons: ['打开验证页面', '稍后处理'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) {
    await openManualVerifyWindow(task?.platform || 'jd', task?.id);
  }
};
```

`openManualVerifyWindow` 可复用现有 `task:open-manual-verify` 内部逻辑，避免 IPC handler 和弹窗按钮重复写窗口创建代码。

### 5.4 普通异常提示

普通失败不一定要阻塞每个任务，否则批量下载时可能打扰。

建议：

- 当队列因为连续失败自动暂停时弹窗。
- 单个普通失败只更新前端状态和系统通知，不弹阻塞框。

如果用户明确要求“只要出现异常就弹”，则可配置：

```ts
notifyEveryFailure: boolean
```

短期可以先做到：

- 安全类错误：每次必弹。
- 自动暂停：必弹。
- 普通单个失败：不弹，只在状态栏展示最后错误。

## 六、总状态栏

### 6.1 目标

当前界面缺少队列级状态。用户需要一眼知道：

- 当前是否运行中。
- 是否正在冷却。
- 是否暂停。
- 是否因风控中断。
- 当前处理到哪里。

### 6.2 状态枚举

建议新增：

```ts
export type QueueRunState =
  | 'idle'
  | 'running'
  | 'cooling'
  | 'paused'
  | 'autoPaused'
  | 'securityBlocked'
  | 'completed'
  | 'failed';
```

### 6.3 后端状态

扩展 `TaskQueue`：

```ts
runState: QueueRunState;
cooldownUntil?: number;
lastErrorMessage?: string;
lastFailureKind?: TaskFailureKind;
currentTaskId?: string;
```

状态变化建议：

- `start()`：如果有 pending，进入 `running`
- `pause()`：进入 `paused`
- 执行任务时：`running`
- 任务间 sleep 前：`cooling`，设置 `cooldownUntil`
- sleep 结束：回到 `running`
- 安全类失败：`securityBlocked`
- 连续失败自动暂停：`autoPaused`
- 全部完成且无失败：`completed`
- 全部结束但有失败：`failed`

### 6.4 IPC 返回

扩展 `task:queue-status`：

```ts
{
  state: QueueRunState;
  autoPaused: boolean;
  consecutiveFailures: number;
  threshold: number;
  counts: {
    total: number;
    pending: number;
    running: number;
    success: number;
    failed: number;
  };
  currentTask?: {
    id: string;
    title?: string;
    skuId?: string;
    sourceUrl: string;
    status: TaskStatus;
  };
  cooldownUntil?: number;
  lastErrorMessage?: string;
  lastFailureKind?: TaskFailureKind;
}
```

### 6.5 前端展示

在任务区上方加总状态栏：

```text
状态：运行中 / 冷却中 / 已暂停 / 风控中断 / 已完成
进度：成功 12 · 失败 1 · 待处理 30
当前：SKU xxxx / 商品标题
冷却：剩余 02:31
```

风控中断时显示操作：

- 打开验证页面
- 我已完成验证，重试失败任务

冷却中显示：

- 剩余时间
- 暂停队列

暂停状态显示：

- 继续下载

### 6.6 前端刷新

当前前端已有定时 `refreshTasks()`。状态栏可以复用这个刷新节奏。

如果要展示冷却倒计时，前端需要每秒更新剩余时间，但不必每秒 IPC：

- IPC 获取 `cooldownUntil`
- 前端本地 `setInterval` 每秒计算剩余秒数

## 七、推荐实施顺序

### 阶段 1：去掉额外访问

改动最小，优先实施。

1. `ParseWindowManager.release()` 改为 `about:blank` 或空操作。
2. `createTaskQueue` 中 `onBrowseCooldown` 改为纯休眠。
3. 保留 `simulateJdBrowse` 但不再调用，方便回滚。
4. 跑 `npm run typecheck`。

### 阶段 2：三档安全模式

1. 新增 `RiskPaceLevel`。
2. 新增三档 preset。
3. 默认使用 `standard`。
4. 前端加入三档选择。
5. 同步策略摘要文案。
6. 确保 `electron/main.ts`、`core/tasks/taskQueue.ts`、`core/tasks/productTaskProcessor.ts` 默认策略一致。

### 阶段 3：详情补图日志观察

1. 保留“详情图不足 -> 点击详情 tab -> 轻滚动 -> 二次采集”的当前逻辑。
2. 增强日志，记录首次采集、二次采集、详情 API 调用次数和补图效果。
3. 先不要把详情 API 收紧作为必做项。
4. 如果后续日志证明 API 调用频繁，再按档位做低优先级调整。

### 阶段 4：强提示

1. 抽出 `openManualVerifyWindow`。
2. `onSecurityRisk` 中同时发系统通知和 `MessageBox`。
3. 取消 5 分钟节流，改为 3 秒防抖。
4. 自动暂停时也弹窗。

### 阶段 5：总状态栏

1. `TaskQueue` 增加 `runState` 等状态字段。
2. 扩展 `task:queue-status`。
3. 前端增加顶部状态栏。
4. 冷却倒计时本地计算。

## 八、验收清单

### 基础

```bash
npm run typecheck
npm run build
```

### 行为验证

1. 安全模式下解析 1 个商品，确认结束后没有再访问京东首页/搜索/频道页。
2. 触发 browse cooldown 时，只打印纯休眠日志，不创建隐藏京东浏览窗口。
3. 三档选择能正确写入新任务的 `downloadPolicy`。
4. 默认安全档位是 `standard`。
5. 风控错误出现时：
   - 队列暂停。
   - 系统通知尝试发送。
   - 应用弹窗一定出现。
   - 可点击打开验证页面。
6. 状态栏能展示：
   - 运行中
   - 冷却中
   - 已暂停
   - 风控中断
   - 已完成/失败

## 九、预期效果

本轮改动的主要收益不是“更像真人”，而是“更少访问京东”。

预期会减少：

- 每个任务结束后的额外京东访问。
- 长休期间的隐藏窗口访问和随机点击。
- 不必要的额外页面行为。
- 用户不知道队列状态或异常原因的情况。

如果改完后仍然高频风控，下一步建议加入“批次手动确认”：

- 标准档每完成 30 个任务自动暂停，用户手动继续。
- 保守档每完成 10-15 个任务自动暂停，用户手动继续。

这种方式比继续自动访问京东更稳。
