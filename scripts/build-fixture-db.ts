/**
 * @fileoverview Generate the small synthetic fixture database the test suite and
 * a local smoke run exercise. Hand-curated representative rows across all four
 * bundled systems — ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm (a small
 * drug graph with NDC and ingredient/brand edges so the drug crosswalk directions
 * and offline NDC decode have real data to resolve against) — plus a small
 * RxClass class layer over that drug graph. Writes to `data/medical-codes.db` by
 * default — the bundled path the service resolves when `MEDCODE_DB_PATH` is unset.
 * `--without-class-layer` drops the class tables, reproducing an index built
 * before the layer existed; `--empty-class-layer` keeps the tables and empties
 * them, reproducing an index built from sources with no RxClass cache.
 *
 * Run: `bun run scripts/build-fixture-db.ts [outPath] [--without-class-layer | --empty-class-layer]`
 * @module scripts/build-fixture-db
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hcpcsParent,
  icd10cmChapterLetter,
  icd10cmParent,
  RXCLASS_TABLES,
} from '@/services/code-index/schema.js';
import { RXCLASS_SOURCES, type RxClassSource, type SystemId } from '@/services/code-index/types.js';
import {
  type CodeInput,
  createDbWriter,
  type RxClassClassInput,
  type RxClassEdgeInput,
  type RxClassSourceInput,
} from './_db-writer.js';
import { hcpcsSectionRows, type RxNavConcept } from './ingest/parsers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Build the fixture as an index from before the RxClass layer: no class tables. */
const WITHOUT_CLASS_LAYER_FLAG = '--without-class-layer';

/** Build the fixture as an index built with no RxClass cache: empty class tables. */
const EMPTY_CLASS_LAYER_FLAG = '--empty-class-layer';

/**
 * RxNorm's `built_at`: the RxNav snapshot date, never the build time, exactly as
 * `build-index.ts` records it from the RxNav cache.
 */
const RXNAV_FETCHED_AT = '2026-06-22T00:44:15.018Z';

/** A compact spec for an ICD-10-CM code; parent/chapter are derived. */
interface CmSpec {
  billable: boolean;
  code: string; // storage form, no dot
  header: boolean;
  long: string;
  short: string;
}

/**
 * ICD-10-CM rows forming complete parent chains so hierarchy browse/map have
 * real edges. E11 (diabetes) and its children; I10 (hypertension); A00 cholera;
 * the A01 → A01.0 → A01.00 typhoid chain, whose leaf collides with the HCPCS
 * transport code `A0100` so the cross-system ambiguity contract has a fixture
 * case (the shipped corpus carries the same collision); and `B00`, which collides
 * with the ICD-10-PCS imaging table row of the same name below — the OTHER kind of
 * collision, where only one member matches a code shape, so the resolution stays
 * single and the excluded member is disclosed rather than reported as ambiguous.
 */
const ICD10CM: CmSpec[] = [
  {
    code: 'E11',
    short: 'Type 2 diabetes mellitus',
    long: 'Type 2 diabetes mellitus',
    billable: false,
    header: true,
  },
  {
    code: 'E119',
    short: 'Type 2 diab w/o complications',
    long: 'Type 2 diabetes mellitus without complications',
    billable: true,
    header: false,
  },
  {
    code: 'E1140',
    short: 'Type 2 diab w diab neuro, unsp',
    long: 'Type 2 diabetes mellitus with diabetic neuropathy, unspecified',
    billable: true,
    header: false,
  },
  {
    code: 'E1142',
    short: 'Type 2 diab w diab polyneurop',
    long: 'Type 2 diabetes mellitus with diabetic polyneuropathy',
    billable: true,
    header: false,
  },
  {
    code: 'I10',
    short: 'Essential (primary) hypertension',
    long: 'Essential (primary) hypertension',
    billable: true,
    header: false,
  },
  { code: 'A00', short: 'Cholera', long: 'Cholera', billable: false, header: true },
  {
    code: 'A000',
    short: 'Cholera d/t V. cholerae 01, biovar cholerae',
    long: 'Cholera due to Vibrio cholerae 01, biovar cholerae',
    billable: true,
    header: false,
  },
  {
    code: 'A001',
    short: 'Cholera d/t V. cholerae 01, biovar eltor',
    long: 'Cholera due to Vibrio cholerae 01, biovar eltor',
    billable: true,
    header: false,
  },
  {
    code: 'A01',
    short: 'Typhoid and paratyphoid fevers',
    long: 'Typhoid and paratyphoid fevers',
    billable: false,
    header: true,
  },
  { code: 'A010', short: 'Typhoid fever', long: 'Typhoid fever', billable: false, header: true },
  {
    code: 'A0100',
    short: 'Typhoid fever, unspecified',
    long: 'Typhoid fever, unspecified',
    billable: true,
    header: false,
  },
  {
    code: 'B00',
    short: 'Herpesviral [herpes simplex] infections',
    long: 'Herpesviral [herpes simplex] infections',
    billable: false,
    header: true,
  },
];

