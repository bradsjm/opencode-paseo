/**
 * Truncates a summary string to the configured maximum length.
 *
 * @param summary - The original summary text.
 * @param maxSummaryLength - The maximum length to retain.
 * @returns The original summary when it fits, otherwise a truncated version.
 */
export function truncateSummary(summary: string, maxSummaryLength: number): string {
  if (summary.length <= maxSummaryLength) {
    return summary
  }

  if (maxSummaryLength <= 1) {
    return summary.slice(0, maxSummaryLength)
  }

  return `${summary.slice(0, maxSummaryLength - 1)}…`
}
