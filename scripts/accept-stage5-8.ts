import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

const main = () => {
  run('npm', ['run', 'build']);

  const appSource = readFileSync('src/App.vue', 'utf8');
  const cssSource = readFileSync('src/styles/main.css', 'utf8');

  assert(appSource.includes('平台登录'), '页面缺少平台登录区');
  assert(appSource.includes('导入任务'), '页面缺少导入区');
  assert(appSource.includes('任务区'), '页面缺少任务区');
  assert(appSource.includes('任务详情'), '页面缺少任务详情区');
  assert(appSource.includes('日志'), '页面缺少日志区');
  assert(appSource.includes('summary-strip'), '页面缺少任务汇总');
  assert(appSource.includes('selectedTask'), '页面缺少任务选择和详情联动');
  assert(appSource.includes('导入 Excel'), '页面缺少 Excel 导入入口');
  assert(appSource.includes('模板'), '页面缺少模板导出入口');

  assert(cssSource.includes('.workbench'), '样式缺少工作台布局');
  assert(cssSource.includes('grid-template-columns: 360px minmax(0, 1fr)'), '工作台布局不符合预期');
  assert(cssSource.includes('.detail-panel'), '样式缺少详情/日志区');
  assert(cssSource.includes('overflow-x: auto'), '任务表缺少横向溢出保护');
  assert(cssSource.includes('overflow-wrap: anywhere'), '详情长链接缺少换行保护');
  assert(cssSource.includes('text-overflow: ellipsis'), '长文本缺少省略保护');

  console.log('\n阶段 5.8 自动验收通过。');
  console.log(
    JSON.stringify(
      {
        sections: ['平台登录', '导入任务', '任务区', '任务详情', '日志'],
      },
      null,
      2,
    ),
  );
};

main();
