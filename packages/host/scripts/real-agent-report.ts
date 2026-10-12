export const contractIds = ["codex-multi-client", "codex-restart", "claude-handoff", "claude-active-handoff"] as const;

interface Report {
  success?: boolean;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  unhandledErrors?: unknown[];
  testResults?: { status?: string; assertionResults?: { fullName?: string; status?: string }[] }[];
}

/** An exit code alone can turn an empty, filtered or interrupted run green. */
export function verifyReport(input: unknown): string[] {
  if (!input || typeof input !== "object") throw new Error("Missing real-agent report");
  const report = input as Report;
  if (report.success !== true || report.numTotalTests !== contractIds.length || report.numPassedTests !== contractIds.length ||
      report.numFailedTests !== 0 || report.numPendingTests !== 0 || (report.numTodoTests ?? 0) !== 0 || report.unhandledErrors?.length) {
    throw new Error("Real-agent regression did not pass every contract");
  }
  if (!report.testResults?.length || report.testResults.some((suite) => suite.status !== "passed" || !suite.assertionResults?.length)) {
    throw new Error("Incomplete real-agent suites");
  }
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults!);
  const ids = assertions.map((assertion) => assertion.fullName?.split(":", 1)[0]);
  if (assertions.some((assertion) => assertion.status !== "passed") || ids.length !== contractIds.length ||
      contractIds.some((id) => ids.filter((found) => found === id).length !== 1)) {
    throw new Error("A required real-agent contract was skipped, duplicated or missing");
  }
  return ids as string[];
}
