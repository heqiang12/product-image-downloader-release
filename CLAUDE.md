# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

商品图片批量下载桌面助手，当前支持京东电商平台。Electron 外壳 + Vue 3 渲染界面 + `core/` 平台无关核心逻辑。

## 开发者命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发（Vite 渲染器 + Electron 并发） |
| `npm run build` | 完整构建：typecheck → renderer → electron |
| `npm run typecheck` | TypeScript 类型检查（三个 tsconfig） |
| `npm run build:renderer` | 仅构建 Vue 渲染器 → `dist/` |
| `npm run build:electron` | 仅编译 Electron 主进程 → `dist-electron/` |
| `npm run pack` | 生成目录版打包产物，用于快速验证 |
| `npm run dist:win` | 生成 Windows NSIS 安装包 |

验收脚本：`accept:stage1` ~ `accept:stage5.8`，用 `tsx scripts/accept-stageN.ts` 验证构建产物和 IPC 链。

## 多 tsconfig 编译边界

| tsconfig | 编译范围 | 模块系统 |
|----------|----------|----------|
| `tsconfig.json` | `src/**` | ESNext, noEmit（类型检查） |
| `tsconfig.electron.json` | `electron/**` + `core/**` | CommonJS → `dist-electron/` |
| `tsconfig.core.json` | `core/**` + `scripts/**` | NodeNext（验收脚本用） |

**关键约束：** `core/` 被两个 tsconfig 以不同 module 策略编译，代码不能依赖 DOM 或浏览器 API。

## 架构概要

```
electron/main.ts      → 主进程入口，IPC 注册，窗口创建
electron/preload.ts   → contextBridge 暴露给渲染器
src/                  → Vue 3 渲染器 (App.vue 单文件包含全部 UI, main.ts)
core/                 → 纯 Node/通用核心逻辑，被主进程和脚本共用
  platforms/          → PlatformAdapter 注册表（jd/ 为当前唯一平台）
  parsers/            → 商品解析 (jdParser, jdUrl, assetUrl)
  downloader/         → 并发下载管理器
  tasks/              → TaskQueue + productTaskProcessor
  auth/               → Profile 管理，登录分区
  storage/            → JSON 状态持久化 (app-data/app-state.json)
  importers/          → Excel 导入/模板导出 (xlsx)
  exporters/          → Excel 导出含嵌入图片 (exceljs)
```

### IPC 通道

渲染器只能通过 `preload.ts` 暴露的 `window.jdDownloader` 与主进程通信。所有 handler 注册在 `electron/main.ts`，命名空间：

- `app:` — 版本、更新检查
- `update:` — 下载进度/错误事件
- `settings:` — 输出目录选择
- `auth:` — 登录态管理（profile 分区共享 Cookie）
- `task:` — 任务队列操作（验证链接、添加、启动、暂停、重试等）
- `import:` — Excel 导入链接 / 导出模板
- `export:` — 导出含图片 Excel

### 核心数据结构

- `DownloadTask`: 任务状态 `pending | parsing | downloading | success | failed | paused`
- `ProductAssets`: `{ platform: 'jd', skuId, title, images: { main, detail, sku } }`
- `AssetType`: `'main' | 'detail' | 'sku' | 'unknown'`

## 关键运行约束

1. **京东安全风控**：检测到"账号存在安全风险"页面时解析器会停止任务。安全模式默认并发 2、请求间隔 800ms。不做验证码绕过。
2. **解析方式**：使用 Electron 隐藏窗口共享登录分区（Cookie/localStorage/IndexedDB）。Playwright 仅作开发备用，不进正式安装包。
3. **默认输出路径**：`~/Downloads/product-image-downloader`。
4. **状态持久化**：`app-data/app-state.json`，重启自动恢复。

## 新增平台

在 `core/platforms/jd/` 旁创建 `core/platforms/{name}/`，实现 `PlatformAdapter` 接口（`matchUrl`, `normalizeUrl`, `parseSkuId`, `parseProductAssets`），注册到 `registry.ts`。

## 发布

推版本 tag 触发 GitHub Actions 构建并发布到 GitHub Releases：

```bash
npm version patch
git push
git push --tags
```

构建产物输出到 `release/`。
