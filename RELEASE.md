# 发版与更新操作文档

本项目的更新源已迁移到**自建 GitLab Releases**（`http://47.114.48.201:9000/tools/product-image-downloader`），采用**手动打包 + 脚本自动上传**的发布方式。用户端更新逻辑为自研方案（见 `core/updater/gitlabUpdater.ts`）。

## 发布方式总览

- 源码仓库：`http://47.114.48.201:9000/tools/product-image-downloader`
- 更新源：GitLab Releases（老用户安装的旧版本无法自动检测到 GitLab，需手动安装一次新版后，后续更新自动走 GitLab）
- 打包方式：**本地手动打包**（`npm run release:win` 一条命令完成打包 + 上传）
- 上传方式：`scripts/gitlab-release.ps1` 自动上传到 GitLab Release（自动建 tag、自动挂资产链接）

## 一、准备：环境要求

- Windows 电脑（打包 Windows 安装包必须在 Windows 环境）
- Node.js 22+
- 已安装项目依赖：`npm install`
- 有 GitLab 访问令牌（需 `api` 权限）：在 GitLab → 偏好设置 → 访问令牌 中生成

## 二、日常开发提交

普通功能修改完成后，只提交代码，不发布安装包：

```bash
git status
npm run typecheck
git add .
git commit -m "feat: 修改说明"
git push origin main
```

这种提交不会影响用户电脑上的软件，不会触发任何打包。

## 三、本地测试打包

正式发版前，可以先本地打包验证：

```bash
npm run dist:win
```

产物生成在 `release/` 目录：

```text
release/product-image-downloader-setup-版本号.exe
release/product-image-downloader-setup-版本号.exe.blockmap
release/latest.yml
```

- `.exe`：给用户安装的安装包
- `.blockmap`：增量更新相关文件（当前自研方案未使用，可忽略）
- `latest.yml`：electron-updater 的版本清单（当前自研方案未使用，可忽略）

本地测试时直接运行生成的 `.exe` 即可。

## 四、正式发布新版本（核心流程）

### 第 1 步：确认工作区干净

```bash
git status
```

如果有未提交改动，先提交再继续。

### 第 2 步：升级版本号

```bash
npm version patch    # 补丁版本 0.1.0 → 0.1.1（日常修复/小功能用这个）
npm version minor    # 小版本 0.1.9 → 0.2.0
npm version major    # 大版本 0.9.0 → 1.0.0
```

`npm version` 会自动：修改 `package.json` 版本号、修改 `package-lock.json`、创建 Git tag（如 `v0.1.5`）。

### 第 3 步：推送代码和 tag

```bash
git push origin main
git push origin --tags
```

> **注意**：tag 必须先推送到 GitLab。`release:win` 脚本会在 GitLab 上查找 tag，找不到会自动创建（指向 main），但推荐先手动推送，保证 tag 指向正确提交。

### 第 4 步：配置令牌（只需一次，永久生效）

