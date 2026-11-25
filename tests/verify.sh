#!/bin/sh
# Ground truth for realm-drugtrials, against the public sources themselves. Every source is keyless:
# ClinicalTrials.gov v2, NCBI E-utilities (PubMed) and openFDA. No source keys are read.
#
#   L1  every view answers BY NAME on its defaults
#   L2  the realm's figures equal the sources' own: a disease search's total and trial list, the
#       recruiting-in-a-country list, one trial's declared outcomes and references, the PubMed
#       articles those references name, and which of its drugs carry an FDA label
#   L3  the cost: filters reach the registry (a narrowed search fetches only what it keeps), a set of
#       trials' details is ONE registry call, and a trial's references are ONE PubMed call. Read cold,
#       with `ai: {fresh: true}` on the measured edge, so a second run inside the cache window still
#       measures something.
#
#   APPLIANCE=http://127.0.0.1:11043 AUTH=user:pass sh tests/verify.sh
#   (or TOKEN=<appliance API key> in place of AUTH)
#
# Needs realm-research installed beside it (realm.yml requires it).
set -e
AUTHCFG=$(mktemp); trap 'rm -f "$AUTHCFG"' EXIT
if [ -n "${TOKEN:-}" ]; then printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$AUTHCFG"
else printf 'user = "%s"\n' "${AUTH:?set AUTH (user:pass) or TOKEN}" > "$AUTHCFG"; fi
APPLIANCE="${APPLIANCE:-http://127.0.0.1:11043}"
APPLIANCE="$APPLIANCE" AUTHCFG="$AUTHCFG" python3 - <<'PY'
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request, urllib.error
base, auth = os.environ["APPLIANCE"].rstrip("/"), os.environ["AUTHCFG"]
fail = 0
UA = {"User-Agent": "realm-drugtrials-verify/0.2 (https://github.com/embabel-worlds/realm-drugtrials)"}

# Whether an engine answer is the whole truth. A source that failed under load, a capped page or a
# refused hop leaves the rows looking like an answer while the figure is short; reading the figure
# and ignoring the rest reports drift that is not the realm's. short(d) is None when the answer is
# whole, else what to print in place of the figure: "REFUSED: <why>" or "PARTIAL <n>: <reason>".
# Query answers carry `error`, `reason`, `run` and string `warnings` opening with the engine's code;
# a view envelope carries `status`, `outcome` and `warnings` as {code, message}.
# Raw warning codes that mean rows or values may be missing (the engine's incompleteness kinds).
# Cost notes (FILTERED_IN_GRAPH, AGGREGATE_NOT_PUSHED, EMPTY_NOT_KEPT, PUSHDOWN_VALUE_UNMATCHED),
# FILTER_STARVED (an honest empty), STALE_COPY, FIELDS_WITHHELD and UNKNOWN_VIA leave every row in place.
SHORT_CODES = (
    "PARTIAL_RESULT", "PRODUCER_ERROR", "NEEDS_FILTER", "NEEDS_PRODUCER", "FILTER_REJECTED",
    "UNPUSHED_FILTER", "AMBIGUOUS_LABEL", "INCOMPLETE_TRAVERSAL", "INCOMPLETE_RANKING",
    "INCOMPLETE_AGGREGATE", "INCOMPLETE_INPUT", "MATERIALIZATION_FAILED", "REDUCTION_FAILED",
    "UNPARSEABLE_ANSWER", "TERMS_UNAVAILABLE", "COMPUTE_FAILED", "PROPERTY_NOT_STORED",
    "FOLLOW_CAPPED", "UNLINKED_CHILDREN", "RESOLUTION_DROPPED", "AGENTIC_DEGRADED",
    "SOURCE_UNANSWERED",
)
# The typed `reason` a query result carries when it is not a clean answer and not an honest empty.
SHORT_REASONS = ("UNBOUNDED", "PARTIAL_NOT_MATCHED", "UNPUSHED_FILTER", "DISCONNECTED",
                 "INTERNAL_ERROR", "WRITE_IN_PROGRESS", "KILLED", "TOO_EXPENSIVE")
# Public warning codes on a view envelope that mean the same.
SHORT_PUBLIC = ("PARTIAL", "REDUCTION_FAILED", "COMPUTE_FAILED", "PROPERTY_NOT_STORED",
                "AGENTIC_DEGRADED", "RATE_LIMITED", "SOURCE_UNAVAILABLE", "SOURCE_REJECTED",
                "INVALID_FILTER", "UNPUSHED_FILTER", "TOO_BROAD", "FETCH_CAPPED",
                "INDEX_UNAVAILABLE", "ARGUMENT_REFUSED")


