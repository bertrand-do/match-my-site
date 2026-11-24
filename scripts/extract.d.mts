// Types for extract.mjs (plain ESM).
export type BrandResult = { ok: boolean; tokens: Record<string, unknown> | null; seconds: number; warning: string | null };
export const BRAND_TIMEOUT_MS: number;
export function extractBrand(options: { url: string; dir: string; images?: string[]; timeoutMs?: number; log?: (line: string) => void; lookup?: ((hostname: string) => Promise<string[]>) | null }): Promise<BrandResult>;
export function slimTokens(tokens: Record<string, unknown> | null): Record<string, unknown> | null;
export function chromePath(): Promise<string>;