发版令牌（`api` 权限）只需配置一次，保存在本地文件 `scripts/.release-token`（已被 `.gitignore` 排除，不会进 Git 仓库）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/set-release-token.ps1
```

按提示粘贴发版令牌，回车即保存。之后所有发版都会自动读取，无需再设置环境变量。

> 换令牌时重新执行上面命令覆盖即可。也可以临时用 `-Token` 参数或 `$env:GITLAB_TOKEN` 覆盖。

### 第 5 步：一键发布

```bash
npm run release:win
```

这条命令自动完成：
1. typecheck + 构建
2. 打包 Windows NSIS 安装包到 `release/`
3. 从 `package.json` 读取版本号，tag 定为 `v{版本号}`
4. 上传安装包到 GitLab Generic Packages（API 路径，客户端带 token 可下载）
5. 创建/更新 GitLab Release
6. 把安装包下载地址挂为 Release 资产链接

### 第 6 步：验证发布结果

打开 GitLab 页面检查：

```text
http://47.114.48.201:9000/tools/product-image-downloader/-/releases
```

确认最新 tag（如 `v0.1.5`）下存在安装包资产链接。

### 第 6 步：分发安装包

- **老用户（0.1.4 及更早，装的是 GitHub 通道版本）**：无法自动检测到 GitLab，需要手动分发一次新安装包。把 `release/*.exe` 通过公司内部渠道（钉钉/企业微信/内部盘）发给用户手动安装一次。
- **已装过新版（含 GitLab 更新逻辑）的用户**：无需任何操作，下次启动自动检测更新。

## 五、用户端更新逻辑（自研）

用户电脑上的应用启动后 3 秒，会：

1. 调 `GET /api/v4/projects/157/releases?per_page=1` 查最新 Release（带 `PRIVATE-TOKEN` header）
2. 取 `tag_name`（如 `v0.1.5`）与本地版本比对
3. 有新版 → 弹窗提示 → 用户点下载 → 从 Generic Packages API 流式下载（带进度，带 token）→ NSIS 静默安装 → 自动重启

如果本地已是最新版本，不弹提示。

**为什么带 token**：项目是私有的（`visibility=private`），匿名访问会被重定向到登录页；Generic Packages API 路径下带 `PRIVATE-TOKEN` header 才能下载安装包（已实测 SHA256 校验一致）。

**复用说明**：其他项目想用这套更新逻辑，拷贝 `core/updater/gitlabUpdater.ts` 一个文件，修改文件顶部的 `GITLAB_UPDATE_CONFIG`（GitLab 地址 + 项目数字 ID + 令牌）即可。注意：Generic Packages API 只接受**数字项目 ID**（path 编码会 400）。

## 六、常见问题

### 推送 tag 后还需要做什么？

本项目**不是** CI 自动打包。推送 tag 只是发布前的版本标记，真正的打包和上传由本地 `npm run release:win` 完成。**两步都要做**：推送 tag → 本地执行 `npm run release:win`。

### 发版时提示找不到安装包？

`release/` 目录下没有 `.exe`。确认 `npm run release:win` 的打包步骤成功执行，或者先单独跑 `npm run dist:win`。

### 提示缺少访问令牌？

没有配置本地令牌。执行一次配置命令即可（永久生效）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/set-release-token.ps1
```

令牌在 GitLab → 偏好设置 → 访问令牌 生成，需勾选 `api` 权限。也可以临时用 `-Token` 参数或 `$env:GITLAB_TOKEN` 覆盖。

### 发错 tag / 版本号怎么办？

删除本地和远程 tag，重新发布：

```bash
git tag -d v0.1.5
git push origin :refs/tags/v0.1.5
```

然后重新执行正式发布流程。

### 重复执行 release:win 会重复上传吗？

不会。脚本是幂等的：tag 存在则复用、Release 存在则更新、资产链接已存在则跳过。

### 用户没有收到更新提示？

1. 确认用户装的是**含 GitLab 更新逻辑的新版**（老版本看不到 GitLab，需手动安装一次）
2. 确认 GitLab Release 页面有对应 tag 和资产链接
3. 确认 tag 版本号（`v0.1.5`）高于用户本地版本（`0.1.4`）
4. 版本号相同时不会触发更新

## 七、发布前检查清单

- [ ] `npm run typecheck` 通过
- [ ] 功能验证正常（登录、导入 Excel、添加任务、开始下载、暂停队列、打开目录）
- [ ] `package.json` 版本号已升级（`npm version patch/minor/major`）
- [ ] 代码和 tag 已推送到 GitLab（`git push origin main --tags`）
- [ ] 已配置本地发版令牌（`scripts/set-release-token.ps1` 执行过一次）
- [ ] `npm run release:win` 打包上传成功
- [ ] GitLab Releases 页面能看到新 tag 和安装包资产链接
- [ ] 老用户手动安装包已分发（首次迁移需要）
