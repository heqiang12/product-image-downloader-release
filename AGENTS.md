# AGENTS.md — product-image-downloader

## 项目定位
商品图片批量下载桌面助手，当前支持京东。Electron 外壳 + Vue 3 渲染界面 + 核心逻辑在 `core/` 目录（平台无关，双端复用）。

## 开发者命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发（Vite 渲染器 + Electron 并发） |
| `npm run install:browsers` | 安装 Playwright Chromium（首次必做） |
| `npm run build` | 完整构建：typecheck → renderer → electron |
| `npm run typecheck` | TypeScript 类型检查（三个 tsconfig） |
| `npm run build:renderer` | 仅构建 Vue 渲染器 → `dist/` |
| `npm run build:electron` | 仅编译 Electron 主进程 → `dist-electron/` |

### 验收脚本（按阶段递增）
`accept:stage1` ~ `accept:stage5.8`，用 `tsx scripts/accept-stageN.ts` 验证构建产物和 IPC 链。

## 多 tsconfig 编译边界

| tsconfig | 编译范围 | 目标 |
|----------|----------|------|
| `tsconfig.json` | `src/**` | 渲染器 (Vue)，ESNext, noEmit |
| `tsconfig.electron.json` | `electron/**` + `core/**` | 主进程，CommonJS → `dist-electron/` |
| `tsconfig.core.json` | `core/**` + `scripts/**` | 核心库+脚本，NodeNext，验收脚本用 |

**关键：** `core/` 被 `tsconfig.electron.json` 和 `tsconfig.core.json` 同时包含，但 module 策略不同（CommonJS vs NodeNext）。在 `core/` 中写的代码不能依赖 DOM 或浏览器 API。

## 架构概要

```
electron/main.ts      → 主进程入口，IPC 注册，窗口创建
electron/preload.ts   → contextBridge 暴露给渲染器
src/                  → Vue 3 渲染器 (App.vue, main.ts)
core/                 → 纯 Node/通用核心逻辑，被主进程和脚本共用
  platforms/          → PlatformAdapter 注册表，jd/ 子目录为京东 adapter
  parsers/            → 商品解析 (jdParser, jdUrl, assetUrl)
  downloader/         → 并发下载管理器，文件写入
  tasks/              → 任务队列 (TaskQueue + productTaskProcessor)
  auth/               → Profile 管理，登录分区
  storage/            → JSON 状态持久化 (app-state.json)
  importers/          → Excel 导入/模板导出 (xlsx)
  utils/              → URL/文件名工具
scripts/              → 验收脚本，仅被 accept:* 命令调用
```

### IPC 调用规范
渲染器只能通过 `preload.ts` 暴露的通道调用主进程。主进程 handler 注册集中在 `electron/main.ts`，以 `app:` / `settings:` / `auth:` / `task:` / `import:` 为命名空间前缀。

## 运行环境关键点

1. **Playwright Chromium**：`npm run install:browsers` 首次必做。缺失时任务失败报 `Executable doesn't exist`。
2. **京东安全风控**：检测到"账号存在安全风险"页面时解析器会停止任务，不做验证码绕过。页面提供"安全模式"开关（图片并发 2，请求间隔 800ms）。
3. **解析入口**：京东解析使用 Electron 同登录分区的隐藏窗口（共享 Cookie/localStorage/IndexedDB），Playwright 仅作备用。
4. **默认输出路径**：`~/Downloads/product-image-downloader`。
5. **状态持久化**：`app-data/app-state.json`，保存任务队列 + 登录状态摘要。重启后自动恢复。

## 核心数据结构

- `DownloadTask`：任务状态 `pending | parsing | downloading | success | failed | paused`
- `ProductAssets`：`{ platform: 'jd', skuId, title, images: { main, detail, sku } }`
- `AssetType`：`'main' | 'detail' | 'sku' | 'unknown'`

新增平台：在 `core/platforms/jd/` 旁创建 `core/platforms/{name}/`，实现 `PlatformAdapter` 接口，注册到 `registry.ts`。

## 验证顺序
修改后建议：`npm run typecheck` → `npm run build` → 对应 `npm run accept:stageN`
