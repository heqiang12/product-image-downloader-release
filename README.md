# 商品图片下载助手

面向电商运营的商品图片批量下载桌面工具。当前版本已完成京东商品链接解析、批量下载、登录状态复用、Excel 导入、任务持久化、暂停提示和系统级通知；架构上预留了后续接入更多平台的 `PlatformAdapter`。

## 开发命令

```bash
npm install
npm run dev
```

如果下载任务报错提示 Playwright Chromium 不存在，先执行：

```bash
npm run install:browsers
```

## 账号安全说明

如果京东提示“账号存在安全风险，暂无法在京东网页端使用”，请先停止批量下载，并使用京东商城 APP 完成安全验证。工具只做保守限速和风险页检测，不提供验证码绕过、指纹伪装、代理池规避等对抗平台安全策略的能力。

## 调试解析规则

页面左侧可以点击“添加解析任务”，再点击任务区的“开始解析”。解析任务只打开商品页并统计轮播主图、详情图、SKU 图数量，不下载图片，适合调试分类规则和降低账号风险。

## 验收命令

```bash
npm run accept:stage1
```

```bash
npm run accept:stage2
```

```bash
npm run accept:stage3
```

```bash
npm run accept:stage4
```

```bash
npm run accept:stage4.5
```

```bash
npm run accept:stage5
```

```bash
npm run accept:stage5.5
```

```bash
npm run accept:stage5.6
```

```bash
npm run accept:stage5.7
```

```bash
npm run accept:stage5.8
```

验收内容：

- TypeScript 类型检查。
- 渲染进程构建。
- Electron 主进程构建。
- 核心入口文件和构建产物检查。
- IPC 暴露和调用链静态检查。
- 京东 SKU ID 识别、链接标准化、图片 URL 标准化。
- 京东商品 HTML 快照解析，覆盖主图、详情图、SKU 图和兜底图片。
- 图片下载核心，覆盖分类目录保存、并发下载、失败重试、失败原因记录和 `meta.json`。
- 批量任务队列，覆盖去重、并发控制、状态流转、失败重试、完成清理、IPC 接入和页面进度展示。
- 真实下载闭环，覆盖真实解析器和下载器接入、保存目录选择、打开输出目录和任务进度回填。
- 本地持久化，覆盖保存目录恢复、任务历史恢复、运行中任务重排和队列变更自动保存。
- 平台抽象重构，覆盖 `PlatformAdapter`、平台注册表、京东 adapter、任务平台字段和主进程平台分发。
- 登录中心，覆盖平台登录窗口、持久化 Profile 分区、Cookie 状态检测、登录状态存储和解析 Cookie 注入。
- Excel 导入与模板导出，覆盖 `.xlsx` 解析、无效行识别、重复链接过滤、模板生成、IPC 和页面入口。
- 页面重构，覆盖平台登录区、导入区、任务区、任务详情、日志区和长文本布局保护。
