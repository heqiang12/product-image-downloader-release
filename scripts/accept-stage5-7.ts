import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import {
  createExcelTemplateBuffer,
  parseExcelLinks,
  writeExcelTemplate,
} from '../core/importers/excelImporter.js';

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

const createWorkbookBuffer = () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([
    {
      名称: '商品 A',
      链接: 'https://item.m.jd.com/product/100012043978.html?scene=1',
      平台: 'jd',
    },
    {
      名称: '商品 B',
      链接: 'https://item.jd.com/100012043979.html',
      平台: '',
    },
    {
      名称: '重复商品',
      链接: 'https://item.jd.com/100012043978.html',
      平台: '京东',
    },
    {
      名称: '不支持',
      链接: 'https://example.com/item.html',
      平台: '',
    },
    {
      名称: '缺少链接',
      链接: '',
      平台: '',
    },
  ]);

  XLSX.utils.book_append_sheet(workbook, sheet, '商品链接');
  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;
};

const main = async () => {
  run('npm', ['run', 'build']);

  const importResult = parseExcelLinks(createWorkbookBuffer(), 'jd');
  assert(importResult.totalRows === 5, 'Excel 总行数错误');
  assert(importResult.validLinks.length === 2, '有效链接数量错误');
  assert(importResult.validLinks[0].url === 'https://item.jd.com/100012043978.html', '链接标准化失败');
  assert(importResult.validLinks[0].platform === 'jd', '平台自动识别失败');
  assert(importResult.invalidRows.length === 3, '异常行数量错误');
  assert(importResult.invalidRows.some((row) => row.reason === '重复链接'), '未识别重复链接');
  assert(importResult.invalidRows.some((row) => row.reason === '缺少链接'), '未识别缺少链接');

  const templateBuffer = createExcelTemplateBuffer('jd');
  const templateWorkbook = XLSX.read(templateBuffer, { type: 'buffer' });
  const templateRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    templateWorkbook.Sheets[templateWorkbook.SheetNames[0]],
  );

  assert(templateRows.length === 1, '模板示例行错误');
  assert(Object.keys(templateRows[0]).includes('商品链接'), '模板缺少商品链接列');
  assert(Object.keys(templateRows[0]).includes('说明'), '模板缺少说明列');

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jd-image-downloader-stage57-'));

  try {
    const templatePath = path.join(tempDir, 'template.xlsx');
    const importPath = path.join(tempDir, 'links.xlsx');
    await writeExcelTemplate(templatePath, 'jd');
    await writeFile(importPath, createWorkbookBuffer());
    await stat(templatePath);

    const roundTripResult = parseExcelLinks(await readFile(importPath), 'jd');
    assert(roundTripResult.validLinks.length === 2, 'Excel 文件导入解析失败');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const mainSource = readFileSync('electron/main.ts', 'utf8');
  const preloadSource = readFileSync('electron/preload.ts', 'utf8');
  const appSource = readFileSync('src/App.vue', 'utf8');

  assert(mainSource.includes('import:excel-links'), '主进程缺少 Excel 导入 IPC');
  assert(mainSource.includes('import:export-template'), '主进程缺少模板导出 IPC');
  assert(preloadSource.includes('importExcelLinks'), 'preload 缺少 Excel 导入 API');
  assert(preloadSource.includes('exportExcelTemplate'), 'preload 缺少模板导出 API');
  assert(appSource.includes('导入 Excel'), '页面缺少导入 Excel 操作');
  assert(appSource.includes('exportExcelTemplate'), '页面缺少导出模板操作');

  console.log('\n阶段 5.7 自动验收通过。');
  console.log(
    JSON.stringify(
      {
        importResult,
        templateSheets: templateWorkbook.SheetNames,
      },
      null,
      2,
    ),
  );
};

void main();
