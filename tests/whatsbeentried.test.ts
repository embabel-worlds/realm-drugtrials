import { describe, expect, it, vi } from "vitest";
import { mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { detailsByNctIds, publicationsByPmid, searchByDisease } from "../src/api/whatsbeentried";
import { normalizeStudy } from "../src/lib/normalize";

const ctStudy = (id: string) => ({ protocolSection: {
  identificationModule: { nctId: id, briefTitle: `Trial ${id}` },
  statusModule: { overallStatus: "RECRUITING", lastUpdatePostDateStruct: { date: "2026-07-20" } },
  designModule: { studyType: "INTERVENTIONAL", phases: ["PHASE2"] },
} });

describe("live adapter orchestration", () => {
  it("pages a disease query and returns explicit complete coverage", async () => {
    const searchStudies = vi.fn()
      .mockResolvedValueOnce({ studies: [ctStudy("NCT00000001")], totalCount: 2, nextPageToken: "next" })
      .mockResolvedValueOnce({ studies: [ctStudy("NCT00000002")] });
    const ctx = mockGateway<GenericGatewayContext>({ clinicalTrials: {
      getVersion: vi.fn().mockResolvedValue({ apiVersion: "2.0.5", dataTimestamp: "2026-07-24T09:00:05" }),
      searchStudies,
    } });
    const [run] = await searchByDisease(ctx, { queries: ["Long COVID"] });
    expect(run.trials).toHaveLength(2);
    expect(run.coverage[0]).toMatchObject({ state: "COMPLETE", recordsFetched: 2, pagesFetched: 2 });
    expect(searchStudies).toHaveBeenNthCalledWith(2, expect.objectContaining({
      pageToken: "next", countTotal: false, fields: expect.stringContaining("HasResults"),
    }));
  });

  it("honours a caller-supplied sweep depth instead of a hardcoded cap", async () => {
    // Depth is CONFIG (the producer declares it), not a constant: 500 records was an
    // arbitrary ceiling nobody could reach. A capped sweep must still say so.
    const searchStudies = vi.fn()
      .mockResolvedValueOnce({ studies: [ctStudy("NCT00000001")], totalCount: 99, nextPageToken: "p2" })
      .mockResolvedValueOnce({ studies: [ctStudy("NCT00000002")], nextPageToken: "p3" });
    const ctx = mockGateway<GenericGatewayContext>({ clinicalTrials: {
      getVersion: vi.fn().mockResolvedValue({ apiVersion: "2.0.5", dataTimestamp: "2026-07-24T09:00:05" }),
      searchStudies,
    } });

    const [run] = await searchByDisease(ctx, { queries: ["Long COVID"], pageSize: 250, maxPages: 2 });

    expect(searchStudies).toHaveBeenCalledTimes(2);
    expect(searchStudies).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageSize: 250 }));
    expect(run.coverage[0]).toMatchObject({ state: "PARTIAL_PAGE_CAP", pagesFetched: 2 });
  });

  it("clamps a page size the source would reject", async () => {
    const searchStudies = vi.fn().mockResolvedValueOnce({ studies: [ctStudy("NCT00000001")], totalCount: 1 });
    const ctx = mockGateway<GenericGatewayContext>({ clinicalTrials: {
      getVersion: vi.fn().mockResolvedValue({ apiVersion: "2.0.5", dataTimestamp: "2026-07-24T09:00:05" }),
      searchStudies,
    } });

    await searchByDisease(ctx, { queries: ["Long COVID"], pageSize: 99999 });

    expect(searchStudies).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageSize: 1000 }));
  });

  it("deduplicates selected ids and fetches them in one registry call", async () => {
    const searchStudies = vi.fn().mockResolvedValue({ studies: [ctStudy("NCT00000001"), ctStudy("NCT00000002")] });
    const ctx = mockGateway<GenericGatewayContext>({ clinicalTrials: { searchStudies } });
    const detail = await detailsByNctIds(ctx, { nctIds: ["nct00000001", "NCT00000001", "NCT00000002"] });
    expect(detail).toHaveLength(2);
    expect(searchStudies).toHaveBeenCalledOnce();
    expect(searchStudies).toHaveBeenCalledWith(expect.objectContaining({ "filter.ids": "NCT00000001,NCT00000002" }));
  });

  it("resolves many PMIDs in one ESummary call", async () => {
    const summarizePubmed = vi.fn().mockResolvedValue({ result: {
      uids: ["1", "2"], "1": { title: "One" }, "2": { title: "Two" },
    } });
    const ctx = mockGateway<GenericGatewayContext>({ pubmed: { summarizePubmed } });
    const publications = await publicationsByPmid(ctx, { pmids: ["1", "2", "2"] });
    expect(publications).toHaveLength(2);
    expect(summarizePubmed).toHaveBeenCalledOnce();
    expect(summarizePubmed).toHaveBeenCalledWith(expect.objectContaining({ id: "1,2" }));
  });

  it("propagates a registry error instead of returning a false empty", async () => {
    const ctx = mockGateway<GenericGatewayContext>({ clinicalTrials: {
      getVersion: vi.fn().mockResolvedValue({ dataTimestamp: "2026-07-24" }),
      searchStudies: vi.fn().mockRejectedValue(new Error("429")),
    } });
    await expect(searchByDisease(ctx, { queries: ["Long COVID"] })).rejects.toThrow("429");
  });
});

