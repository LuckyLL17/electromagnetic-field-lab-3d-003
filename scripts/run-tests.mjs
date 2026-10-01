// 离线测试运行器：用项目里的 tsc 把 test/src 编译到临时目录，再交给 node:test。
// 不依赖额外测试框架（离线环境未安装 vitest/jest）。
import { writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, '.test-build');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'src/field'), { recursive: true });
mkdirSync(join(outDir, 'test'), { recursive: true });

// 独立的测试编译配置（不影响 app 构建）：
// 仅编译无 DOM/three 依赖的核心逻辑与其测试，输出到 .test-build，保持相对目录结构。
writeFileSync(
  join(outDir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      outDir: '.',
      rootDir: '..',
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      noEmitOnError: false,
      typeRoots: [join(root, 'node_modules/@types')],
      types: ['node'],
    },
    include: ['../src/field/probeCore.ts', '../test/**/*.ts'],
  }),
);

// tsc.js 会解析平台原生二进制（npm 安装的 @typescript/typescript-* 包）
const tsc = spawnSync(
  process.execPath,
  [join(root, 'node_modules/typescript/lib/tsc.js'), '-p', join(outDir, 'tsconfig.json')],
  { stdio: 'inherit' },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const testFiles = readdirSync(join(outDir, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(outDir, 'test', f));
const proc = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
rmSync(outDir, { recursive: true, force: true });
process.exitCode = proc.status ?? 1;
