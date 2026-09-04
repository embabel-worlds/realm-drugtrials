"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchByDisease = searchByDisease;
exports.detailsByNctIds = detailsByNctIds;
exports.publicationsByPmid = publicationsByPmid;
const normalize_1 = require("../lib/normalize");
const gatewayOf = (ctx) => ctx;
// Defaults only. Both are overridable per call — the producer declares them in
// `producers/trials.yml`, so an installation tunes depth without editing this file.
// ClinicalTrials.gov permits pageSize up to 1000, so the default sweep reaches 10,000
// records: enough that a normal disease landscape completes rather than being truncated
// at an arbitrary number. Me paces the calls against the declared `2/sec` cost bucket and
// backs off on 429, so depth costs time, not correctness.
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_PAGE_SIZE = 1000;
const LANDSCAPE_FIELDS = [
    "NCTId", "BriefTitle", "OfficialTitle", "OverallStatus", "WhyStopped",
    "StartDate", "PrimaryCompletionDate", "CompletionDate", "StudyFirstPostDate",
    "LastUpdatePostDate", "LeadSponsorName", "LeadSponsorClass", "CollaboratorName",
    "Condition", "Keyword", "StudyType", "Phase", "EnrollmentCount",
    "InterventionName", "InterventionType", "LocationCountry", "HasResults",
].join(",");
/**
 * Search ClinicalTrials.gov for each disease query, paging without mirroring the
 * registry. A source error throws: callers receive an explicit producer failure,
 * never a misleading empty answer.
 */
async function searchByDisease(ctx, args) {
    const api = gatewayOf(ctx).clinicalTrials;
    // Clamped to what the source accepts, so a mis-set config degrades to a legal call
    // rather than a 400 that reads as "no trials exist".
    const pageSize = Math.min(Math.max(Number(args.pageSize) || DEFAULT_PAGE_SIZE, 1), 1000);
    const maxPages = Math.max(Number(args.maxPages) || DEFAULT_MAX_PAGES, 1);
    const version = await api.getVersion({});
    const retrievedAt = new Date().toISOString();
    const runs = [];
    for (const query of [...new Set(args.queries.map((q) => q.trim()).filter(Boolean))]) {
        const trials = [];
        let pageToken;
        let totalCount;
        let pages = 0;
        do {
            const response = await api.searchStudies({
                "query.cond": query,
                pageSize,
                countTotal: pages === 0,
                fields: LANDSCAPE_FIELDS,
                ...(pageToken ? { pageToken } : {}),
            });
            if (pages === 0)
                totalCount = response.totalCount;
            trials.push(...(response.studies ?? []).flatMap((s) => {
                const normalized = (0, normalize_1.normalizeStudy)(s);
                return normalized ? [normalized] : [];
            }));
            pageToken = response.nextPageToken;
            pages += 1;
        } while (pageToken && pages < maxPages);
        const capped = !!pageToken;
        const runId = `clinicaltrials.gov:${encodeURIComponent(query)}:${version.dataTimestamp ?? retrievedAt}`;
        const coverage = {
            coverageId: `${runId}:coverage`,
            scopeQuery: query,
            source: "ClinicalTrials.gov",
            state: capped ? "PARTIAL_PAGE_CAP" : "COMPLETE",
            detail: capped
                ? `Stopped after ${pages} pages (${trials.length} records); more source pages existed.`
                : `Fetched every page returned for this query (${trials.length} records).`,
            sourceTotal: totalCount,
            recordsFetched: trials.length,
            pagesFetched: pages,
            dataTimestamp: version.dataTimestamp,
            retrievedAt,
        };
        runs.push({
            runId,
            scopeQuery: query,
            source: "ClinicalTrials.gov",
            dataTimestamp: version.dataTimestamp,
            retrievedAt,
            sourceTotal: totalCount,
            recordsFetched: trials.length,
            pagesFetched: pages,
            capped,
            trials,
            coverage: [coverage],
        });
    }
    return runs;
}
/** Fetch current protocol detail for selected NCT ids. Selection keeps this from becoming N+1. */
async function detailsByNctIds(ctx, args) {
    const api = gatewayOf(ctx).clinicalTrials;
    const ids = [...new Set(args.nctIds.map((id) => id.trim().toUpperCase()).filter(Boolean))];
    const studies = await Promise.all(ids.map((nctId) => api.getStudy({ nctId })));
    return studies.flatMap((s) => {
        const detail = (0, normalize_1.normalizeDetail)(s);
        return detail ? [detail] : [];
    });
}
/** Resolve many registry PMIDs through one NCBI ESummary request (max 200 per call). */
async function publicationsByPmid(ctx, args) {
    const ids = [...new Set(args.pmids.map((id) => id.trim()).filter(Boolean))].slice(0, 200);
    if (ids.length === 0)
        return [];
    const response = await gatewayOf(ctx).pubmed.summarizePubmed({
        db: "pubmed",
        id: ids.join(","),
        retmode: "json",
        tool: "trialchronicle",
        email: "assistant@embabel.com",
    });
    return (0, normalize_1.normalizePubmed)(response);
}
