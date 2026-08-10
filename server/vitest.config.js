import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'tests/**/*.test.js'],
    // 属性测试（fast-check）与接口测试（Supertest + 临时 SQLite 库）耗时高于单元测试
    testTimeout: 30000,
    hookTimeout: 30000,
    // Windows + Node 24 下 fork pool 或逐文件隔离上下文反复加载原生 better-sqlite3，
    // 偶发 0xC0000409；改用 threads 单 worker 串行执行，并复用同一 worker 上下文。
    // 测试自身仍按既有 beforeEach/afterEach 重建并关闭数据库，不跳过 teardown。
    pool: process.platform === 'win32' ? 'threads' : undefined,
    isolate: process.platform !== 'win32',
    maxWorkers: process.platform === 'win32' ? 1 : undefined,
    fileParallelism: process.platform !== 'win32',
    // 脚手架阶段尚无测试文件；后续任务逐步补齐属性测试与接口测试
    passWithNoTests: true,
  },
});
