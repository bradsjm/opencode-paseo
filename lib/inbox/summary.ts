export function truncateSummary(summary: string, maxSummaryLength: number): string {
    if (summary.length <= maxSummaryLength) {
        return summary
    }

    if (maxSummaryLength <= 1) {
        return summary.slice(0, maxSummaryLength)
    }

    return `${summary.slice(0, maxSummaryLength - 1)}…`
}
