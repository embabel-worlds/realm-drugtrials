# Architecture

## Principle: live federation, not a clinical-trial mirror

The core artifact is a Realm—a set of source contracts, typed virtual nodes, declarative joins,
handlers, views, Lenses and a Skill. The first version keeps only tiny authored disease-query
examples. Clinical trial and publication records are fetched when a query demands them and are
rolled back after the scoped read.

```text
Browser app
    │ invokes named Lens (typed args)
    ▼
trial-landscape Lens ─────── presentation + deterministic signals
    │ queries named node view
    ▼
DiseaseTrialRuns view ────── reusable disease → run selection
    │ Virtual Cypher
    ▼
DiseaseScope ─HAS_TRIAL_SEARCH→ TrialSearchRun
                                      ├─RETURNED→ ClinicalTrial
                                      └─HAS_COVERAGE→ TrialCoverage
```

Selected detail is independently bounded:

```text
trial-detail Lens → TrialProtocol view
  → ClinicalTrial ─HAS_CURRENT_DETAIL→ TrialDetail
                                      ├─DECLARES_OUTCOME→ TrialOutcome
                                      └─CITES_REFERENCE→ TrialReference
                                                               │ batched PMIDs
                                                               └─RESOLVES_TO→ Publication
```

## Why both views and Lenses

A node view preserves identity and therefore composes as a label in another Virtual Cypher query.
It is the reusable “which nodes?” boundary. A Lens is a named program: it can run the view, apply
deterministic rules that are awkward in Cypher, build coverage-aware response JSON, and present a
stable application contract.

Tabular views remain useful for direct reports. They are terminal because scalar projections do
not preserve a traversable node identity.

## Runtime sequence

For a disease landscape request:

1. The Lens maps a familiar disease alias to a transparent source expression. Unknown diseases
   remain valid literal scopes.
2. Its query references `DiseaseTrialRuns` with the expression as a view parameter.
3. The view expander inlines the node-view body before Virtual Cypher planning.
4. The planner sees `HAS_TRIAL_SEARCH`, invokes `searchByDisease`, and temporarily materializes the
   run plus declared `RETURNED` and `HAS_COVERAGE` children.
5. The scoped query returns scalar fields; temporary nodes and relationships are rolled back.
6. The Lens filters requested phase/country/status values, creates conservative signals and emits
   the public response contract.

Source errors throw. They become typed execution/source failures at the host boundary, not a zero
count. A deliberate page cap produces `PARTIAL_PAGE_CAP` in the data itself.

## What is persisted

- Realm definitions and generated handler bundle.
- No `DiseaseScope` nodes. A scope is only ever a literal on the query: once the store holds a
  node of an anchor-only label, the host stops seeding keys no stored node holds, so a stored example
  would leave every other disease search with no rows.
- Host caches for bounded source calls, according to policy.
- A future Watch may retain a compact answer snapshot/diff with source identities.

What is not persisted by this Realm: the ClinicalTrials.gov corpus, PubMed corpus, raw participant
data, article full text, or every historical version of every trial.

## Current host dependencies

- Realm loading for types, APIs, producers, views, Lenses and Skills.
- compiled TypeScript handler gateway;
- staged Virtual Cypher with `brings`, batch keys, cache and cost buckets;
- named-view expansion before Virtual Cypher planning;
- Lens presentation and the authenticated headless invocation endpoint.

The demo HTML resides in a user workspace pending
[`embabel/me#563`](https://github.com/embabel/me/issues/563). A genuinely anonymous public service
also needs a deployment façade with abuse controls; authentication behavior is a host concern, not
embedded in the Realm.

