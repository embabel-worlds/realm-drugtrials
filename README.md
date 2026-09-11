# realm-drugtrials — WhatsBeenTried.org

**WhatsBeenTried.org** is a live, disease-first clinical research investigation Realm for Embabel.
It answers questions such as:

> What research exists for Long COVID? What is still active, what stopped, and which completed
> trial records currently contain no results section?

The Realm does not preload ClinicalTrials.gov. A named view traverses live public APIs through
Virtual Cypher, temporarily materializes only the evidence required for the question, runs the
query, and rolls the graph back. A selected-trial drill-down joins registry references to PubMed
without an N+1 request pattern.

This is an early public-good vertical slice. It is not medical advice, a systematic review, a
legal-compliance determination, or evidence that an intervention works.

## What is implemented

- live ClinicalTrials.gov v2 condition search with paging and source `dataTimestamp`;
- current trial status, phase, sponsor, intervention, country, dates and results-section presence;
- explicit `COMPLETE` / `PARTIAL_PAGE_CAP` coverage declarations;
- current protocol detail with brought outcome and registered-reference subgraphs;
- batched PubMed ESummary resolution for PMID-bearing trial references;
- deterministic, conservatively worded registry signals;
- composable parameterized node views plus directly runnable tabular views;
- two named Lenses: disease landscape and selected-trial detail;
- a polished, relative-asset single-page workspace app; and
- unit tests for normalization, paging, batching, deduplication and fail-loud behavior.

No API key is required for the initial sources.

## Requires realm-research

Sponsors, sites and investigators resolve to types that **realm-research owns**: `CorporateEntity`
(company identity and ownership), `InstitutionProfile` (registry institution identity) and
`ResearcherProfile` (disambiguated scholarly identity). Those capabilities are general — anything with
organization or people names wants them — so they live in one place rather than being reimplemented per
domain, and this realm contributes only the edges from its own anchors into them.

There is no realm dependency mechanism yet, so this is a documented requirement rather than an enforced
one. Install `realm-research` alongside this realm. Without it, the four edges below simply resolve to
nothing: trials still read normally, with sponsors and sites as the plain strings the registry gave.
That is a smaller answer, not a wrong one.

| Edge | Resolves to | Answers |
|---|---|---|
| `(:ClinicalTrial)-[:SPONSORED_BY]->(:CorporateEntity)` | realm-research | Who runs these, counted by owner rather than by subsidiary |
| `(:ClinicalTrial)-[:COLLABORATES_WITH]->(:CorporateEntity)` | realm-research | Which companies contribute without sponsoring |
| `(:ClinicalTrial)-[:RUNS_AT]->(:InstitutionProfile)` | realm-research | Which institutions run the most trials, across every spelling of their name |
| `(:ClinicalTrial)-[:LED_BY]->(:ResearcherProfile)` | realm-research | The people running trials, connected to their published work |
| `(:ClinicalTrial)-[:TESTS_LABELLED_DRUG]->(:DrugLabel)` | this realm (openFDA) | Which trialled drugs already carry approved labelling |

## Filtering happens at the registry

Status, sex, age cohort, phase and country filters are declared as pushdown rules, so narrowing a
landscape scopes the fetch at ClinicalTrials.gov instead of pulling everything and discarding most of
it — 723 trials fetched to keep 113 becomes a fetch of 113. Correctness does not depend on this:
anything that cannot be pushed is still filtered graph-side, so the rows are the same either way and
only the cost changes. `TrialCoverage.sourceFilters` records what was scoped at the source, because a
filtered count is not a total.

## Views and Lenses

The reusable views live in [`views/trials.yml`](views/trials.yml):

| Name | Shape | Purpose |
|---|---|---|
| `DiseaseTrialRuns` | node | One live source run, with coverage and returned trials reachable from it |
| `DiseaseTrials` | node | Disease-scoped trial nodes, composable into later traversals |
| `TrialProtocol` | node | Current detail for one NCT id |
| `TrialLandscape` | tabular | Direct live landscape report |
| `CompletedTrialsWithoutRegistryResults` | tabular | Investigation queue—not a legal finding |
| `RecruitingTrialsByCountry` | tabular | Recruiting records with a registered location in one country |

The [`trial-landscape` Lens](lenses/trial-landscape.yml) depends on the `DiseaseTrialRuns` node
view. The [`trial-detail` Lens](lenses/trial-detail.yml) depends on `TrialProtocol`. Views own the
reusable graph selection; Lenses own deterministic classification, grouping and public
presentation.

Example composable view query:

```cypher
MATCH (trial:DiseaseTrials {
  registryQuery: '"Long COVID" OR "Post-Acute Sequelae of SARS-CoV-2" OR PASC OR "Post-COVID Condition"'
})
WHERE trial.overallStatus = 'RECRUITING'
RETURN trial
```

The browser app invokes the stable named Lens, not arbitrary browser-supplied Cypher:

```http
POST /api/v1/lenses/trial-landscape/invoke
Content-Type: application/json

{"args":{"condition":"Long COVID","phases":"","countries":"","statuses":""}}
```

## App

The Realm ships the WhatsBeenTried.org app in [`apps/`](apps/). Installing the Realm surfaces it
in the artifact browser and serves it at `/apps/workspace/whatsbeentried.html` in an authenticated
world session (a user app of the same name overrides it). The stylesheet and script are
referenced by single-segment relative paths and the header image is inlined in the
stylesheet, matching the host's `/apps/{scope}/{name}` serving model.

## Build and verify

```bash
npm install
npm run check
```

The live sources can also be sanity-checked without installing the Realm:

```bash
curl -sS https://clinicaltrials.gov/api/v2/version
curl -sS --get https://clinicaltrials.gov/api/v2/studies \
  --data-urlencode 'query.cond=Long COVID' \
  --data-urlencode 'pageSize=1' \
  --data-urlencode 'countTotal=true'
```

## Design documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Realm boundary, Virtual Cypher stages and view/Lens composition
- [`docs/EVIDENCE_MODEL.md`](docs/EVIDENCE_MODEL.md) — claim boundaries, provenance and failure semantics
- [`docs/RATE_LIMITS.md`](docs/RATE_LIMITS.md) — request budgets, batching, caches and public-service controls

The much larger prior-art and product evidence trail lives with the WhatsBeenTried.org flagship
research in the target-customers repository; this repository is the executable Realm slice.

## Source terms

The Realm requests public factual metadata from ClinicalTrials.gov and NCBI E-utilities. It does
not bulk-download PubMed abstracts or article full text. Deployers remain responsible for source
terms, appropriate attribution, privacy, accessibility, medical disclaimers and jurisdictional
requirements.
