# GitLab 更新模块技术文档（可复用）

> 本文档介绍 `core/updater/gitlabUpdater.ts` 的设计与使用方法，供其他 Electron 项目复用。

## 1. 模块定位

**GitLab 更新模块**是一个平台无关的 TypeScript 模块，为 Electron 桌面应用提供"从自建 GitLab 检查新版本并下载安装包"的能力。

- **单文件**：整个更新逻辑只有一个文件 `core/updater/gitlabUpdater.ts`
- **零依赖**：仅使用全局 `fetch`（Node 18+/Electron 主进程原生支持）和 `node:fs/promises`
- **平台无关**：不依赖 DOM / 浏览器 API，可在 Electron 主进程、Node 脚本、验收脚本中复用

### 核心能力

| 能力 | 说明 |
|------|------|
| 版本检查 | 查询 GitLab 最新 Release，解析版本号 |
| 版本比较 | 语义化版本号比较（如 `1.2.10` > `1.2.9`） |
| 安装包下载 | 流式下载安装包到本地，带进度回调 |
| 私有项目支持 | 带 `PRIVATE-TOKEN` 认证访问私有仓库 |

---

## 2. 为什么自研（背景）

Electron 生态标准的更新方案是 `electron-updater`，它从 6.6 版本起提供了 GitLab provider。但在**自建 GitLab 13.x + HTTP 协议**环境下，官方方案存在两个硬性限制（经源码与实测确认）：

| 限制 | 详情 | 影响 |
|------|------|------|
| **强制 HTTPS** | 官方 provider 源码写死 `https://${host}/api/v4` | HTTP 自建 GitLab 无法使用 |
| **依赖 GitLab 14.3+** | 使用 `GET /projects/:id/releases/permalink/latest` 接口 | GitLab 13.x 无此接口（404） |

此外，私有项目下 GitLab 的 **uploads 文件路径**（`/namespace/project/uploads/...`）下载时会 302 重定向到登录页，`PRIVATE-TOKEN` header 不生效，客户端无法匿名下载。

因此自研方案**绕开 uploads，改用 Generic Packages API 路径**（该路径支持 `PRIVATE-TOKEN` header，实测 SHA256 校验一致）。

---

## 3. 工作原理

```
┌────────────────────────────────────────────────────────────┐
│                   自建 GitLab (例如)                        │
│  http://gitlab.example.com:9000/api/v4                     │
│                                                            │
│  GET /projects/:id/releases?per_page=1                     │
│    └─ 返回最新 Release（tag_name + 资产链接）                │
│                                                            │
│  GET /projects/:id/packages/generic/:pkg/:ver/:file        │
│    └─ 返回安装包文件内容（需 PRIVATE-TOKEN）                 │
└────────────────────────────────────────────────────────────┘
        ▲ ① 查询最新版本（带 token）          ▲ ③ 下载安装包（带 token）
        │                                     │
┌───────┴─────────────────────────────────────┴───────────────┐
│  Electron 主进程                                           │
│                                                            │
│  ② compareVersions(latest, current) ≤ 0 → 已是最新，结束    │
│  ② 有新版本 → 提示用户 → ③ 下载 → 静默安装 → 重启           │
└────────────────────────────────────────────────────────────┘
```

**一次完整更新流程**：
1. 应用启动（或手动触发）调用 `getLatestReleaseInfo()`
2. 模块请求 GitLab Releases API，取最新 Release 的 `tag_name`（如 `v1.2.3`）和安装包下载链接
3. 调用方用 `compareVersions()` 与本地版本比对
4. 有新版本则提示用户，确认后调用 `downloadFile()` 流式下载（带进度）
5. 下载完成后调用方执行静默安装并重启

---

## 4. 文件与导出 API

### 4.1 配置类型 `GitlabUpdaterConfig`

```ts
export interface GitlabUpdaterConfig {
  /** GitLab API 根地址，如 http://47.114.48.201:9000/api/v4 */
  apiBase: string;
  /** 项目 ID（数字）或 path，如 157 或 tools/product-image-downloader */
  project: string;
  /** 访问令牌（api 权限），私有项目必需 */
  token: string;
  /** 安装包文件名匹配模式（正则），默认 /.exe$/i */
  installerPattern?: RegExp;
}
```

> ⚠️ **重要**：Generic Packages API 只接受**数字项目 ID**（path 编码会返回 400），本项目固定使用数字 ID。获取方式：GitLab 项目主页 URL 中的数字，或 `GET /api/v4/projects/:path` 响应的 `id` 字段。

### 4.2 默认配置 `GITLAB_UPDATE_CONFIG`