/**
 * ICD-10-PCS rows (parent stays NULL — the hierarchy is axis-based). Only a
 * complete 7-character code is billable, exactly as `parseIcd10pcsOrder` derives
 * it: the shorter entries are the table rows the order file also carries, and
 * `B00` is one of the 60 that share a code string with an ICD-10-CM category.
 */
const ICD10PCS: { code: string; short: string; long: string }[] = [
  {
    code: '0DTJ4ZZ',
    short: 'Resection of Appendix, Perc Endo Approach',
    long: 'Resection of Appendix, Percutaneous Endoscopic Approach',
  },
  {
    code: '0DTJ0ZZ',
    short: 'Resection of Appendix, Open Approach',
    long: 'Resection of Appendix, Open Approach',
  },
  {
    code: '02703DZ',
    short: 'Dilation of Cor Art, One Site w Intralum Dev',
    long: 'Dilation of Coronary Artery, One Site with Intraluminal Device, Percutaneous Approach',
  },
  {
    code: 'B00',
    short: 'Imaging, Central Nervous System, Plain Radiography',
    long: 'Imaging, Central Nervous System, Plain Radiography',
  },
];

/**
 * PCS axis values — only position 1 (Section), mirroring the shipped index. The
 * real build bakes only the 17 position-1 Section values; positions 2–7 are
 * context-dependent on the preceding axis path and are not enumerable from a flat
 * partial code (see `browsePcs`), so a partial PCS browse returns no axes plus a
 * notice. Seeding deeper positions here would let tests assert a next-position
 * expansion the shipped server does not implement.
 */
const PCS_AXES: { position: number; value: string; meaning: string }[] = [
  { position: 1, value: '0', meaning: 'Medical and Surgical' },
  { position: 1, value: '1', meaning: 'Obstetrics' },
  { position: 1, value: '2', meaning: 'Placement' },
];

/**
 * HCPCS Level II rows; one terminated to exercise the `terminated` status, and
 * `A0100` deliberately colliding with the ICD-10-CM typhoid leaf above.
 */
const HCPCS: { code: string; short: string; long: string; terminated: string | null }[] = [
  {
    code: 'A0100',
    short: 'Nonemergency transport taxi',
    long: 'Non-emergency transportation; taxi',
    terminated: null,
  },
  {
    code: 'J0120',
    short: 'Tetracycline injection',
    long: 'Injection, tetracycline, up to 250 mg',
    terminated: null,
  },
  {
    code: 'E0110',
    short: 'Crutches forearm pair',
    long: 'Crutches, forearm, includes crutches of various materials, adjustable or fixed, pair, complete with tips and handgrips',
    terminated: null,
  },
  {
    code: 'A4206',
    short: 'Syringe with needle, sterile 1cc',
    long: 'Syringe with needle, sterile, 1 cc or less, each',
    terminated: null,
  },
  {
    code: 'K0552',
    short: 'Sup/access ext infus pump,each',
    long: 'Supplies for external non-insulin drug infusion pump, syringe type cartridge, sterile, each',
    terminated: '20191231',
  },
];

/**
 * A small RxNorm drug graph: two ingredients, one brand, two products. The
 * products carry NDCs and ingredient/brand edges so the drug-crosswalk directions
 * and offline NDC decode resolve against real fixture rows. Concept rows mirror
 * what `parseRxNav` emits (code = RXCUI, longDesc = name, shortDesc/chapter = TTY),
 * including its `billable = 0` and `shortDesc = TTY` placeholders — the service
 * never reads those for RXNORM (both decode to null), so the fixture stores them
 * exactly as the real build does and the tests prove they stay unread.
 */
