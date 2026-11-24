import type { GenericGatewayContext } from "@embabel/runtime-types";
import { normalizeDetail, normalizePubmed, normalizeStudy } from "../lib/normalize";
import type {
  ClinicalTrialRecord,
  CtSearchResponse,
  CtStudy,
  CtVersionResponse,
  PublicationRecord,
  PubmedResponse,
  TrialDetailRecord,
} from "../lib/model";

interface TrialGateway {
  clinicalTrials: {
    getVersion(args: Record<string, never>): Promise<CtVersionResponse>;
    searchStudies(args: {
      "query.cond"?: string;
      "query.term"?: string;
      "filter.ids"?: string;
      pageSize: number;
      countTotal?: boolean;
      fields?: string;
      pageToken?: string;
    }): Promise<CtSearchResponse>;
  };
  pubmed: {
    summarizePubmed(args: { db: string; id: string; retmode: string; tool: string; email: string }): Promise<PubmedResponse>;
  };
}

const gatewayOf = (ctx: GenericGatewayContext): TrialGateway => ctx as unknown as TrialGateway;
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
  // Eligibility: who a trial is actually FOR. Without these, "trials open to older adults" or
  // "women only" cannot be answered at any layer, however the question is phrased.
  "Sex", "MinimumAge", "MaximumAge", "StdAge", "HealthyVolunteers",
  // The entities a trial names: where it runs and who runs it. Both are shared across trials, which
  // is what turns a fetch tree into a graph.
  "LocationFacility", "OverallOfficialName", "OverallOfficialAffiliation",
].join(",");

export interface TrialCoverageRecord {
  coverageId: string;
  scopeQuery: string;
  /** The Essie expression applied AT the registry, when the query had something pushable. Recorded
   *  because a filtered count is not a total: without it, "113 trials" reads as the whole landscape. */
  sourceFilters?: string;
  source: string;
  state: "COMPLETE" | "PARTIAL_PAGE_CAP";
  detail: string;
  sourceTotal?: number;
  recordsFetched: number;
  pagesFetched: number;
  dataTimestamp?: string;
  retrievedAt: string;
}

export interface TrialSearchRunRecord {
  runId: string;
  scopeQuery: string;
  source: string;
  dataTimestamp?: string;
  retrievedAt: string;
  sourceTotal?: number;
  recordsFetched: number;
  pagesFetched: number;
  capped: boolean;
  trials: ClinicalTrialRecord[];
  coverage: TrialCoverageRecord[];
}

/**
 * Search ClinicalTrials.gov for each disease query, paging without mirroring the
 * registry. A source error throws: callers receive an explicit producer failure,
 * never a misleading empty answer.
 */
export async function searchByDisease(
  ctx: GenericGatewayContext,
  args: { queries: string[]; pageSize?: number; maxPages?: number; sourceFilters?: string },
): Promise<TrialSearchRunRecord[]> {
  const api = gatewayOf(ctx).clinicalTrials;
  // Filters the engine could push to the registry, already rendered as one Essie expression by the
  // producer's declared rules. Empty when the query carried nothing pushable — in which case the fetch
  // is deliberately wide and the narrowing happens graph-side, so the answer is the same and only the
  // cost differs. An unresolved placeholder means no substitution happened; treat it as absent rather
  // than sending it to the registry as a literal search term.
  const sourceFilters = (args.sourceFilters ?? "").includes("{filters}") ? "" : (args.sourceFilters ?? "").trim();
  // Clamped to what the source accepts, so a mis-set config degrades to a legal call
  // rather than a 400 that reads as "no trials exist".
  const pageSize = Math.min(Math.max(Number(args.pageSize) || DEFAULT_PAGE_SIZE, 1), 1000);
  const maxPages = Math.max(Number(args.maxPages) || DEFAULT_MAX_PAGES, 1);
  const version = await api.getVersion({});
  const retrievedAt = new Date().toISOString();
  const runs: TrialSearchRunRecord[] = [];

  for (const query of [...new Set(args.queries.map((q) => q.trim()).filter(Boolean))]) {
    const trials: ClinicalTrialRecord[] = [];
    let pageToken: string | undefined;
    let totalCount: number | undefined;
    let pages = 0;
    do {
      const response = await api.searchStudies({
        "query.cond": query,
        ...(sourceFilters ? { "query.term": sourceFilters } : {}),
        pageSize,
        countTotal: pages === 0,
        fields: LANDSCAPE_FIELDS,
        ...(pageToken ? { pageToken } : {}),
      });
      if (pages === 0) totalCount = response.totalCount;
      trials.push(...(response.studies ?? []).flatMap((s) => {
        const normalized = normalizeStudy(s);
        return normalized ? [normalized] : [];
      }));
      pageToken = response.nextPageToken;
      pages += 1;
    } while (pageToken && pages < maxPages);

    const capped = !!pageToken;
    const runId = `clinicaltrials.gov:${encodeURIComponent(query)}:${version.dataTimestamp ?? retrievedAt}`;
    const coverage: TrialCoverageRecord = {
      coverageId: `${runId}:coverage`,
      scopeQuery: query,
      sourceFilters: sourceFilters || undefined,
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

/* How many NCT ids go into one `filter.ids` request. The registry pages at 1000, so a chunk of this
 * size always fits on one page; it is kept well under that so the query string stays short. The
 * producer's maxKeysPerCall matches it, so the engine never hands over more than one chunk. */
const DETAIL_IDS_PER_CALL = 100;

/** Fetch current protocol detail for selected NCT ids: one registry search by id per chunk of ids. */
export async function detailsByNctIds(
  ctx: GenericGatewayContext,
  args: { nctIds: string[] },
): Promise<TrialDetailRecord[]> {
  const api = gatewayOf(ctx).clinicalTrials;
  const ids = [...new Set(args.nctIds.map((id) => id.trim().toUpperCase()).filter(Boolean))];
  /* `filter.ids` returns the same full record `/studies/{nctId}` does, so twenty trials cost one
   * call rather than twenty. An id the registry does not hold is simply absent from the page. */
  const studies: CtStudy[] = [];
  for (let i = 0; i < ids.length; i += DETAIL_IDS_PER_CALL) {
    const chunk = ids.slice(i, i + DETAIL_IDS_PER_CALL);
    const response = await api.searchStudies({ "filter.ids": chunk.join(","), pageSize: 1000 });
    studies.push(...(response.studies ?? []));
  }
  return studies.flatMap((s) => {
    const detail = normalizeDetail(s);
    return detail ? [detail] : [];
  });
}

/** Resolve many registry PMIDs through one NCBI ESummary request (max 200 per call). */
export async function publicationsByPmid(
  ctx: GenericGatewayContext,
  args: { pmids: string[] },
): Promise<PublicationRecord[]> {
  const ids = [...new Set(args.pmids.map((id) => id.trim()).filter(Boolean))].slice(0, 200);
  if (ids.length === 0) return [];
  const response = await gatewayOf(ctx).pubmed.summarizePubmed({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
    tool: "trialchronicle",
    email: "assistant@embabel.com",
  });
  return normalizePubmed(response);
}
