/**
 * Token accounting for the two memory budgets. The convention is the Live
 * appender's (chars / 3.2, rounded up); memory does not import live, so it
 * carries its own copy. Budgets are caps on what memory may cost a prompt,
 * never targets.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}
