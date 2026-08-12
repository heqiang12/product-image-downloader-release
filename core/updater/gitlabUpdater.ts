// ── GitLab Release 更新检测模块（平台无关）──
// 用途：从自建 GitLab Releases 查询最新版本、比对版本号、下载安装包。
// 背景：electron-updater 官方 GitLabProvider 写死 https 且依赖 GitLab 14.3+
// 的 releases/permalink/latest 接口，自建 GitLab 13.8 + http 环境不可用，
// 故自研：直接调 GET /projects/:id/releases 列表接口（12.6+ 可用）。
// 认证：私有项目下 uploads 文件 302 到登录页（token 不生效），
// 安装包必须上传到 Generic Packages，客户端带 PRIVATE-TOKEN header 从 API 下载。
// 复用：其他项目拷贝本文件，仅需修改下方 GITLAB_UPDATE_CONFIG。
// 注意：core/ 同时被 tsconfig.electron.json(CommonJS) 与 tsconfig.core.json(NodeNext) 编译，
// 禁止依赖 DOM / 浏览器 API。

export interface GitlabUpdaterConfig {
  /** GitLab API 根地址，如 http://47.114.48.201:9000/api/v4 */
  apiBase: string;
  /** 项目 ID 或 path（如 tools/product-image-downloader） */
  project: string;
  /** 访问令牌（api 权限），私有项目查询 Release 和下载安装包必需 */
  token: string;
  /** 安装包文件名匹配模式（正则），默认 .exe 结尾 */
  installerPattern?: RegExp;
}

/** 每个项目只需改这里的配置 */
export const GITLAB_UPDATE_CONFIG: GitlabUpdaterConfig = {
  apiBase: 'http://47.114.48.201:9000/api/v4',
  // 注意：Generic Packages API 只接受数字项目 ID（path 编码会 400），故用 157
  project: '157',
  // ponytail: 令牌内置客户端是私有更新源的必要代价；泄露后到 GitLab 吊销重建即可
  token: 'mj1ZkkMUu225xqQK4N_Y',
};

export interface GitlabReleaseInfo {
  version: string;
  installerUrl: string;
}

export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
};

interface GitlabReleaseLink {
  name?: string;
  url: string;
}

interface GitlabRelease {
  tag_name: string;
  assets?: { links?: GitlabReleaseLink[] };
}

/** 查询最新 Release，返回版本号（去掉 v 前缀）与安装包直链 */
export const getLatestReleaseInfo = async (
  config: GitlabUpdaterConfig = GITLAB_UPDATE_CONFIG,
): Promise<GitlabReleaseInfo> => {
  const url = `${config.apiBase}/projects/${encodeURIComponent(config.project)}/releases?per_page=1`;
  const res = await fetch(url, { headers: authHeaders(config) });
  if (!res.ok) {
    throw new Error(`GitLab Releases 请求失败 (${res.status})`);
  }
  const releases = (await res.json()) as GitlabRelease[];
  const latest = releases[0];
  if (!latest) {
    throw new Error('GitLab 上没有发布过版本');
  }

  const pattern = config.installerPattern ?? /\.exe$/i;
  const installerLink = latest.assets?.links?.find((link) => pattern.test(link.url));
  if (!installerLink) {
    throw new Error('最新版本没有安装包下载链接');
  }

  return {
    version: latest.tag_name.replace(/^v/i, ''),
    installerUrl: installerLink.url,
  };
};

const authHeaders = (config: GitlabUpdaterConfig): Record<string, string> =>
  config.token ? { 'PRIVATE-TOKEN': config.token } : {};

/**
 * 流式下载文件到本地，返回保存路径。
 * onProgress 回调参数：已下载字节数、总字节数（0 表示未知）。
 * 注意：私有项目安装包在 Generic Packages API 路径下，必须带 token 下载。
 */
export const downloadFile = async (
  url: string,
  targetPath: string,
  onProgress?: (received: number, total: number) => void,
  token?: string,
): Promise<string> => {
  const res = await fetch(url, { headers: token ? { 'PRIVATE-TOKEN': token } : {} });
  if (!res.ok || !res.body) {
    throw new Error(`安装包下载失败 (${res.status})`);
  }
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  await import('node:fs/promises').then((fs) => fs.writeFile(targetPath, Buffer.concat(chunks)));
  return targetPath;
};