```ts
export const GITLAB_UPDATE_CONFIG: GitlabUpdaterConfig = {
  apiBase: 'http://47.114.48.201:9000/api/v4',
  project: '157',
  token: '你的访问令牌',
};
```

**复用新项目时只需修改此对象**（见第 5 节）。

### 4.3 返回类型 `GitlabReleaseInfo`

```ts
export interface GitlabReleaseInfo {
  version: string;      // 去掉 v 前缀的版本号，如 "1.2.3"
  installerUrl: string; // 安装包下载地址（Generic Packages API 路径）
}
```

### 4.4 `getLatestReleaseInfo(config?)`

查询最新 Release。

```ts
const getLatestReleaseInfo = async (
  config: GitlabUpdaterConfig = GITLAB_UPDATE_CONFIG,
): Promise<GitlabReleaseInfo>
```

- **行为**：请求 `GET /api/v4/projects/:id/releases?per_page=1`，取列表第一项（GitLab 按发布时间倒序），从资产链接中按 `installerPattern` 匹配安装包
- **返回值**：`{ version, installerUrl }`
- **抛错场景**：
  - GitLab 请求失败（网络/HTTP 非 2xx）
  - 没有任何 Release
  - 最新 Release 资产中没有匹配 `installerPattern` 的安装包
- **使用示例**：

```ts
import { getLatestReleaseInfo } from './core/updater/gitlabUpdater';

const { version, installerUrl } = await getLatestReleaseInfo();
console.log(`最新版本: ${version}`);
console.log(`下载地址: ${installerUrl}`);
```

### 4.5 `compareVersions(a, b)`

比较两个版本号。

```ts
const compareVersions = (a: string, b: string): number
```

- 规则：按 `.` 分段逐段比较数字，`1.2.10` > `1.2.9`（正确的语义化比较，非字符串比较）
- 返回值：`a > b` 返回正数，`a < b` 返回负数，相等返回 0
- 支持不同长度：`1.2` 与 `1.2.0` 视为相等
- **使用示例**：

```ts
import { compareVersions } from './core/updater/gitlabUpdater';

const latest = '1.2.3';
const current = '1.2.2';
if (compareVersions(latest, current) > 0) {
  console.log('发现新版本');
}
```

### 4.6 `downloadFile(url, targetPath, onProgress?, token?)`

流式下载文件到本地。

```ts
const downloadFile = async (
  url: string,
  targetPath: string,
  onProgress?: (received: number, total: number) => void,
  token?: string,
): Promise<string>
```

- **url**：安装包下载地址（`installerUrl`）
- **targetPath**：保存到本地的完整路径（含文件名）
- **onProgress**：进度回调，参数为 `(已下载字节数, 总字节数)`；`total` 为 0 表示服务器未返回 Content-Length（未知总量）
- **token**：访问令牌，私有项目下载必须传入（会被作为 `PRIVATE-TOKEN` header）
- **返回值**：Promise 解析为保存路径 `targetPath`
- **抛错场景**：下载请求失败（HTTP 非 2xx）
- **使用示例**：

```ts
import path from 'node:path';
import { downloadFile } from './core/updater/gitlabUpdater';

const target = path.join(app.getPath('temp'), `app-setup-${version}.exe`);
await downloadFile(installerUrl, target, (received, total) => {
  if (total > 0) {
    console.log(`进度: ${Math.round((received / total) * 100)}%`);
  }
}, token);
```

---

## 5. 在其他项目复用（完整步骤）

### 5.1 复制文件

将 `core/updater/gitlabUpdater.ts` 复制到新项目，建议保持相同路径：

```text
新项目/
└── core/
    └── updater/
        └── gitlabUpdater.ts
```

### 5.2 修改配置

编辑文件顶部的 `GITLAB_UPDATE_CONFIG`：

```ts
export const GITLAB_UPDATE_CONFIG: GitlabUpdaterConfig = {
  apiBase: 'http://你的GitLab地址:端口/api/v4',
  project: '你的项目数字ID',   // ⚠️ 必须数字 ID，不是项目名
  token: '你的访问令牌',        // api 权限
};
```

### 5.3 在 Electron 主进程接入

在主进程（如 `electron/main.ts`）中：

