import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractJdSkuId, isJdProductUrl, normalizeJdProductUrl } from '../core/parsers/jdUrl.js';
import { normalizeAssetUrl } from '../core/parsers/assetUrl.js';
import { parseJdAssetsFromSnapshot, summarizeProductAssets } from '../core/parsers/jdParser.js';

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

run('npm', ['run', 'build']);

assert(extractJdSkuId('https://item.jd.com/100012043978.html') === '100012043978', '标准 PC 链接 SKU 识别失败');
assert(
  extractJdSkuId('https://item.m.jd.com/product/100012043978.html?scene=1') ===
    '100012043978',
  '移动端链接 SKU 识别失败',
);
assert(isJdProductUrl('https://item.jd.com/100012043978.html'), '京东商品链接校验失败');
assert(isJdProductUrl('item.jd.com/100012043978.html'), '不带协议的京东商品链接校验失败');
assert(!isJdProductUrl('https://example.com/100012043978.html'), '非京东链接不应通过校验');
assert(
  normalizeJdProductUrl('https://item.m.jd.com/product/100012043978.html') ===
    'https://item.jd.com/100012043978.html',
  '京东商品链接标准化失败',
);
assert(
  normalizeJdProductUrl('item.jd.com/100012043978.html?foo=bar') ===
    'https://item.jd.com/100012043978.html',
  '不带协议的京东商品链接标准化失败',
);
assert(
  normalizeAssetUrl('//img10.360buyimg.com/n5/jfs/t1/main-001.jpg') ===
    'https://img10.360buyimg.com/n5/jfs/t1/main-001.jpg',
  '图片链接标准化失败',
);
assert(
  normalizeAssetUrl('//img30.360buyimg.com/sku/jfs/t1/detail-001.jpg.avif') ===
    'https://img30.360buyimg.com/sku/jfs/t1/detail-001.jpg',
  '京东派生图片格式归一化失败',
);

const html = readFileSync(path.join(rootDir, 'tests/fixtures/jd-product.html'), 'utf8');
const assets = parseJdAssetsFromSnapshot({
  sourceUrl: 'https://item.jd.com/100012043978.html',
  html,
  pageTitle: '测试京东商品 京东JD.COM',
  networkTexts: ['{"image":"//img30.360buyimg.com/pop/jfs/t1/network-001.jpg"}'],
});
const summary = summarizeProductAssets(assets);

assert(assets.platform === 'jd', '平台标识错误');
assert(assets.skuId === '100012043978', '解析结果 SKU ID 错误');
assert(assets.title === '测试京东商品', '商品标题解析错误');
assert(summary.counts.main === 2, '主图数量解析错误');
assert(summary.counts.detail === 3, '详情图数量解析错误');
assert(summary.counts.sku === 2, 'SKU 图数量解析错误');
assert(summary.counts.unknown >= 2, '脚本或网络图片兜底解析错误');
assert(summary.counts.total >= 8, '总图片数量解析错误');

console.log('\n第二阶段自动验收通过。');
console.log(JSON.stringify(summary, null, 2));