def short(d, figure=None):
    tag = "PARTIAL" if figure is None else "PARTIAL %s" % (figure,)
    if not isinstance(d, dict):
        return "REFUSED: not an engine answer: " + str(d)[:160]
    if "outcome" in d or "status" in d:  # a view envelope
        err = d.get("error") or {}
        if d.get("status") != "SUCCEEDED":
            return "REFUSED: %s %s" % (d.get("status"), (err.get("code", "") + " " + err.get("message", "")).strip()[:160] if isinstance(err, dict) else str(err)[:160])
        ws = [w for w in d.get("warnings") or [] if isinstance(w, dict) and w.get("code") in SHORT_PUBLIC]
        if d.get("outcome") not in ("OK", "EMPTY") or ws:
            why = ws[0]["code"] + ": " + ws[0].get("message", "") if ws else "outcome " + str(d.get("outcome"))
            return "%s: %s" % (tag, why[:200])
        return None
    if d.get("error"):
        return "REFUSED: " + str(d["error"])[:160]
    if d.get("run"):
        return "%s: the run had not finished (%s)" % (tag, d["run"])
    ws = [w for w in d.get("warnings") or [] if isinstance(w, str) and w.split(":", 1)[0].strip() in SHORT_CODES]
    if ws:
        return "%s: %s" % (tag, ws[0][:200])
    if d.get("reason") in SHORT_REASONS:
        return "%s: reason %s" % (tag, d["reason"])
    return None

class Short(dict):
    """A row standing in for a short answer: every column reads as the reason, so the check that
    reads it fails with the engine's own words instead of counting what did come back."""
    def __init__(self, why): super().__init__(); self.why = why
    def get(self, k, default=None): return self.why
    def __getitem__(self, k): return self.why
    def __repr__(self): return self.why
def figure(rows):
    return list(rows[0].values())[0] if len(rows) == 1 and len(rows[0]) == 1 else len(rows)

def post(path, body):
    out = subprocess.run(["curl", "-s", "-K", auth, "-X", "POST", base + path, "-H", "Content-Type: application/json",
                          "-d", json.dumps(body)], capture_output=True, text=True).stdout
    try: return json.loads(out, strict=False)
    except ValueError: return {"status": "UNPARSEABLE", "error": out[:300]}
def view(name, args=None): return post("/api/v1/views/%s/invoke" % name, {"args": args or {}})
def kg(cypher):
    r = post("/api/v1/admin/kg/execute", {"cypher": cypher})
    if r.get("reason") or r.get("error"): print("       (kg: %s %s)" % (r.get("reason"), str(r.get("error"))[:200]))
    s = short(r, figure(r.get("rows") or []))
    return dict(r, rows=[Short(s)]) if s else r
def source(url):
    for attempt in range(4):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if e.code in (429, 502, 503) and attempt < 3: time.sleep(2 ** attempt); continue
            raise
def ct(params): return source("https://clinicaltrials.gov/api/v2/studies?" + urllib.parse.urlencode(params))
def ct_all(params):
    ids, token = [], None
    while True:
        p = dict(params, pageSize=1000, fields="NCTId", **({"pageToken": token} if token else {}))
        r = ct(p); ids += [s["protocolSection"]["identificationModule"]["nctId"] for s in r.get("studies", [])]
        token = r.get("nextPageToken")
        if not token: return ids
def check(name, want, got):
    global fail
    ok = want == got
    print(("  ok   %s = %s" % (name, got)) if ok else ("  FAIL %s: expected %s, got %s" % (name, want, got)))
    if not ok: fail = 1
def at_most(name, limit, got, log=None):
    global fail
    ok = got is not None and got <= limit
    print(("  ok   %s: %s (at most %s)" % (name, got, limit)) if ok else ("  FAIL %s: %s, want at most %s" % (name, got, limit)))
    if not ok:
        fail = 1
        for line in (log or [])[:20]: print("         %s" % line)
def calls(r, pattern): return sum(1 for c in r.get("apiCallLog") or [] if re.search(pattern, str(c)))

DISEASE = "Long COVID"   # the views' default scope, resolved to the expression below
SCOPE = '"Long COVID" OR "Post-Acute Sequelae of SARS-CoV-2" OR PASC OR "Post-COVID Condition"'
# A trial is reached through the scope search that returned it: a ClinicalTrial is a record a search
# brought back, never one pinned from nowhere. So the single-trial checks take a trial FROM the
# default scope, chosen below from the registry itself.
COUNTRY = "Australia"

