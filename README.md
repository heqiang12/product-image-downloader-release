# 商品图片下载助手

商品图片下载助手是一款面向电商运营的桌面工具，用于批量解析商品链接并下载商品图片。当前版本已支持京东商品图片下载，架构上预留了多平台扩展能力，后续可以继续接入其它电商平台。

## 主要功能

- 京东商品链接批量解析。
- 支持轮播主图、详情图、SKU 图分类下载。
- 支持手动输入链接和 Excel 导入任务。
- 支持登录状态复用，降低重复登录成本。
- 支持任务队列、进度展示、失败重试和完成清理。
- 支持暂停未开始任务，并通过系统通知提示队列状态。
- 支持保存目录选择、打开输出目录和任务状态持久化。
- 支持 GitHub Releases 在线更新。

## 技术栈

- Electron
- Vue 3
- TypeScript
- Vite
- electron-builder
- electron-updater

## 环境要求

建议使用：

- Node.js 22 或更高版本
- npm
- Windows 10/11

## 本地开发

安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

开发模式会同时启动 Vite 渲染进程和 Electron 主进程。

## 常用命令

类型检查：

```bash
npm run typecheck
```

完整构建：

```bash
npm run build
```

生成未安装的目录版：

```bash
npm run pack
```

生成 Windows 安装包：

```bash
npm run dist:win
```

构建产物默认输出到：

```text
release/
```

## 发布与在线更新

项目已配置 GitHub Actions。普通代码提交不会发布安装包，只有推送版本 tag 时才会自动打包并发布 GitHub Release。

日常发版命令：

```bash
npm version patch
git push
git push --tags
```

发布成功后，旧版本客户端会从 GitHub Releases 检测新版本，并提示用户下载和安装。

完整操作说明见：

- [RELEASE.md](RELEASE.md)

## 项目结构

```text
core/                 核心业务逻辑
electron/             Electron 主进程和预加载脚本
src/                  Vue 渲染进程
build/                应用图标等打包资源
scripts/              辅助脚本
tests/                测试夹具和测试相关文件
.github/workflows/    GitHub Actions 配置
```

## 账号安全说明

如果京东提示“账号存在安全风险，暂无法在京东网页端使用”，请先停止批量下载，并使用京东商城 APP 完成安全验证。

本工具只做正常的登录态复用、保守限速和风险页检测，不提供验证码绕过、指纹伪装、代理池规避等对抗平台安全策略的能力。

## 调试解析规则

页面左侧可以添加解析任务，再在任务区开始解析。解析任务只打开商品页并统计轮播主图、详情图、SKU 图数量，不下载图片，适合调试分类规则和检查页面结构变化。

## 备注

- `release/`、`dist/`、`dist-electron/`、`node_modules/` 不会提交到 Git。
- 当前 Windows 安装包文件名格式为 `product-image-downloader-setup-版本号.exe`。
- 自动更新依赖 Release 中的 `latest.yml`、安装包和 `.blockmap` 文件。
