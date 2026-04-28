import { readFile, writeFile } from 'node:fs/promises';
import XLSX from 'xlsx';
import { resolvePlatformLink } from '../platforms/registry.js';
import type { ExcelImportResult, ImportedLink } from './types.js';

const HEADER_ALIASES = {
  name: ['名称', '商品名称', 'name'],
  url: ['链接', '商品链接', 'url', 'link'],
  platform: ['平台', 'platform'],
};

const findValue = (row: Record<string, unknown>, aliases: string[]): string => {
  for (const alias of aliases) {
    const value = row[alias];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number') {
      return String(value);
    }
  }

  return '';
};

export const parseExcelLinks = (buffer: Buffer): ExcelImportResult => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    return {
      totalRows: 0,
      validLinks: [],
      invalidRows: [],
    };
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], {
    defval: '',
  });
  const validLinks: ImportedLink[] = [];
  const invalidRows: ExcelImportResult['invalidRows'] = [];
  const seenUrls = new Set<string>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const url = findValue(row, HEADER_ALIASES.url);
    const name = findValue(row, HEADER_ALIASES.name);
    const platform = findValue(row, HEADER_ALIASES.platform);

    if (!url) {
      invalidRows.push({ rowNumber, reason: '缺少链接' });
      return;
    }

    const resolvedLink = resolvePlatformLink(url);

    if (!resolvedLink) {
      invalidRows.push({ rowNumber, reason: '不支持或无法识别的商品链接' });
      return;
    }

    if (platform && platform !== resolvedLink.platform.id && platform !== resolvedLink.platform.name) {
      invalidRows.push({ rowNumber, reason: '平台字段与链接不匹配' });
      return;
    }

    if (seenUrls.has(resolvedLink.normalizedUrl)) {
      invalidRows.push({ rowNumber, reason: '重复链接' });
      return;
    }

    seenUrls.add(resolvedLink.normalizedUrl);
    validLinks.push({
      name: name || undefined,
      url: resolvedLink.normalizedUrl,
      platform: resolvedLink.platform.id,
    });
  });

  return {
    totalRows: rows.length,
    validLinks,
    invalidRows,
  };
};

export const importExcelLinksFromFile = async (filePath: string): Promise<ExcelImportResult> =>
  parseExcelLinks(await readFile(filePath));

export const createExcelTemplateBuffer = (): Buffer => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([
    {
      名称: '示例商品',
      链接: 'https://item.jd.com/100012043978.html',
      平台: 'jd',
    },
  ]);

  XLSX.utils.book_append_sheet(workbook, sheet, '商品链接');
  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;
};

export const writeExcelTemplate = async (filePath: string): Promise<void> => {
  await writeFile(filePath, createExcelTemplateBuffer());
};