const RXNORM: RxNavConcept[] = [
  { rxcui: '161', name: 'acetaminophen', tty: 'IN' },
  { rxcui: '1191', name: 'aspirin', tty: 'IN' },
  { rxcui: '202433', name: 'Tylenol', tty: 'BN' },
  { rxcui: '198440', name: 'Acetaminophen 500 MG Oral Tablet', tty: 'SCD' },
  { rxcui: '1049640', name: 'Aspirin 325 MG Oral Tablet', tty: 'SCD' },
];

/**
 * NDC↔RXCUI map rows (stored 11-digit, as RxNav emits). 1049640 carries five
 * package NDCs — a deliberate high-fanout product, since a real RXCUI can map to
 * thousands of packages and `rxcui_to_ndc` pages through them; a single-NDC
 * fixture could never exercise a page split, a final short page, or a
 * cursor-walk reconstruction.
 */
const RXNORM_NDCS: { ndc: string; rxcui: string }[] = [
  { ndc: '11111222233', rxcui: '198440' }, // 5-4-2 hyphenated: 11111-2222-33
  { ndc: '00904516160', rxcui: '1049640' }, // 4-4-2 hyphenated: 0904-5161-60
  { ndc: '00904516140', rxcui: '1049640' },
  { ndc: '00904516161', rxcui: '1049640' },
  { ndc: '00904516180', rxcui: '1049640' },
  { ndc: '00904516189', rxcui: '1049640' },
];

/** has_ingredient / has_tradename edges keyed by the product RXCUI. */
const RXNORM_RELS: { rxcui: string; rel: string; target: string; targetType: string }[] = [
  { rxcui: '198440', rel: 'has_ingredient', target: '161', targetType: 'IN' },
  { rxcui: '198440', rel: 'has_tradename', target: '202433', targetType: 'BN' },
  { rxcui: '1049640', rel: 'has_ingredient', target: '1191', targetType: 'IN' },
];

/**
 * A small RxClass class layer over the drug graph above, with real class IDs and
 * names from RxClass. Edges attach where RxClass attaches them — at the
 * ingredient for MED-RT and FDA classes, at the product for VA classes — so:
 *
 *  - product 198440 carries its own VA edge and inherits 161's ingredient edges
 *    through `has_ingredient`; product 1049640 has no edge of its own and inherits
 *    1191's, including two FDA EPC classes;
 *  - PE `N0000008836` has two members (both ingredients);
 *  - DISEASE `D010146` "Pain" reaches 161 under two relations (`may_treat`,
 *    `may_prevent`) and `D004342` under a contraindication (`ci_with`);
 *  - brand 202433 (Tylenol) has no edge at all;
 *  - VA `CN100` "ANALGESICS" and EPC `N0000193873` "Diuretic" are class nodes with
 *    no direct member (hierarchy parents);
 *  - SCHEDULE `SCHEDULE2` is a node with no member in this graph.
 */
const RXCLASS_CLASSES: RxClassClassInput[] = [
  { classType: 'EPC', classId: 'N0000175722', className: 'Nonsteroidal Anti-inflammatory Drug' },
  { classType: 'EPC', classId: 'N0000175578', className: 'Platelet Aggregation Inhibitor' },
  { classType: 'EPC', classId: 'N0000193873', className: 'Diuretic' },
  { classType: 'MOA', classId: 'N0000000160', className: 'Cyclooxygenase Inhibitors' },
  { classType: 'MOA', classId: 'N0000000108', className: 'Prostaglandin Receptor Antagonists' },
  { classType: 'PE', classId: 'N0000008836', className: 'Decreased Prostaglandin Production' },
  { classType: 'DISEASE', classId: 'D010146', className: 'Pain' },
  { classType: 'DISEASE', classId: 'D004342', className: 'Drug Hypersensitivity' },
  { classType: 'CHEM', classId: 'D000082', className: 'Acetaminophen' },
  { classType: 'VA', classId: 'CN100', className: 'ANALGESICS' },
  { classType: 'VA', classId: 'CN103', className: 'NON-OPIOID ANALGESICS' },
  { classType: 'SCHEDULE', classId: 'SCHEDULE2', className: 'SCHEDULE II' },
];

