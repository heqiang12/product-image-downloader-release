# 京东解析阶段风控优化与手动兜底方案

本文档针对当前项目中京东商品解析阶段触发风控的问题，整理一套更贴近现有代码的优化方案。

核心判断：

- 图片下载阶段目前不携带京东登录 Cookie，主要请求图片 CDN，实际触发风控的概率较低。
- 当前问题集中在解析阶段，也就是 Electron 登录分区内访问京东商品页、采集 DOM、点击详情、滚动、调用详情接口等行为。
- 单纯拉长时间有帮助，但收益有限。更稳的方向是减少不必要动作、按需补动作、疑似风控时立即暂停，并提供用户手动验证入口。

## 当前实现概览

当前项目已经具备一套基础保护：

- `electron/main.ts`
  - `DEFAULT_DOWNLOAD_POLICY` 定义安全模式默认策略。
  - `parseJdProductAssetsWithElectronSession` 使用同登录分区的隐藏窗口解析京东页面。
  - `ParseWindowManager` 复用解析窗口，并定期回收。
  - `injectStealthScripts` 覆盖部分浏览器自动化指纹。
  - `assertNoJdSecurityRiskInElectron` 识别京东安全风险页。
  - `simulateRandomInteractions` 执行滚动、点击详情、点击评论、停留阅读等随机交互。
  - `fetchJdDescriptionInElectron` 调用京东详情接口补充详情图。
- `core/tasks/taskQueue.ts`
  - 任务串行执行。
  - 任务间随机冷却。
  - 每完成一定数量任务后触发模拟浏览或长休。
  - 连续失败达到阈值后自动暂停。
- `src/App.vue`
  - 安全模式与自定义模式配置。
  - 高级反风控参数面板。
  - 连续失败自动暂停提示。

这些能力说明项目已经有基础防护。后续优化不应继续堆更多“模拟动作”，而应把默认行为改得更轻、更少、更按需。

## 目标策略

目标不是绕过京东验证，而是降低误触发概率，并在京东要求验证时给用户一条顺畅的官方手动处理路径。

建议遵循四个原则：

1. 少动作优先：先用最少页面行为完成解析，缺图时再补动作。
2. 少接口优先：详情 API 仅在 DOM 采集不足时调用。
3. 一次风控即暂停：疑似安全验证、账号风险、登录失效时，不等待连续 3 次失败。
4. 手动兜底：打开同登录分区的可见京东窗口，让用户自己完成验证或正常浏览商品页。

## 方案一：解析流程改为分层解析

当前解析流程偏重，基本每个商品都会执行一组随机交互。建议改成分层流程。

### 建议流程

1. 打开商品页。
2. 等待首屏自然加载，安全模式下等待 6-12 秒。
3. 第一次采集 DOM 图片：
   - 主图
   - SKU 图
   - 已渲染详情图
4. 判断采集结果是否足够：
   - 主图数量大于 0，并且详情图数量达到阈值，例如 3 张以上，则直接解析完成。
   - 如果详情图不足，再执行补充动作。
5. 补充动作按需执行：
   - 点击“商品详情” tab。
   - 轻量滚动 1-2 屏。
   - 再次采集 DOM 图片。
6. 如果详情图仍不足，再考虑调用详情 API。
7. 解析完成后导航到中性页面或释放窗口。

### 对应代码位置

- 主要修改：`electron/main.ts` 的 `parseJdProductAssetsWithElectronSession`
- 可拆辅助函数：
  - `collectJdSectionImageUrlsInElectron`
  - `openJdDetailTabInElectron`
  - `autoScrollElectronPage`
  - `simulateRandomInteractions`

### 建议调整

- 安全模式下不默认调用 `simulateRandomInteractions`。
- 将 `simulateRandomInteractions` 改为 fallback，而不是主路径。
- 新增轻量滚动函数，例如 `lightScrollElectronPage`，只滚动 1-2 次并短暂停留。
- 对采集结果做简单判定：

```ts
const hasEnoughImages = (sectionImageUrls: JdSectionImageUrls) =>
  sectionImageUrls.main.length > 0 && sectionImageUrls.detail.length >= 3;
```

阈值可以后续通过实际商品样本调整。

