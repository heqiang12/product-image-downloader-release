# 京东批量下载反风控优化方案

本方案旨在解决批量下载京东商品图片时触发京东风控的问题。通过将反风控参数融入现有的 `DownloadPolicy`（下载策略）体系，实现在安全模式下自动应用保守的、接近真人浏览行为的节奏控制，同时为自定义模式提供高级的反风控精细化配置。

---

## 1. 核心设计：将反风控参数融入 DownloadPolicy 体系

### 1.1 扩展后的 DownloadPolicy 接口定义

在 `core/tasks/types.ts` 和前端的类型定义中，我们将 `DownloadPolicy` 扩展为如下结构：

```typescript
export interface DownloadPolicy {
  safeMode: boolean;
  imageConcurrency: number;     // 图片下载并发数
  requestDelayMs: number;       // 单张图片请求间隔 (毫秒)
  
  // ── 以下为新增的反风控参数 ──
  taskCooldownMin: number;      // 任务间最小冷却时间 (秒)
  taskCooldownMax: number;      // 任务间最大冷却时间 (秒)
  browsePauseMin: number;       // 模拟浏览/长休最短时长 (秒)
  browsePauseMax: number;       // 模拟浏览/长休最长时长 (秒)
  browseInterval: number;       // 每隔多少个任务触发一次模拟浏览/长休
  enablePrewarm: boolean;       // 解析前是否先进行首页预热导航
}
```

### 1.2 预设值与策略对比

| 参数 | 安全模式 (Safe Mode) | 自定义模式默认值 (Custom Mode) | 参数说明 |
| :--- | :---: | :---: | :--- |
| `imageConcurrency` | **2** | 5 | 单个商品的图片多线程下载并发数 |
| `requestDelayMs` | **800** | 0 | 单个商品的图片下载请求间隔 (毫秒) |
| `taskCooldownMin` | **20** | 5 | 商品任务与任务之间的最短随机等待时间 (秒) |
| `taskCooldownMax` | **50** | 15 | 商品任务与任务之间的最长随机等待时间 (秒) |
| `browsePauseMin` | **60** | 15 | 模拟浏览或长休的随机最短休息时间 (秒) |
| `browsePauseMax` | **180** | 45 | 模拟浏览或长休的随机最长休息时间 (秒) |
| `browseInterval` | **5** | 10 | 每成功解析 N 个商品，触发一次模拟浏览/长休 |
| `enablePrewarm` | **true** | false | 解析商品详情页前，是否先访问京东首页以生成Referer链 |

### 1.3 运行时间估算 (安全模式，以 50 个商品为例)

* **任务间冷却时间**：平均 35 秒 × 50 ≈ 29 分钟
* **模拟浏览长休时间**：触发约 10 次，每次平均 120 秒 ≈ 20 分钟
* **正常解析与图片下载**：每个商品约 15 秒 × 50 ≈ 12.5 分钟
* **总计预计耗时**：**45 ~ 70 分钟**

---

## 2. 实施路线图

### 阶段 1：智能节奏控制与 Policy 驱动

1. **类型扩展**：
   * 修改 `core/tasks/types.ts` 和 `src/types/electron.d.ts` 中的 `DownloadPolicy`。
2. **重构 TaskQueue 的冷却逻辑**：
   * 移除 `TaskQueue` 中硬编码的 3~8 秒冷却，改为通过当前执行任务的 `DownloadPolicy` 动态计算 `taskCooldownMin` 到 `taskCooldownMax` 之间的随机延迟。
   * 将原先固定 `[3, 7]` 的模拟浏览触发间隔，改为读取 Policy 中的 `browseInterval`。
3. **实现首页预热导航**：
   * 在主进程 `parseJdProductAssetsWithElectronSession` 解析逻辑中，如果 `enablePrewarm` 为真，则在 `loadURL(商品页)` 之前有 70% 的概率先调用 `loadURL('https://www.jd.com/')` 并随机停留 2~4 秒，以此模拟真实用户的Referer访问轨迹。
4. **模拟浏览休息时间可配化**：
   * 传递 Policy 的 `browsePauseMin` 和 `browsePauseMax` 至主进程中的 `simulateJdBrowse`，动态控制随机休息和模拟滚动时长。
5. **UI 高级反风控设置面板**：
   * 在前端 `App.vue` 策略区新增一个折叠的 **“高级反风控设置”** 区域。
   * 安全模式下，新参数锁定为保守的系统预设值，并显示锁定提示；自定义模式下，用户可自由输入或滑动调节以上 6 个参数。

### 阶段 2：浏览器指纹强化 (Stealth & Fingerprint)

1. **随机 User-Agent 池**：
   * 新建 `core/utils/userAgents.ts` 库，收录 10+ 条主流且真实的 PC 端 Chrome/Edge 浏览器 User-Agent 字符串。
   * 在 Electron 解析窗口的 `session.setUserAgent`、模拟浏览窗口、以及核心图片下载器 `downloadOneAsset` 的 Request Headers 中，每次调用均随机挑选不同的 UA。
2. **随机 Viewport 尺寸**：
   * 解析窗口不再固定 1280x900 分辨率，每次随机使用常见屏幕比例尺寸（如 1366x768、1440x900、1920x1080 等），使窗口指纹更加随机。
3. **增强 Stealth 脚本**：
   * 扩充 `injectStealthScripts` 脚本，不仅覆盖 `navigator.webdriver` 移除，还注入对 `navigator.plugins`、`window.chrome` 以及 `navigator.languages` (强制补全为 `['zh-CN', 'zh', 'en']`) 的伪造逻辑。

---

## 3. 阶段 3：解析窗口复用 (未来规划 - 暂缓实施)

> [!NOTE]
> 该阶段改动相对较大，具有一定状态残留风险。在阶段 1 和阶段 2 上线并完全解决风控问题后，如无迫切性能优化需要，此阶段暂缓实施。

### 3.1 设计思路
* **避免频繁创建与销毁窗口**：在主进程维护一个持久的 `ParseWindowManager` 全局单例，首次解析时创建 `BrowserWindow`，后续任务复用同一窗口，仅通过 `loadURL` 切换商品页。
* **清理上下文**：每次切换商品前，通过 `webContents.executeJavaScript` 清除前一个页面的全局残留变量、SessionStorage 以及临时状态。
* **定期自动回收**：每解析 20 ~ 30 个商品后，销毁当前窗口并创建新窗口，以规避潜在的内存泄露和长周期指纹累积。

### 3.2 预期收益
* 极大减少由于反复创建/销毁 BrowserWindow 导致的 CDN/WAF 异常网络连接建立检测。
* 在京东的服务端统计中表现为“单标签页内的连续商品浏览”，行为更合理。