print("== L1: every view answers by name on its defaults ==")
V = {}
for name in ["DiseaseTrialRuns", "DiseaseTrials", "TrialProtocol", "TrialLandscape",
             "CompletedTrialsWithoutRegistryResults", "RecruitingTrialsByCountry"]:
    r = view(name); V[name] = r.get("data") or []
    s = short(r, len(V[name]))
    if s:
        print("  FAIL %-38s %s" % (name, s)); fail = 1; V[name] = [Short(s)]
    else: print("  ok   %-38s %d rows" % (name, len(V[name])))
for name in ["DiseaseTrialRuns", "DiseaseTrials", "TrialProtocol", "TrialLandscape"]:
    if not V[name]: print("  FAIL %s answered no rows on its defaults" % name); fail = 1

print("== L2: the realm's figures are the sources' figures ==")
run = (kg("MATCH (:DiseaseScope {registryQuery: '%s'})-[:HAS_TRIAL_SEARCH]->(r:TrialSearchRun) "
          "RETURN r.scopeQuery AS scopeQuery, r.sourceTotal AS sourceTotal, r.capped AS capped" % SCOPE.replace("'", "\\'"))
       .get("rows") or [{}])[0]
sent = SCOPE if isinstance(run, Short) else (run.get("scopeQuery") or SCOPE)
truth = ct_all({"query.cond": sent})
print("  registry expression: %s" % sent)
check("source total for the default scope", len(truth), run.get("sourceTotal"))
landscape = sorted({r["nctId"] for r in V["TrialLandscape"] if r.get("nctId")})
if not run.get("capped"): check("TrialLandscape trials = the registry's", sorted(truth), landscape)
recruiting = sorted(ct_all({"query.cond": sent, "filter.overallStatus": "RECRUITING",
                            "query.term": 'AREA[LocationCountry]"%s"' % COUNTRY}))
check("RecruitingTrialsByCountry(%s) = the registry's" % COUNTRY, recruiting,
      sorted({r["nctId"] for r in V["RecruitingTrialsByCountry"]}))
no_results = sorted(s["protocolSection"]["identificationModule"]["nctId"] for s in
                    ct({"query.cond": sent, "filter.overallStatus": "COMPLETED", "pageSize": 1000,
                        "fields": "NCTId,HasResults"}).get("studies", []) if not s.get("hasResults"))
check("CompletedTrialsWithoutRegistryResults = the registry's", no_results,
      sorted({r["nctId"] for r in V["CompletedTrialsWithoutRegistryResults"]}))

def fda_label(name):
    q = 'openfda.generic_name:"%s" OR openfda.brand_name:"%s"' % (name, name)
    r = source("https://api.fda.gov/drug/label.json?" + urllib.parse.urlencode({"search": q, "limit": 1}))
    return (r["results"][0].get("openfda", {}).get("application_number") or [None])[0] if r and r.get("results") else False
# The lowest NCT id in the scope that cites at least two PubMed articles and tests a drug openFDA has a
# label for, so every single-trial check has something to find.
cands = ct({"query.cond": sent, "pageSize": 1000, "fields": "NCTId,ReferencePMID,InterventionType,InterventionName"}).get("studies", [])
TRIAL = None
for s_ in sorted(cands, key=lambda s_: s_["protocolSection"]["identificationModule"]["nctId"]):
    p_ = s_["protocolSection"]
    if len([r for r in (p_.get("referencesModule") or {}).get("references", []) if r.get("pmid")]) < 2: continue
    names = [i["name"] for i in (p_.get("armsInterventionsModule") or {}).get("interventions", []) if i.get("type") == "DRUG"]
    if any(fda_label(n) is not False for n in names[:3]):
        TRIAL = p_["identificationModule"]["nctId"]; break
FIVE = sorted(truth)[:5]
print("  single-trial checks on %s; five-trial read on %s" % (TRIAL, FIVE))
# The trial is pinned by its NCT id, as TrialProtocol does: L1's scope views have already brought it
# back, so it is a record the world holds. A WHERE after the scope walk would not do: the detail hop's
# 20-anchor cap is applied before that filter, so the hop would read 20 arbitrary trials instead.
study = source("https://clinicaltrials.gov/api/v2/studies/%s" % TRIAL)["protocolSection"]
outcomes = sum(len(v) for v in (study.get("outcomesModule") or {}).values())
pmids = sorted({r["pmid"] for r in (study.get("referencesModule") or {}).get("references", []) if r.get("pmid")})
d = (kg("MATCH (t:ClinicalTrial {registryRecordId: '%s'})-[:HAS_CURRENT_DETAIL]->(d:TrialDetail) "
        "RETURN d.rawOutcomeCount AS outcomes, d.rawReferenceCount AS refs" % TRIAL).get("rows") or [{}])[0]
