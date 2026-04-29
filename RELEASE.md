# 发版与更新操作文档

这份文档用于后续发布“商品图片下载助手”的新版本。当前项目使用 GitHub Actions 自动打包：普通代码提交不会发版，只有推送 `v*` 版本 tag 时，GitHub 才会自动打包 Windows 安装包并更新 GitHub Release。

## 当前发布方式

- 源码仓库：`https://github.com/heqiang12/product-image-downloader-release`
- 更新源：GitHub Releases
- 触发方式：推送版本 tag，例如 `v0.1.1`
- 自动打包配置：`.github/workflows/release.yml`
- 本地打包脚本：`npm run dist:win`
- GitHub 发布脚本：`npm run release:win`

## 日常开发提交

普通功能修改完成后，只提交代码，不发布安装包：

```bash
git status
npm run typecheck
git add .
git commit -m "feat: 修改说明"
git push
```

这种提交只会更新 GitHub 源码，不会触发安装包打包，也不会影响用户电脑上的软件。

## 本地测试打包

在正式发版前，可以先本地打包验证安装包是否正常：

```bash
npm run dist:win
```

打包完成后，文件会生成在：

```text
release/
```

常见文件包括：

```text
release/product-image-downloader-setup-版本号.exe
release/product-image-downloader-setup-版本号.exe.blockmap
release/latest.yml
```

说明：

- `.exe` 是给用户安装的软件安装包。
- `.blockmap` 是增量更新相关文件。
- `latest.yml` 是自动更新识别新版本的关键文件。

本地测试时，可以直接运行生成的 `.exe` 安装包。

## 正式发布新版本

正式发布建议使用 `npm version` 自动修改版本号并创建 tag。

### 1. 确认工作区干净

```bash
git status
```

如果看到：

```text
nothing to commit, working tree clean
```

说明可以继续。

如果有未提交文件，先提交：

```bash
npm run typecheck
git add .
git commit -m "feat: 修改说明"
git push
```

### 2. 升级版本号

补丁版本，例如 `0.1.0` 升到 `0.1.1`：

```bash
npm version patch
```

小版本，例如 `0.1.9` 升到 `0.2.0`：

```bash
npm version minor
```

大版本，例如 `0.9.0` 升到 `1.0.0`：

```bash
npm version major
```

一般日常修复和小功能，用 `patch` 就够了。

执行后，`npm version` 会自动做三件事：

1. 修改 `package.json` 里的版本号。
2. 修改 `package-lock.json` 里的版本号。
3. 创建对应的 Git tag，例如 `v0.1.1`。

### 3. 推送代码和 tag

```bash
git push
git push --tags
```

推送 tag 后，GitHub Actions 会自动开始打包和发布 Release。

## 查看自动打包进度

打开 GitHub 仓库：

```text
https://github.com/heqiang12/product-image-downloader-release
```

进入：

```text
Actions
```

找到最新的 `Release` 工作流。

如果显示绿色对勾，说明打包发布成功。

如果显示红色叉号，点进去查看失败日志。

## 发布成功后检查

打开 Releases 页面：

```text
https://github.com/heqiang12/product-image-downloader-release/releases
```

检查最新版本下是否有这些文件：

```text
latest.yml
product-image-downloader-setup-版本号.exe
product-image-downloader-setup-版本号.exe.blockmap
```

这三个文件都存在，自动更新才完整。

## 用户端更新逻辑

用户电脑上的旧版本软件启动后，会自动检查 GitHub Releases。

例如：

- 用户电脑安装的是 `0.1.0`
- GitHub 最新 Release 是 `0.1.1`

软件会弹窗提示发现新版本，用户点击下载后，软件内自动下载更新包。下载完成后，用户点击立即安装，软件会自动退出并启动安装覆盖旧版本。

如果用户电脑已经是最新版本，不会弹出更新提示。

## 手动上传 Release 的备用方式

正常情况下不需要手动上传。只有 GitHub Actions 暂时不可用时，才使用备用方式。

本地执行：

```bash
npm run dist:win
```

然后在 GitHub Releases 手动新建版本，例如 `v0.1.1`，并上传：

```text
release/latest.yml
release/product-image-downloader-setup-0.1.1.exe
release/product-image-downloader-setup-0.1.1.exe.blockmap
```

注意：Release tag 必须和 `package.json` 版本对应。例如 `package.json` 是 `0.1.1`，Release tag 就用 `v0.1.1`。

## 常见问题

### 推送代码后为什么没有自动打包？

只有推送版本 tag 才会自动打包。普通 `git push` 不会发版。

需要执行：

```bash
npm version patch
git push
git push --tags
```

### GitHub Actions 报版本不一致怎么办？

工作流会检查 tag 和 `package.json` 版本是否一致。

例如：

- tag 是 `v0.1.2`
- `package.json` 版本是 `0.1.1`

这种会失败。

解决方式：确保用 `npm version patch/minor/major` 创建 tag，不要手动乱建 tag。

### 发错 tag 怎么办？

如果 tag 还没被用户使用，可以删除本地和远程 tag：

```bash
git tag -d v0.1.1
git push origin :refs/tags/v0.1.1
```

然后重新执行正确的版本发布流程。

### 想只本地打包，不发布怎么办？

执行：

```bash
npm run dist:win
```

不要推送 tag。

### 想发布但不改功能，只重新发一个版本怎么办？

依然需要升版本号：

```bash
npm version patch
git push
git push --tags
```

自动更新依赖版本号判断，同一个版本重复发布通常不会触发用户更新。

## 推荐发版前检查清单

每次正式发布前，建议确认：

- 软件名称显示正常。
- 登录、导入 Excel、添加任务、开始下载功能可用。
- 暂停队列、系统通知、打开目录功能可用。
- `npm run typecheck` 通过。
- 本地 `npm run dist:win` 能成功生成安装包。
- `package.json` 版本号准备升级。
- GitHub Actions 发布成功后，Release 下有 `.exe`、`.blockmap`、`latest.yml` 三个文件。

