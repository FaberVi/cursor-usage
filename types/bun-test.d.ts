/** Minimal Bun test runner types for IDE type-checking (runtime uses Bun). */

type BunMatchers<T = unknown> = {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeTrue(): void;
  toBeFalse(): void;
  toHaveLength(length: number): void;
  toBeCloseTo(expected: number, precision?: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toContain(expected: string): void;
  toMatch(expected: string | RegExp): void;
  toBeTruthy(): void;
  not: BunMatchers<T>;
};

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function expect<T>(value: T): BunMatchers<T>;
  export function mock<T extends (...args: never[]) => unknown>(fn?: T): T;
  export function spyOn<T extends object, K extends keyof T>(
    object: T,
    method: K,
  ): { mockRestore(): void };
}

declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean });
    run(sql: string, ...params: unknown[]): unknown;
    close(): void;
  }
}

interface ImportMeta {
  readonly dir: string;
}
