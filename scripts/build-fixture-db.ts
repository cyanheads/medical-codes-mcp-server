/**
 * @fileoverview Generate the small synthetic fixture database the test suite and
 * a local smoke run exercise. Hand-curated representative rows across ICD-10-CM,
 * ICD-10-PCS, and HCPCS Level II (RxNorm is phase 2 — intentionally empty here,
 * mirroring v1 scope and letting tests exercise the `direction_unavailable`
 * path). Writes to `data/medical-codes.db` by default — the bundled path the
 * service resolves when `MEDCODE_DB_PATH` is unset.
 *
 * Run: `bun run scripts/build-fixture-db.ts [outPath]`
 * @module scripts/build-fixture-db
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hcpcsParent, icd10cmChapterLetter, icd10cmParent } from '@/services/code-index/schema.js';
import type { SystemId } from '@/services/code-index/types.js';
import { type CodeInput, createDbWriter } from './_db-writer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
 * real edges. E11 (diabetes) and its children; I10 (hypertension); A00 cholera.
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
];

/** ICD-10-PCS rows (every complete 7-char code is billable; parent stays NULL). */
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
];

/**
 * PCS axis values (subset): position 1 = section, position 2 = body system, etc.
 * Enough for `medcode_browse_hierarchy` to return valid next-position values.
 */
const PCS_AXES: { position: number; value: string; meaning: string }[] = [
  { position: 1, value: '0', meaning: 'Medical and Surgical' },
  { position: 1, value: '1', meaning: 'Obstetrics' },
  { position: 1, value: '2', meaning: 'Placement' },
  { position: 2, value: 'D', meaning: 'Gastrointestinal System' },
  { position: 2, value: '2', meaning: 'Heart and Great Vessels' },
  { position: 3, value: 'T', meaning: 'Resection' },
  { position: 3, value: '7', meaning: 'Dilation' },
];

/** HCPCS Level II rows; one terminated to exercise the `terminated` status. */
const HCPCS: { code: string; short: string; long: string; terminated: string | null }[] = [
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
  const outArg = process.argv[2];
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
      billable: true,
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

  w.commit();

  const meta: { system: SystemId; releaseId: string; start: string; end: string; url: string }[] = [
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
  ];
  for (const m of meta) {
    w.writeMeta({
      system: m.system,
      releaseId: m.releaseId,
      effectiveStart: m.start,
      effectiveEnd: m.end,
      codeCount: w.countFor(m.system),
      sourceUrl: m.url,
    });
  }

  w.finalize();
  console.log(
    `Fixture DB written to ${outPath} — ICD10CM: ${ICD10CM.length}, ICD10PCS: ${ICD10PCS.length}, HCPCS: ${HCPCS.length} (RxNorm: 0, phase 2)`,
  );
}

main();