```ts
import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  compareVersions,
  downloadFile,
  GITLAB_UPDATE_CONFIG,
  getLatestReleaseInfo,
} from './core/updater/gitlabUpdater';

const checkForUpdates = async () => {
  if (!app.isPackaged) return; // 开发环境不检查

  try {
    const { version: latest, installerUrl } = await getLatestReleaseInfo();
    const current = app.getVersion();

    if (compareVersions(latest, current) <= 0) {
      return; // 已是最新
    }

    // 提示用户
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${latest}，当前版本 ${current}`,
      detail: '是否下载更新？下载完成后会自动安装。',
      buttons: ['下载更新', '稍后再说'],
    });
    if (response !== 0) return;

    // 下载
    const target = path.join(app.getPath('temp'), `setup-${latest}.exe`);
    await downloadFile(installerUrl, target, (received, total) => {
      // 转发进度给渲染进程（可选）
    }, GITLAB_UPDATE_CONFIG.token);

    // 静默安装并退出（NSIS 安装包支持 /S 参数）
    const child = spawn(target, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    app.quit();
  } catch (error) {
    console.error('检查更新失败:', error);
  }
};
```

### 5.4 触发检查

```ts
// 应用启动 3 秒后自动检查
app.whenReady().then(() => {
  setTimeout(() => void checkForUpdates(), 3_000);
});

// 或通过 IPC 暴露给渲染进程手动触发
ipcMain.handle('app:check-updates', () => checkForUpdates());
```

### 5.5 服务端配套：发布安装包

其他项目发布新版时，需要把安装包上传到 GitLab **Generic Packages** 并挂到 Release 资产。可参考本项目的 `scripts/gitlab-release.ps1`，核心上传命令：

```bash
curl -X PUT \
  -H "PRIVATE-TOKEN: 你的令牌" \
  --data-binary "@release/app-setup-1.2.3.exe" \
  "http://gitlab/api/v4/projects/157/packages/generic/你的包名/1.2.3/app-setup-1.2.3.exe"
```

然后创建 Release 并将下载地址挂为资产链接（`POST /projects/:id/releases/:tag/assets/links`），客户端才能从 `getLatestReleaseInfo()` 中匹配到安装包。

---

## 6. 安全注意事项

| 事项 | 说明 |
|------|------|
| 令牌内置客户端 | 令牌编译进安装包可被提取，这是私有更新源的必要代价。泄露后到 GitLab **吊销重建**即可，不影响其他功能 |
| 最小权限 | 建议使用只读权限令牌（如 `read_api`），不要用管理员令牌 |
| 私有项目 | 本项目 `visibility=private`，匿名无法访问任何文件，故所有请求必须带 token |
| 证书 | HTTP 明文传输。若公司对安全要求高，建议 GitLab 前加 HTTPS 反代（模块的 `apiBase` 换成 `https://` 即可，无需改代码） |

---

## 7. 已知限制

| 限制 | 说明 |
|------|------|
| 无差分更新 | 每次下载完整安装包（无 blockmap 增量），安装包较大时流量成本高 |
| 无自动静默重启 | 静默安装由调用方用 `spawn /S` 实现，本模块只负责下载 |
| 无签名校验 | 未做安装包数字签名校验，依赖 GitLab 私有仓库的访问控制 |
| 版本前缀约定 | `tag_name` 需以 `v` 开头（如 `v1.2.3`），模块会去掉 `v` 前缀 |
| Generic Packages 需数字 ID | 项目 `id` 必须是数字（path 编码会 400） |

---

## 8. 常见问题排查

### Q1: `GitLab Releases 请求失败 (404)`

- 项目 ID 不对，或令牌无 `api` 权限
- 用 `GET /api/v4/projects/:path`（带 token）确认项目 ID

### Q2: `安装包下载失败 (401)`

- 下载时未传 token，或令牌已过期/吊销
- 确认 `downloadFile(..., token)` 传入了有效令牌

### Q3: `最新版本没有安装包下载链接`

- Release 资产链接中没有匹配 `installerPattern` 的文件
- 确认发布时挂载的资产链接名称/URL 以 `.exe` 结尾

### Q4: 上传到 Generic Packages 返回 400

- 使用了 path 编码的项目名而非**数字项目 ID**
- 改为数字 ID 后重试

### Q5: 客户端下载到的是登录页（几十 KB）

- 使用了 uploads 路径下载（302 到登录页）
- **必须使用 Generic Packages API 路径**，且带 `PRIVATE-TOKEN` header

---

## 9. 关联文件

| 文件 | 说明 |
|------|------|
| `core/updater/gitlabUpdater.ts` | 本模块（唯一需要复制的文件） |
| `electron/main.ts` | 接入示例：弹窗、静默安装（`installUpdateSilently`） |
| `scripts/gitlab-release.ps1` | 服务端发布脚本（上传 Generic Packages + 挂资产） |
| `RELEASE.md` | 完整发版操作手册（业务侧流程） |
