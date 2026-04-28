import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

const run = (command, args) => {
  console.log(`\n> ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
};

const assertFile = (relativePath) => {
  const fullPath = path.join(rootDir, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`缺少文件: ${relativePath}`);
  }
};

const assertIncludes = (relativePath, expectedText) => {
  const fullPath = path.join(rootDir, relativePath);
  const content = readFileSync(fullPath, 'utf8');
  if (!content.includes(expectedText)) {
    throw new Error(`${relativePath} 缺少关键内容: ${expectedText}`);
  }
};

run('npm', ['run', 'build']);

[
  'dist/index.html',
  'dist-electron/electron/main.js',
  'dist-electron/electron/preload.js',
  'src/App.vue',
  'electron/main.ts',
  'electron/preload.ts',
].forEach(assertFile);

assertIncludes('electron/main.ts', "ipcMain.handle('app:get-version'");
assertIncludes('electron/main.ts', "ipcMain.handle('task:validate-links'");
assertIncludes('electron/preload.ts', "contextBridge.exposeInMainWorld('jdDownloader'");
assertIncludes('src/App.vue', 'validateLinks(rawLinks.value)');
assertIncludes('src/App.vue', 'v-model="rawLinks"');

console.log('\n第一阶段自动验收通过。');