## 方案二：详情 API 改为按需调用

当前代码中详情 API 有较高调用概率。建议改为：

- DOM 详情图足够：不调用。
- DOM 详情图不足：再调用。
- 安全模式下可再加概率控制，例如 50%。
- 自定义模式可以允许用户配置是否总是补详情 API，但默认不要总是调用。

### 建议规则

```ts
const shouldFetchDescription =
  skuId &&
  sectionImageUrls.detail.length < 3 &&
  (!downloadPolicy?.safeMode || Math.random() < 0.5);
```

这样可以减少额外接口请求，也能避免每个商品都形成固定的“商品页 + 详情接口”行为组合。

## 方案三：安全模式节奏调慢，但不只靠慢

单纯拉长间隔有帮助，但不是万能。建议把安全模式默认值调得更保守，同时减少动作。

### 建议安全模式参数

```ts
const DEFAULT_DOWNLOAD_POLICY: DownloadPolicy = {
  safeMode: true,
  imageConcurrency: 2,
  requestDelayMs: 800,
  taskCooldownMin: 90,
  taskCooldownMax: 240,
  browsePauseMin: 480,
  browsePauseMax: 900,
  browseInterval: 5,
  enablePrewarm: false,
};
```

说明：

- `taskCooldownMin/Max` 从 20-50 秒提高到 90-240 秒。
- `browsePauseMin/Max` 从 60-180 秒提高到 8-15 分钟。
- `enablePrewarm` 建议默认关闭，或改成内部随机预热，不要每个商品都预热。

### 预热策略

预热不是越多越好。每个商品解析前都预热，可能形成新的固定模式。

建议改成：

- 安全模式下默认不预热。
- 每隔一批任务随机预热。
- 或者仅当连续解析多个商品后，下一次任务前有 20%-30% 概率进入首页、频道页、搜索页短暂停留。

## 方案四：错误分类与一次风控暂停

当前 `TaskQueue` 用连续失败次数判断是否自动暂停。建议新增错误分类，让安全风险类错误一次就暂停。

### 建议新增类型

在 `core/tasks/types.ts` 中扩展任务错误信息：

```ts
export type TaskFailureKind =
  | 'securityRisk'
  | 'captcha'
  | 'authExpired'
  | 'parseEmpty'
  | 'network'
  | 'download'
  | 'unknown';

export interface DownloadTask {
  // existing fields...
  failureKind?: TaskFailureKind;
}
```

`TaskPatch` 也需要允许更新 `failureKind`。

### 错误识别建议

在 `electron/main.ts` 中定义专门错误类：

```ts
class JdSecurityRiskError extends Error {
  readonly failureKind = 'securityRisk';
}

class JdCaptchaRequiredError extends Error {
  readonly failureKind = 'captcha';
}
```

`assertNoJdSecurityRiskInElectron` 命中风险页时抛出 `JdSecurityRiskError`。

当 `loadURL` 命中 `risk_handler`、`cfe.m.jd.com` 等风险地址时抛出 `JdCaptchaRequiredError`。

### 队列行为

在 `TaskQueue.runTask().catch()` 中：

- 如果 `failureKind` 是 `securityRisk`、`captcha`、`authExpired`：
  - 当前任务失败。
  - 队列立即暂停。
  - `autoPaused = true`。
  - 不等待连续失败达到 3 次。
- 其他失败继续沿用连续失败阈值。

## 方案五：手动验证兜底

用户提出的手动兜底非常适合当前项目。它能解决“已经进入验证态”的恢复问题，并且不做验证码绕过。

### 交互目标

当出现一次疑似风控：

1. 队列立即暂停。
2. 系统通知用户。
3. 主界面展示弹窗或醒目提示。
4. 用户点击“打开验证页面”。
5. 应用打开一个可见的京东窗口，使用同一个登录分区。
6. 用户在京东页面中手动完成验证、登录恢复，或正常浏览当前商品。
7. 用户回到应用点击“我已完成验证，重试失败任务”。

### IPC 建议

新增 IPC：

```ts
task:open-manual-verify
```

入参：

```ts
{
  platformId: string;
  taskId?: string;
  url?: string;
}
```

行为：

