import { expect, it } from "vitest";
import { contractIds, verifyReport } from "../scripts/real-agent-report.js";

const passing = () => ({ success: true, numTotalTests: 4, numPassedTests: 4, numFailedTests: 0, numPendingTests: 0,
  testResults: [{ status: "passed", assertionResults: contractIds.map((id) => ({ fullName: `${id}: regression`, status: "passed" })) }],
});

it("requires every named native contract, even if Vitest reports success", () => {
  expect(verifyReport(passing())).toEqual(contractIds);
  for (const missing of [undefined, {}, { ...passing(), testResults: [] }, { ...passing(), success: false }, { ...passing(), numPassedTests: 3 }, { ...passing(), unhandledErrors: ["crash"] }]) {
    expect(() => verifyReport(missing)).toThrow();
  }
  for (const status of ["pending", "skipped", "todo", "failed"]) {
    const report = passing(); report.testResults[0]!.assertionResults[0]!.status = status;
    expect(() => verifyReport(report)).toThrow();
  }
  const truncated = passing(); truncated.testResults[0]!.assertionResults.pop();
  expect(() => verifyReport(truncated)).toThrow();
  const duplicate = passing(); duplicate.testResults[0]!.assertionResults[0]!.fullName = duplicate.testResults[0]!.assertionResults[1]!.fullName;
  expect(() => verifyReport(duplicate)).toThrow();
});
