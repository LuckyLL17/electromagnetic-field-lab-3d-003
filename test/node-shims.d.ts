// 最小 Node 运行时声明，避免测试项目依赖 @types/node
declare function setTimeout(cb: () => void, ms: number): number;
declare const process: { exit(code?: number): never; platform: string };
declare const performance: { now(): number };
declare class DOMException extends Error {
  constructor(message?: string, name?: string);
}
declare module 'node:assert' {
  interface Assert {
    (value: unknown, message?: string): void;
    strictEqual(a: unknown, b: unknown, message?: string): void;
    notStrictEqual(a: unknown, b: unknown, message?: string): void;
    deepStrictEqual(a: unknown, b: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, ctor?: unknown, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    rejects(p: Promise<unknown> | (() => unknown), check?: unknown, message?: string): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