describe("filters pushed to the registry", () => {
  const gateway = (searchStudies: ReturnType<typeof vi.fn>) =>
    mockGateway<GenericGatewayContext>({ clinicalTrials: {
      getVersion: vi.fn().mockResolvedValue({ apiVersion: "2.0.5", dataTimestamp: "2026-07-24T09:00:05" }),
      searchStudies,
    } });

  it("sends a rendered filter as query.term, and records it as coverage", async () => {
    // A filtered count is not a total. If coverage doesn't say what was scoped at the source, "113
    // trials" reads as the whole landscape rather than the recruiting slice of it.
    const searchStudies = vi.fn().mockResolvedValue({ studies: [ctStudy("NCT1")], totalCount: 1 });
    const [run] = await searchByDisease(gateway(searchStudies), {
      queries: ["Long COVID"],
      sourceFilters: "AREA[OverallStatus]RECRUITING",
    });

    expect(searchStudies).toHaveBeenCalledWith(expect.objectContaining({
      "query.term": "AREA[OverallStatus]RECRUITING",
    }));
    expect(run.coverage[0].sourceFilters).toBe("AREA[OverallStatus]RECRUITING");
  });

  it("omits query.term entirely when nothing was pushable", async () => {
    // Not the same as sending an empty term: an empty Essie expression is a syntax error at the
    // registry, which would turn "no filter" into "no results".
    const searchStudies = vi.fn().mockResolvedValue({ studies: [ctStudy("NCT1")] });
    const [run] = await searchByDisease(gateway(searchStudies), { queries: ["Long COVID"] });

    expect(searchStudies).toHaveBeenCalledWith(expect.not.objectContaining({ "query.term": expect.anything() }));
    expect(run.coverage[0].sourceFilters).toBeUndefined();
  });

  it("treats an unsubstituted placeholder as no filter rather than a search term", async () => {
    // If the slot is never filled the literal "{filters}" would otherwise be sent to the registry as
    // text to match, quietly returning nothing at all.
    const searchStudies = vi.fn().mockResolvedValue({ studies: [ctStudy("NCT1")] });
    await searchByDisease(gateway(searchStudies), { queries: ["Long COVID"], sourceFilters: "{filters}" });

    expect(searchStudies).toHaveBeenCalledWith(expect.not.objectContaining({ "query.term": expect.anything() }));
  });
});

describe("who may enrol", () => {
  const withSex = (sex?: string) => normalizeStudy({
    protocolSection: {
      identificationModule: { nctId: "NCT1", briefTitle: "t" },
      ...(sex ? { eligibilityModule: { sex } } : {}),
    },
  })!;

  it("treats a trial open to all as open to both", () => {
    // The defect this pins: filtering on sex = 'MALE' finds only male-ONLY trials — 3 of 723 for one
    // condition where 113 are actually open to men. "Open to men" showing almost nothing is a wrong
    // answer wearing the costume of an empty one.
    expect(withSex("ALL").openTo).toEqual(["MALE", "FEMALE"]);
  });

  it("keeps a single-sex trial single-sex", () => {
    expect(withSex("MALE").openTo).toEqual(["MALE"]);
    expect(withSex("FEMALE").openTo).toEqual(["FEMALE"]);
  });

  it("claims nothing when the registry states nothing", () => {
    expect(withSex().openTo).toEqual([]);
    expect(withSex().sex).toBeUndefined();
  });
});
