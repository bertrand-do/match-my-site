// Types for net.mjs (plain ESM).
export class UnsafeUrlError extends Error {}
export type Lookup = (hostname: string) => Promise<string[]>;
export const systemLookup: Lookup;
export function isPrivateAddress(address: string): boolean;
export function assertSafeShape(raw: string | URL): URL;
export function makeGuard(lookup?: Lookup | null): (raw: string) => Promise<URL>;
export function safeFetch(raw: string, init?: RequestInit, options?: { guard?: (raw: string) => Promise<URL>; fetchImpl?: typeof fetch; maxRedirects?: number }): Promise<Response>;
export function guardPage(page: unknown, guard?: (raw: string) => Promise<URL>): Promise<void>;