const RXCLASS_EDGES: RxClassEdgeInput[] = [
  { rxcui: '161', classType: 'MOA', classId: 'N0000000108', source: 'MEDRT', relation: 'has_moa' },
  { rxcui: '161', classType: 'PE', classId: 'N0000008836', source: 'MEDRT', relation: 'has_pe' },
  {
    rxcui: '161',
    classType: 'DISEASE',
    classId: 'D010146',
    source: 'MEDRT',
    relation: 'may_treat',
  },
  {
    rxcui: '161',
    classType: 'DISEASE',
    classId: 'D010146',
    source: 'MEDRT',
    relation: 'may_prevent',
  },
  { rxcui: '161', classType: 'DISEASE', classId: 'D004342', source: 'MEDRT', relation: 'ci_with' },
  {
    rxcui: '161',
    classType: 'CHEM',
    classId: 'D000082',
    source: 'MEDRT',
    relation: 'has_ingredient',
  },
  {
    rxcui: '1191',
    classType: 'EPC',
    classId: 'N0000175722',
    source: 'FDASPL',
    relation: 'has_epc',
  },
  {
    rxcui: '1191',
    classType: 'EPC',
    classId: 'N0000175578',
    source: 'FDASPL',
    relation: 'has_epc',
  },
  { rxcui: '1191', classType: 'MOA', classId: 'N0000000160', source: 'MEDRT', relation: 'has_moa' },
  { rxcui: '1191', classType: 'PE', classId: 'N0000008836', source: 'MEDRT', relation: 'has_pe' },
  { rxcui: '198440', classType: 'VA', classId: 'CN103', source: 'VA', relation: 'has_vaclass' },
];

/** Per-source provenance rows, with the versions RxClass reported on 2026-09-24. */
const RXCLASS_VERSIONS: Record<RxClassSource, string | null> = {
  MEDRT: '2026.07.06',
  FDASPL: 'MEDRT 2026.07.06',
  FMTSME: 'MEDRT 2026.07.06',
  VA: '2026_07_31',
  RXNORM: '08-Sep-2026',
  CDC: null,
};

function rxclassSourceRows(): RxClassSourceInput[] {
  return RXCLASS_SOURCES.map((source) => {
    const own = RXCLASS_EDGES.filter((e) => e.source === source);
    return {
      source,
      version: RXCLASS_VERSIONS[source],
      classCount: new Set(own.map((e) => `${e.classType}|${e.classId}`)).size,
      edgeCount: own.length,
      fetchedAt: '2026-09-24T18:18:35.103Z',
    };
  });
}

function rxnormRow(c: RxNavConcept): CodeInput {
  return {
    system: 'RXNORM',
    code: c.rxcui,
    shortDesc: c.tty,
    longDesc: c.name,
    billable: false,
    header: false,
    chapter: c.tty,
    parent: null,
    effective: null,
    terminated: null,
  };
}

function cmRow(spec: CmSpec): CodeInput {
  return {
    system: 'ICD10CM',
    code: spec.code,
    shortDesc: spec.short,
    longDesc: spec.long,
    billable: spec.billable,
    header: spec.header,
    chapter: icd10cmChapterLetter(spec.code),
    parent: icd10cmParent(spec.code),
    effective: null,
    terminated: null,
  };
}

