"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyTrial = classifyTrial;
const CONDUCT_PROBLEM = new Set(["TERMINATED", "WITHDRAWN", "SUSPENDED"]);
/** Deterministic registry observations. These are signals to investigate, never allegations. */
function classifyTrial(trial) {
    const findings = [];
    const status = trial.overallStatus ?? "UNKNOWN";
    if (CONDUCT_PROBLEM.has(status)) {
        findings.push({
            findingId: `${trial.nctId}:conduct:${status}`,
            nctId: trial.nctId,
            severity: "attention",
            kind: "CONDUCT_STATUS",
            statement: `Registry status is ${status.toLowerCase().replaceAll("_", " ")}.`,
            basis: trial.whyStopped
                ? `ClinicalTrials.gov records “why stopped”: ${trial.whyStopped}`
                : "ClinicalTrials.gov currently records this status but no structured reason was present.",
        });
    }
    if (status === "COMPLETED" && !trial.hasResults) {
        findings.push({
            findingId: `${trial.nctId}:results:not-present`,
            nctId: trial.nctId,
            severity: "attention",
            kind: "REGISTRY_RESULTS_NOT_PRESENT",
            statement: "The current ClinicalTrials.gov record is completed but has no posted results section.",
            basis: "Absence in this registry snapshot is not proof that results were never published elsewhere.",
        });
    }
    if (!trial.lastUpdated) {
        findings.push({
            findingId: `${trial.nctId}:freshness:unknown`,
            nctId: trial.nctId,
            severity: "context",
            kind: "FRESHNESS_UNKNOWN",
            statement: "No last-updated date was available in the current normalized record.",
            basis: "Freshness could not be established from the returned fields.",
        });
    }
    return findings;
}
