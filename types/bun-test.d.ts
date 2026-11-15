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
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toContain(expected: string): void;
  toMatch(expected: string | RegExp): void;
  toBeTruthy(): void;
  toBeInstanceOf(expected: abstract new (...args: never[]) => unknown): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(times: number): void;
  not: BunMatchers<T>;
};

type BunMockFn = (...args: never[]) => unknown;

type BunMock<T extends BunMockFn> = T & {
  mockClear(): void;
  mockRestore(): void;
  mockResolvedValue(value: unknown): BunMock<T>;
  mockResolvedValueOnce(value: unknown): BunMock<T>;
  mockReturnValue(value: unknown): BunMock<T>;
};

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function expect<T>(value: T): BunMatchers<T>;
  export const mock: {
    <T extends BunMockFn>(fn?: T): BunMock<T>;
    module(specifier: string, factory: () => unknown): void;
  };
  export function spyOn<T extends object, K extends keyof T>(
    object: T,
    method: K,
  ): T[K] extends BunMockFn ? BunMock<T[K]> : never;
}

declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean });
    run(sql: string, ...params: unknown[]): unknown;
    close(): void;
  }
}