- 优先打开失败任务的 `sourceUrl`。
- 如果没有任务 URL，打开平台首页或登录页。
- 使用 `authProfileManager.getPartition(platformId)`。
- 窗口必须 `show: true`。
- 注入同样的 `injectStealthScripts` 可以保留，但不要自动点击验证。

伪代码：

```ts
ipcMain.handle('task:open-manual-verify', async (_event, platformId, taskId) => {
  const task = taskId ? taskQueue.getTask(taskId) : undefined;
  const platform = platformAdapters.find((item) => item.id === platformId);
  const targetUrl = task?.sourceUrl || platform?.homeUrl || platform?.loginUrl;

  const verifyWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: '京东手动验证',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: authProfileManager.getPartition(platformId),
    },
  });

  injectStealthScripts(verifyWindow);
  await verifyWindow.loadURL(targetUrl);

  return { ok: true };
});
```

### 前端建议

在 `src/App.vue` 中增加：

- 风控暂停提示状态。
- “打开验证页面”按钮。
- “我已完成验证，重试失败任务”按钮，复用现有 `retryFailed`。

提示文案：

> 京东返回安全验证或账号风险页面，队列已暂停。请在打开的京东页面中手动完成验证或正常浏览当前商品，完成后返回应用重试失败任务。

### 系统通知

当前主进程已有队列通知相关逻辑。建议新增风控专项通知：

- 标题：`京东需要手动验证`
- 正文：`队列已暂停，请打开验证页面完成京东安全验证后重试。`
- 节流：同类通知 5 分钟内只发一次，避免打扰。

## 建议实施顺序

### 第一阶段：用户兜底闭环

优先做这部分，因为它能直接解决用户卡住的问题。

1. 新增错误分类。
2. 京东安全风险错误一次触发自动暂停。
3. 新增 `task:open-manual-verify` IPC。
4. 前端增加“打开验证页面”和“重试失败任务”入口。
5. 增加系统通知。

### 第二阶段：解析动作减量

1. 将 `simulateRandomInteractions` 从默认路径移到 fallback。
2. 新增轻量采集流程。
3. 详情图不足时再点击详情 tab 和轻滚动。
4. 详情图仍不足时再调用详情 API。

### 第三阶段：安全模式参数调整

1. 同步调整三处默认策略：
   - `electron/main.ts`
   - `core/tasks/taskQueue.ts`
   - `core/tasks/productTaskProcessor.ts`
   - `src/App.vue`
2. 更新 `src/types/electron.d.ts` 中相关说明。
3. 调整 UI 文案，避免承诺“最优反风控参数”，改成“更保守的解析节奏”。

### 第四阶段：观察与微调

1. 记录解析失败类型统计。
2. 记录是否命中手动验证入口。
3. 根据真实样本调整：
   - 详情图足够阈值。
   - 安全模式停留时长。
   - 详情 API 调用概率。
   - 长休间隔。

## 验收建议

基础验证：

```bash
npm run typecheck
npm run build
```

功能验证：

1. 添加 1 个京东商品，确认正常解析。
2. 使用只解析模式，确认少动作路径能拿到主图和详情图。
3. 人为构造 `JdSecurityRiskError`，确认队列一次失败即暂停。
4. 点击“打开验证页面”，确认窗口使用京东登录分区，并能打开失败任务 URL。
5. 手动关闭验证窗口后，点击“重试失败任务”，确认队列可继续。

## 风险与边界

- 本方案不做验证码绕过，不模拟用户完成安全验证。
- 手动验证窗口只是把用户带到京东官方页面，由用户自行操作。
- 更长时间间隔会显著降低批量处理速度，需要在 UI 上明确提示。
- 解析动作减量可能导致少数商品详情图第一次采集不足，因此需要 fallback 补动作。
- 详情 API 降频可能降低部分 SPA 商品详情图的召回率，需要用实际商品样本验证阈值。

## 推荐结论

优先实现“风控一次暂停 + 手动验证窗口”。这能把最痛的失败路径变成可恢复路径。

随后再做“少动作优先 + 详情 API 按需调用”。这部分能降低触发概率。

最后再调整安全模式参数。拉长时间有帮助，但应该作为辅助策略，而不是唯一策略。