function main(): void {
  const withoutClassLayer = process.argv.includes(WITHOUT_CLASS_LAYER_FLAG);
  const emptyClassLayer = process.argv.includes(EMPTY_CLASS_LAYER_FLAG);
  const outArg = process.argv
    .slice(2)
    .find((a) => a !== WITHOUT_CLASS_LAYER_FLAG && a !== EMPTY_CLASS_LAYER_FLAG);
  const outPath = outArg ? outArg : join(ROOT, 'data', 'medical-codes.db');
  mkdirSync(dirname(outPath), { recursive: true });

  // bun:sqlite opens existing files; remove any prior fixture for a clean build.
  try {
    const { unlinkSync } = require('node:fs');
    unlinkSync(outPath);
  } catch {
    // not present — fine
  }

  const w = createDbWriter(outPath);
  w.begin();

  for (const spec of ICD10CM) w.addCode(cmRow(spec));

  for (const pcs of ICD10PCS) {
    w.addCode({
      system: 'ICD10PCS',
      code: pcs.code,
      shortDesc: pcs.short,
      longDesc: pcs.long,
      billable: pcs.code.length === 7,
      header: false,
      chapter: pcs.code.charAt(0),
      parent: null,
      effective: null,
      terminated: null,
    });
  }
  for (const ax of PCS_AXES) w.addPcsAxis(ax.position, ax.value, ax.meaning);

  for (const h of HCPCS) {
    w.addCode({
      system: 'HCPCS',
      code: h.code,
      shortDesc: h.short,
      longDesc: h.long,
      billable: !h.terminated,
      header: false,
      chapter: h.code.charAt(0),
      parent: hcpcsParent(h.code),
      effective: null,
      terminated: h.terminated,
    });
  }
  // Seed the HCPCS letter-range bucket headers exactly as the real build does
  // (scripts/build-index.ts), so hierarchy tests exercise top-level HCPCS browse
  // and browse-by-bucket against the same shape the shipped index carries.
  for (const b of hcpcsSectionRows(HCPCS.map((h) => h.code.charAt(0)))) w.addCode(b);

  // RxNorm drug graph: concepts (codes), ingredient/brand edges, and the NDC map.
  for (const c of RXNORM) w.addCode(rxnormRow(c));
  for (const e of RXNORM_RELS) w.addRxNormRel(e.rxcui, e.rel, e.target, e.targetType);
  for (const n of RXNORM_NDCS) w.addNdc(n.ndc, n.rxcui);

  for (const c of RXCLASS_CLASSES) w.addRxClassClass(c);
  for (const e of RXCLASS_EDGES) w.addRxClassEdge(e);
  for (const s of rxclassSourceRows()) w.writeRxClassSource(s);

  w.commit();

  const meta: {
    system: SystemId;
    releaseId: string;
    start: string | null;
    end: string | null;
    url: string;
  }[] = [
    {
      system: 'ICD10CM',
      releaseId: 'ICD-10-CM FY2026 (fixture)',
      start: '2025-10-01',
      end: '2026-09-30',
      url: 'https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/',
    },
    {
      system: 'ICD10PCS',
      releaseId: 'ICD-10-PCS FY2026 (fixture)',
      start: '2025-10-01',
      end: '2026-09-30',
      url: 'https://www.cms.gov/medicare/coding-billing/icd-10-codes',
    },
    {
      system: 'HCPCS',
      releaseId: 'HCPCS 2026 (fixture)',
      start: '2026-01-01',
      end: '2026-12-31',
      url: 'https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system',
    },
    {
      system: 'RXNORM',
      releaseId: 'RxNorm (current normalized set) (fixture)',
      start: null,
      end: null,
      url: 'https://rxnav.nlm.nih.gov/',
    },
  ];
  for (const m of meta) {
    w.writeMeta({
      system: m.system,
      releaseId: m.releaseId,
      effectiveStart: m.start,
      effectiveEnd: m.end,
      codeCount: w.countFor(m.system),
      sourceUrl: m.url,
      ...(m.system === 'RXNORM' ? { builtAt: RXNAV_FETCHED_AT } : {}),
    });
  }

  w.finalize();

  // An index built before the class layer existed has no class tables at all; one
  // built from sources with no RxClass cache has the tables and no rows.
  if (withoutClassLayer || emptyClassLayer) {
    const db = new Database(outPath);
    for (const table of RXCLASS_TABLES) {
      db.run(withoutClassLayer ? `DROP TABLE ${table}` : `DELETE FROM ${table}`);
    }
    db.run('VACUUM');
    db.close();
  }

  console.log(
    `Fixture DB written to ${outPath} — ICD10CM: ${ICD10CM.length}, ICD10PCS: ${ICD10PCS.length}, HCPCS: ${HCPCS.length}, RxNorm: ${RXNORM.length} concepts / ${RXNORM_RELS.length} edges / ${RXNORM_NDCS.length} NDCs, ` +
      (withoutClassLayer
        ? 'no RxClass layer'
        : emptyClassLayer
          ? 'empty RxClass tables'
          : `RxClass: ${RXCLASS_CLASSES.length} classes / ${RXCLASS_EDGES.length} edges`),
  );
}

main();
