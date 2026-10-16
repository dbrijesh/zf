import { desc, eq, sql } from 'drizzle-orm';
import { ulid, type Usage } from '@zerovity/core';
import type { Db } from './client';
import * as s from './schema';

export interface PriceRow { model: string; inputPerMtok: number; outputPerMtok: number; cachedPerMtok: number; perPremiumRequest?: number | null }

/**
 * Starter prices in USD per million tokens. These are approximate list prices captured when the
 * product was written and MUST be reviewed in Settings > Model prices before cost numbers are trusted.
 */
export const DEFAULT_PRICES: PriceRow[] = [
  { model: 'claude-fable-5-1', inputPerMtok: 15, outputPerMtok: 75, cachedPerMtok: 1.5 },
  { model: 'claude-opus-5-5', inputPerMtok: 5, outputPerMtok: 25, cachedPerMtok: 0.5 },
  { model: 'claude-sonnet-5-5', inputPerMtok: 3, outputPerMtok: 15, cachedPerMtok: 0.3 },
  { model: 'claude-haiku-5-5', inputPerMtok: 1, outputPerMtok: 5, cachedPerMtok: 0.1 },
  { model: 'gpt-5-codex', inputPerMtok: 1.25, outputPerMtok: 10, cachedPerMtok: 0.125 },
  { model: 'copilot', inputPerMtok: 0, outputPerMtok: 0, cachedPerMtok: 0, perPremiumRequest: 0.04 },
  { model: 'fake-model', inputPerMtok: 2, outputPerMtok: 10, cachedPerMtok: 0.2 },
];

export async function seedPrices(db: Db): Promise<void> {
  const [any] = await db.select({ n: sql<number>`count(*)::int` }).from(s.modelPrices);
  if (any.n > 0) return;
  await db.insert(s.modelPrices).values(DEFAULT_PRICES.map((p) => ({ id: ulid(), ...p, perPremiumRequest: p.perPremiumRequest ?? null })));
}

export async function priceFor(db: Db, model: string | undefined | null, harness?: string): Promise<PriceRow | undefined> {
  const names = [model, harness === 'copilot' ? 'copilot' : undefined].filter(Boolean) as string[];
  for (const m of names) {
    const [r] = await db.select().from(s.modelPrices).where(eq(s.modelPrices.model, m)).orderBy(desc(s.modelPrices.effectiveFrom)).limit(1);
    if (r) return r;
  }
  return undefined;
}

/** Cost from a price row; harness-reported cost always wins (spec 8.5). */
export function computeCost(u: Usage, p?: PriceRow): number {
  if (u.costUsd !== undefined) return u.costUsd;
  if (!p) return 0;
  const tokens = (u.inputTokens * p.inputPerMtok + u.outputTokens * p.outputPerMtok + u.cachedTokens * p.cachedPerMtok) / 1e6;
  return tokens + (u.premiumRequests ?? 0) * (p.perPremiumRequest ?? 0);
}