check("%s declared outcomes" % TRIAL, outcomes, d.get("outcomes"))
pubmed = source("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=" + ",".join(pmids))
held = sorted(u for u in pubmed["result"].get("uids", []) if "error" not in pubmed["result"][u])
pubs = kg("MATCH (t:ClinicalTrial {registryRecordId: '%s'})-[:HAS_CURRENT_DETAIL]->(:TrialDetail)-[:CITES_REFERENCE]->(r:TrialReference) "
          "MATCH (r)-[:RESOLVES_TO]->(p:Publication) RETURN DISTINCT p.pmid AS pmid, p.title AS title" % TRIAL).get("rows") or []
check("%s references resolved = PubMed's articles" % TRIAL, held, sorted(r["pmid"] for r in pubs))
titles = {u: pubmed["result"][u].get("title") for u in held}
check("  ...with PubMed's titles", 0, sum(1 for r in pubs if titles.get(r["pmid"]) != r.get("title")))

drugs = sorted({i["name"] for i in study["armsInterventionsModule"]["interventions"]})
labelled = {n: a for n, a in ((n, fda_label(n)) for n in drugs) if a is not False}
# The label hop is keyed on the trial's interventions, which only the search that returned the trial
# carries, so this one walks from the scope (a pinned trial holds its NCT id and nothing else).
r = kg("MATCH (:DiseaseScope {registryQuery: '%s'})-[:HAS_TRIAL_SEARCH]->(:TrialSearchRun)-[:RETURNED]->(t:ClinicalTrial) "
       "WHERE t.registryRecordId = '%s' MATCH (t)-[:TESTS_LABELLED_DRUG {ai: {fresh: true}}]->(d:DrugLabel) "
       "RETURN d.intervention AS drug, d.applicationNumber AS app, d.brandName AS brand, d.genericName AS generic" % (SCOPE.replace("'", "\\'"), TRIAL))
print("       label rows read cold: %s" % json.dumps(r.get("rows"))[:400])
check("%s label query answered" % TRIAL, True, not (r.get("reason") or r.get("error")))
check("%s drugs with an FDA label = openFDA's" % TRIAL, labelled, {x["drug"]: x["app"] for x in r.get("rows") or []})

print("== L3: what it costs ==")
# The status filter is pushed into the registry search, so a narrowed search fetches what it keeps.
total_recruiting = len(ct_all({"query.cond": sent, "filter.overallStatus": "RECRUITING"}))
r = kg("MATCH (:DiseaseScope {registryQuery: '%s'})-[:HAS_TRIAL_SEARCH {ai: {fresh: true}}]->(:TrialSearchRun)-[:RETURNED]->(t:ClinicalTrial) "
       "WHERE t.overallStatus = 'RECRUITING' RETURN count(t) AS n" % SCOPE.replace("'", "\\'"))
check("recruiting trials for the default scope", total_recruiting, ((r.get("rows") or [{}])[0]).get("n"))
at_most("  ...records fetched (the filter reached the registry)", total_recruiting + 1, r.get("fetchedRecords"), r.get("apiCallLog"))
# Several trials' details are one registry call (filter.ids), not one per trial.
# The five are named by id, so only they anchor the detail hop (a LIMIT after the scope walk would
# not narrow the hop's anchors).
r = kg("MATCH (t:ClinicalTrial) WHERE t.registryRecordId IN %s "
       "MATCH (t)-[:HAS_CURRENT_DETAIL {ai: {fresh: true}}]->(d:TrialDetail) RETURN count(d) AS n" % json.dumps(FIVE))
check("details for five trials", 5, ((r.get("rows") or [{}])[0]).get("n"))
check("  ...without a per-trial read", 0, calls(r, r"getStudy|/studies/NCT"))
at_most("  ...registry detail calls", 1, calls(r, r"trialDetailsByNct|detailsByNctIds"), r.get("apiCallLog"))
# A trial's references resolve in one ESummary call.
r = kg("MATCH (t:ClinicalTrial {registryRecordId: '%s'})-[:HAS_CURRENT_DETAIL]->(:TrialDetail)-[:CITES_REFERENCE]->(ref:TrialReference) "
       "MATCH (ref)-[:RESOLVES_TO {ai: {fresh: true}}]->(p:Publication) RETURN count(DISTINCT p) AS n" % TRIAL)
check("%s publications, read cold" % TRIAL, len(held), ((r.get("rows") or [{}])[0]).get("n"))
at_most("  ...PubMed calls", 1, calls(r, r"publicationsByPmid"), r.get("apiCallLog"))

if fail: print("DRIFT FOUND"); sys.exit(1)
print("ALL CHECKS PASS")
PY
