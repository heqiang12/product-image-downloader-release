import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProductAssets } from '../core/parsers/types.js';
import { downloadProductAssets, flattenSelectedAssets } from '../core/downloader/downloadManager.js';
import { buildProductFolderName, sanitizeFilenamePart } from '../core/utils/filename.js';

const rootDir = process.cwd();

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const run = (command: string, args: string[]) => {
  console.log(`\n> ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
};

const startImageServer = async () => {
  const attempts = new Map<string, number>();
  const imageBody = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  );

  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const currentAttempts = (attempts.get(pathname) || 0) + 1;
    attempts.set(pathname, currentAttempts);

    if (pathname === '/retry.jpg' && currentAttempts === 1) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('fail first');
      return;
    }

    if (pathname === '/broken.jpg') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
      return;
    }

    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(imageBody);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert(typeof address === 'object' && address !== null, '本地图片服务启动失败');
  const addressInfo = address as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${addressInfo.port}`,
    attempts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
};

const main = async () => {
  run('npm', ['run', 'build']);

  assert(sanitizeFilenamePart('a<b>c:d*e?f|g') === 'a_b_c_d_e_f_g', '文件名清理失败');
  assert(
    buildProductFolderName('测试/商品:*?', '100012043978') === '测试_商品____100012043978',
    '商品目录名生成失败',
  );

  const server = await startImageServer();
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'jd-image-downloader-stage3-'));

  try {
  const product: ProductAssets = {
    platform: 'jd',
    skuId: '100012043978',
    title: '测试/商品:*?',
    sourceUrl: 'https://item.jd.com/100012043978.html',
    images: {
      main: [
        {
          url: `${server.baseUrl}/main-a.jpg`,
          type: 'main',
          referer: 'https://item.jd.com/100012043978.html',
        },
        {
          url: `${server.baseUrl}/main-a.jpg`,
          type: 'main',
          referer: 'https://item.jd.com/100012043978.html',
        },
      ],
      detail: [
        {
          url: `${server.baseUrl}/detail-a.jpg`,
          type: 'detail',
          referer: 'https://item.jd.com/100012043978.html',
        },
      ],
      sku: [
        {
          url: `${server.baseUrl}/retry.jpg`,
          type: 'sku',
          referer: 'https://item.jd.com/100012043978.html',
        },
      ],
      unknown: [
        {
          url: `${server.baseUrl}/broken.jpg`,
          type: 'unknown',
          referer: 'https://item.jd.com/100012043978.html',
        },
      ],
    },
    debug: {
      collectedAt: new Date().toISOString(),
      warnings: [],
    },
  };

  assert(flattenSelectedAssets(product).length === 4, '下载前去重失败');

  const result = await downloadProductAssets(product, {
    outputRoot,
    concurrency: 2,
    retries: 1,
    timeoutMs: 5_000,
  });

  assert(result.progress.total === 4, '下载总数错误');
  assert(result.progress.success === 3, '成功数量错误');
  assert(result.progress.failed === 1, '失败数量错误');
  assert(server.attempts.get('/retry.jpg') === 2, '失败重试未生效');

  await stat(path.join(result.outputDir, 'main', 'main_001.png'));
  await stat(path.join(result.outputDir, 'detail', 'detail_002.png'));
  await stat(path.join(result.outputDir, 'sku', 'sku_003.png'));
  await stat(result.metaPath);

  const meta = JSON.parse(await readFile(result.metaPath, 'utf8')) as {
    progress: { total: number; success: number; failed: number };
    assets: Array<{ status: string; errorMessage?: string }>;
  };

  assert(meta.progress.total === 4, 'meta.json 总数错误');
  assert(meta.progress.success === 3, 'meta.json 成功数量错误');
  assert(meta.progress.failed === 1, 'meta.json 失败数量错误');
  assert(
    meta.assets.some((asset) => asset.status === 'failed' && asset.errorMessage?.includes('HTTP 404')),
    'meta.json 未记录失败原因',
  );

  console.log('\n第三阶段自动验收通过。');
  console.log(
    JSON.stringify(
      {
        outputDir: result.outputDir,
        progress: result.progress,
        downloaded: result.assets.map((asset) => ({
          status: asset.status,
          filename: asset.filename,
          attempts: asset.attempts,
          errorMessage: asset.errorMessage,
        })),
      },
      null,
      2,
    ),
  );
  } finally {
    await server.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
};

void main();
