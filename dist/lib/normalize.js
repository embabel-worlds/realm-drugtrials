"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeStudy = normalizeStudy;
exports.normalizeDetail = normalizeDetail;
exports.normalizePubmed = normalizePubmed;
const unique = (values) => [...new Set(values.filter((v) => !!v && v.trim().length > 0))];
function normalizeStudy(study) {
    const p = study.protocolSection;
    const id = p?.identificationModule?.nctId;
    if (!id)
        return undefined;
    const status = p?.statusModule;
    const design = p?.designModule;
    const sponsor = p?.sponsorCollaboratorsModule;
    const interventions = p?.armsInterventionsModule?.interventions ?? [];
    const locations = p?.contactsLocationsModule?.locations ?? [];
    const countries = unique(locations.map((l) => l.country));
    // A facility is where a trial actually runs — a hospital, a university, a clinic. The registry
    // repeats it once per site, so the same institution appears many times in one trial.
    const facilities = unique(locations.map((l) => l.facility));
    const officials = p?.contactsLocationsModule?.overallOfficials ?? [];
    const eligibility = p?.eligibilityModule;
    return {
        registryRecordId: id,
        nctId: id,
        title: p?.identificationModule?.briefTitle || p?.identificationModule?.officialTitle || id,
        officialTitle: p?.identificationModule?.officialTitle,
        overallStatus: status?.overallStatus,
        studyType: design?.studyType,
        phases: design?.phases ?? [],
        sponsor: sponsor?.leadSponsor?.name,
        sponsorClass: sponsor?.leadSponsor?.class,
        collaborators: unique((sponsor?.collaborators ?? []).map((c) => c.name)),
        conditions: p?.conditionsModule?.conditions ?? [],
        keywords: p?.conditionsModule?.keywords ?? [],
        interventions: unique(interventions.map((i) => i.name)),
        interventionTypes: unique(interventions.map((i) => i.type)),
        countries,
        facilities,
        investigators: unique(officials.map((o) => o.name)),
        investigatorAffiliations: unique(officials.map((o) => o.affiliation)),
        // Eligibility as the registry states it. `stdAges` is the registry's OWN cohort vocabulary
        // (CHILD / ADULT / OLDER_ADULT); it is carried verbatim rather than derived from the age bounds,
        // because a trial can declare a cohort whose bounds don't imply it and the registry's own label is
        // what a reader of the record would see.
        sex: eligibility?.sex,
        // WHO MAY ENROL, which is not the same question as what the registry's `sex` field says. A trial
        // whose sex is ALL is open to men AND women; filtering on sex = 'MALE' finds only the trials
        // restricted to men — 3 of 723 for one condition, where 113 are actually open to them. Asking
        // "open to men" and being shown male-ONLY trials is a wrong answer that looks like an empty one.
        openTo: eligibility?.sex === "ALL" ? ["MALE", "FEMALE"]
            : eligibility?.sex ? [eligibility.sex]
                : [],
        minimumAge: eligibility?.minimumAge,
        maximumAge: eligibility?.maximumAge,
        ageGroups: eligibility?.stdAges ?? [],
        healthyVolunteers: eligibility?.healthyVolunteers,
        enrollment: design?.enrollmentInfo?.count,
        startDate: status?.startDateStruct?.date,
        primaryCompletionDate: status?.primaryCompletionDateStruct?.date,
        completionDate: status?.completionDateStruct?.date,
        firstPosted: status?.studyFirstPostDateStruct?.date,
        lastUpdated: status?.lastUpdatePostDateStruct?.date,
        hasResults: study.hasResults ?? study.resultsSection != null,
        whyStopped: status?.whyStopped,
        registryUrl: `https://clinicaltrials.gov/study/${encodeURIComponent(id)}`,
    };
}
function outcomesFor(study, nctId) {
    const o = study.protocolSection?.outcomesModule;
    const groups = [
        ["PRIMARY", o?.primaryOutcomes],
        ["SECONDARY", o?.secondaryOutcomes],
        ["OTHER", o?.otherOutcomes],
    ];
    return groups.flatMap(([outcomeType, items]) => (items ?? []).map((item, i) => ({
        outcomeId: `${nctId}:${outcomeType}:${i + 1}`,
        nctId,
        outcomeType,
        ordinal: i + 1,
        measure: item.measure,
        description: item.description,
        timeFrame: item.timeFrame,
    })));
}
function referencesFor(study, nctId) {
    return (study.protocolSection?.referencesModule?.references ?? [])
        .filter((r) => !!r.pmid)
        .map((r, i) => ({
        referenceId: `${nctId}:${r.pmid}:${i + 1}`,
        nctId,
        pmid: r.pmid,
        type: r.type,
        citation: r.citation,
    }));
}
function normalizeDetail(study) {
    const p = study.protocolSection;
    const id = p?.identificationModule?.nctId;
    if (!id)
        return undefined;
    const outcomes = outcomesFor(study, id);
    const references = referencesFor(study, id);
    return {
        detailId: `clinicaltrials.gov:${id}`,
        nctId: id,
        briefSummary: p?.descriptionModule?.briefSummary,
        detailedDescription: p?.descriptionModule?.detailedDescription,
        enrollment: p?.designModule?.enrollmentInfo?.count,
        sourceUpdatedAt: p?.statusModule?.lastUpdatePostDateStruct?.date,
        hasResults: study.hasResults ?? study.resultsSection != null,
        rawOutcomeCount: outcomes.length,
        rawReferenceCount: references.length,
        outcomes,
        references,
    };
}
function normalizePubmed(response) {
    const result = response.result;
    if (!result)
        return [];
    return (result.uids ?? []).flatMap((pmid) => {
        const value = result[pmid];
        if (!value || Array.isArray(value))
            return [];
        const doi = value.articleids?.find((id) => id.idtype === "doi")?.value;
        return [{
                pmid,
                title: value.title,
                publishedDate: value.pubdate,
                journal: value.fulljournalname || value.source,
                authorNames: unique((value.authors ?? []).map((a) => a.name)),
                doi,
                pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`,
            }];
    });
}
