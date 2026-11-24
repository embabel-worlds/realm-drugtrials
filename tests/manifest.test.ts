/*
 * The host checks every handler call against dist/manifest.json and refuses one that does not
 * match — and refuses outright a schema naming a type JSON Schema does not have. A trial's optional
 * `healthyVolunteers` flag was published as `{ type: "undefined" }` twice over, which made the whole
 * output schema of `searchByDisease` unreadable to a host that checks it.
 *
 * Each handler runs against a mocked registry and PubMed, once with a record as full as the registry
 * sends and once with one as bare as it sends, and what it returns is held to its published schema.
 */
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { detailsByNctIds, publicationsByPmid, searchByDisease } from "../src/api/whatsbeentried";

type Entry = { name: string; inputSchema: object; outputSchema: object };
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8")) as { entries: Entry[] };
const ajv = new Ajv({ allErrors: true });

const entry = (name: string): Entry => {
  const e = manifest.entries.find((x) => x.name === name);
  if (!e) throw new Error(`no manifest entry for ${name}`);
  return e;
};

/** Held to the published schema exactly as the host holds it: through JSON. */
const admitted = (schema: object, value: unknown): string[] => {
  const check = ajv.compile(schema);
  return check(JSON.parse(JSON.stringify(value ?? null))) ? [] : (check.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

const types = (schema: unknown): string[] =>
  !schema || typeof schema !== "object" ? []
    : Object.entries(schema).flatMap(([k, v]) => (k === "type" && (typeof v === "string" || Array.isArray(v)) ? [v].flat() : types(v)));

/** A trial as fully filled in as the registry sends one. */
const full = { protocolSection: {
  identificationModule: { nctId: "NCT00000001", briefTitle: "Trial one", officialTitle: "A trial" },
  statusModule: { overallStatus: "COMPLETED", lastUpdatePostDateStruct: { date: "2026-07-20" },
    startDateStruct: { date: "2020-01" }, completionDateStruct: { date: "2022-06-30" } },
  designModule: { studyType: "INTERVENTIONAL", phases: ["PHASE2", "PHASE3"], enrollmentInfo: { count: 120 } },
  eligibilityModule: { healthyVolunteers: true, sex: "ALL", minimumAge: "18 Years" },
  conditionsModule: { conditions: ["Long COVID"] },
  armsInterventionsModule: { interventions: [{ type: "DRUG", name: "Metformin" }] },
  outcomesModule: {
    primaryOutcomes: [{ measure: "Fatigue", timeFrame: "12 weeks" }],
    secondaryOutcomes: [{ measure: "Dyspnoea" }],
  },
  referencesModule: { references: [{ pmid: "123", type: "RESULT", citation: "A paper" }] },
}, hasResults: true };
/** A trial with only what identifies it. */
const bare = { protocolSection: { identificationModule: { nctId: "NCT00000002" } } };

const gateway = mockGateway<GenericGatewayContext>({
  clinicalTrials: {
    getVersion: async () => ({ apiVersion: "2.0.5", dataTimestamp: "2026-07-24T09:00:05" }),
    searchStudies: async () => ({ studies: [full, bare], totalCount: 2 }),
  },
  pubmed: {
    summarizePubmed: async () => ({ result: { uids: ["1", "2"], "1": { title: "One", pubdate: "2024 Jan", authors: [{ name: "A" }] }, "2": {} } }),
  },
});

describe("the published schemas", () => {
  it("use only JSON Schema types", () => {
    const allowed = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
    for (const e of manifest.entries) {
      expect(types(e.inputSchema).filter((t) => !allowed.has(t)), `${e.name} input`).toEqual([]);
      expect(types(e.outputSchema).filter((t) => !allowed.has(t)), `${e.name} output`).toEqual([]);
    }
  });

  it("compile, every one", () => {
    for (const e of manifest.entries) {
      expect(() => ajv.compile(e.inputSchema), `${e.name} input`).not.toThrow();
      expect(() => ajv.compile(e.outputSchema), `${e.name} output`).not.toThrow();
    }
  });
});

describe("each handler's call and reply, against its own schema", () => {
  it.each([
    ["searchByDisease", { queries: ["Long COVID"] }, () => searchByDisease(gateway, { queries: ["Long COVID"] })],
    ["detailsByNctIds", { nctIds: ["NCT00000001", "NCT00000002"] },
      () => detailsByNctIds(gateway, { nctIds: ["NCT00000001", "NCT00000002"] })],
    ["publicationsByPmid", { pmids: ["1", "2"] }, () => publicationsByPmid(gateway, { pmids: ["1", "2"] })],
  ] as const)("%s", async (name, args, call) => {
    const e = entry(name);
    expect(admitted(e.inputSchema, args), "input").toEqual([]);
    const reply = await call();
    expect((reply as unknown[]).length).toBeGreaterThan(0);
    expect(admitted(e.outputSchema, reply), "output").toEqual([]);
  });
});
