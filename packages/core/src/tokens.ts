/**
 * Token estimate used for lint weights and context budgets. It is deliberately a cheap, stable
 * approximation (no model-specific tokenizer) so that numbers are identical on every machine.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  // blend: ~4 chars/token for prose, words*1.3 for code-ish text
  return Math.ceil((chars / 4 + words * 1.3) / 2);
}
