import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const retainedLocales = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak']);

export default async function afterPack(context) {
  const localesDir = path.join(context.appOutDir, 'locales');
  let entries;

  try {
    entries = await readdir(localesDir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.pak') && !retainedLocales.has(entry.name))
      .map((entry) => rm(path.join(localesDir, entry.name), { force: true })),
  );
}
