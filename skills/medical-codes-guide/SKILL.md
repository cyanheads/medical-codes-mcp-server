---
name: medical-codes-guide
description: Judgment for the medcode_* tools (ICD-10-CM, ICD-10-PCS, HCPCS Level II, RxNorm, RxClass). Use when validating claim codes, decoding codes of unknown system, finding a code from a clinical description, replacing a retired code, or chaining a drug name to products, NDCs, and drug classes. Covers what the server cannot answer, search wording, system choice, and where each RXCUI, NDC, and class ID comes from.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Offline and keyless. Each system carries exactly one release: the current ICD-10-CM and ICD-10-PCS fiscal year, the current HCPCS Level II quarter, and the current RxNorm normalized set, with an RxClass layer over it. `medcode_list_systems` names each release and its effective window.

Not here, so say so instead of searching for a stand-in:

- **CPT / HCPCS Level I** (five-digit numeric codes such as 99213). A `medcode_get_code` or `medcode_check_code` miss names them out of scope; a search simply finds nothing. Never offer a HCPCS Level II or ICD-10-PCS code as "the CPT equivalent".
- **SNOMED CT, LOINC, ICD-9-CM, ICD-11, the WHO ICD-10 base, MS-DRG, and ATC drug classes.** A dotted all-digit value such as `250.00` or `724.2` is ICD-9-CM, never an RXCUI: every tool misses it and says ICD-9-CM is not bundled. The exception is a three-character procedure category, which every system but RxNorm reads dot-blind: `00.1` decodes as the ICD-10-PCS table row `001`, a different code, so never report that answer for an ICD-9-CM value.
- **Prior releases and successor links.** No tool maps an old code to its replacement, a diagnosis to a procedure or HCPCS code, or an NDC to a HCPCS drug code.
- **Coding rules and payment.** Records carry descriptions, billability, and hierarchy only. They carry no Excludes1/Excludes2 or code-first notes, no sequencing rules, no coverage policy (NCD/LCD), and no pricing.
- **Drug labels and safety data.** Take the NDC or drug name to the openfda server.

## Identifiers

| Identifier | Example | Where it comes from |
|:--|:--|:--|
| ICD-10-CM code | `E11.9`, `T36.0X1A` | `medcode_search_codes`, `medcode_browse_hierarchy`, `medcode_map_codes` children |
| ICD-10-PCS code | `0DTJ4ZZ` | `medcode_search_codes`, or `medcode_map_codes` children of its table row (`0DT`); browsing stops at the 17 sections |
| HCPCS Level II code | `J9271` | `medcode_search_codes`, `medcode_browse_hierarchy` |
| RXCUI | `6809` (ingredient), `861007` (product) | `medcode_map_codes` name_to_rxcui, `medcode_search_codes` in RXNORM, or an NDC decoded by `medcode_get_code` |
| NDC | `00093104801` | `medcode_map_codes` rxcui_to_ndc (11 digits, no hyphens), or the package label (`0093-1048-01`) |
| RxClass class ID | `N0000000181`, `D006973`, `CV800`, `SCHEDULE2` | `medcode_map_codes` rxcui_to_classes only; there is no class-name search |

## Gates

1. **Choose the system from where the code came from, not from its shape.** A diagnosis field is ICD-10-CM, an inpatient procedure field ICD-10-PCS, and a supply, drug, or service line HCPCS. An undotted letter plus four digits can be both an ICD-10-CM code and a HCPCS code: `A0100` and `J0120` come back ambiguous between ICD10CM and HCPCS, while the dotted `A01.00` resolves to ICD-10-CM. When the context tells you the system, pass it.
2. **A verdict holds for today and the bundled release only.** `medcode_check_code` takes no date of service. Before validating a claim, compare its date of service with the effective windows from `medcode_list_systems`. When it falls outside them, report that this server cannot validate it rather than passing on today's verdict.
3. **`valid_billable` means reportable, not correct or payable.** It says the code is a complete leaf in this release. Never claim that a code pair, sequence, or claim passes coding edits or coverage on the strength of it.
4. **A header is where the search starts.** For `valid_header` or `valid_not_billable`, the billable code sits below. Children come one level per call, and ICD-10-CM chains run through placeholder and 7th-character levels (`T36.0X` → `T36.0X1` → `T36.0X1A`), so keep walking until `billable` is true. A padding level that is not a code is skipped: `S82.66` lists `S82.66XA` directly. Never pad a code with X or a 7th character yourself; take the child the tool returns.
5. **Treat an empty class result as unknown, not as a negative finding.** Class coverage is uneven across types. Lisinopril has no EPC class here, but it has the MOA class "Angiotensin-converting Enzyme Inhibitors" (`N0000000181`), and its products carry VA class `CV800` "ACE INHIBITORS". Check the other class types before saying a drug lacks a pharmacology.
6. **DISEASE classes are MeSH descriptors, not diagnosis codes.** `D006973` is MeSH "Hypertension". To get the ICD-10-CM code for a disease a drug may treat, search the disease name with `medcode_search_codes`.

## Workflows

### Wording a search

`medcode_search_codes` matches words, not meaning:

- **Every word is required, stopwords included.** In ICD-10-CM, "diabetes of the kidney" finds nothing, while "diabetes kidney" finds `E11.2` and the other "diabetes mellitus with kidney complications" categories.
- **Words match independently, not as a phrase.** "type 2 diabetes mellitus" also returns `E10.A2` ("Type 1 diabetes mellitus, presymptomatic, Stage 2"). Read every row before taking one.
- **There are no operators.** OR, quotation marks, and a leading minus are ordinary text: "-neuropathy" still requires the word neuropathy.
- **There are no synonyms or abbreviations.** "heart attack" and "T2DM" find nothing. Use the vocabulary of the official titles: myocardial infarction, hypertension, fracture, neoplasm.
- **An extra qualifier drops codes whose title lacks it.** "acute myocardial infarction" misses `I21.01` (STEMI) and `I21.4` (NSTEMI), whose titles never say "acute". Start with two or three core words, then narrow with the system and billable-only filters.
- **ICD-10-PCS titles use root-operation and approach terms.** "laparoscopic appendectomy" finds nothing, while "resection appendix percutaneous endoscopic" finds `0DTJ4ZZ`. Approaches read Open Approach, Percutaneous Endoscopic Approach, or Via Natural or Artificial Opening. A PCS code's chapter is its section character (`0` is Medical and Surgical).
- **Brand names match RxNorm only.** HCPCS drug descriptors use the generic name and the billing unit ("Injection, pembrolizumab, 1 mg"). For a brand, map a branded product to its ingredient with rxcui_to_ingredients (Keytruda `1657751` → pembrolizumab), then search HCPCS for the ingredient.

### Validating claim codes

1. Decode the batch with `medcode_get_code`. Pass `system` when every code comes from one field. A reply carrying `deferred` stopped at its byte budget: re-call with those codes and the same `system` and `includeHierarchy` until none come back deferred, and only then treat the batch as decoded.
2. Check each code with `medcode_check_code` against Gates 2–4.
3. For a header, walk `medcode_map_codes` children to the billable leaves. A billable-only search on the header's title words also lists candidates, but the matches are not confined to that subtree: "type 2 diabetes mellitus" pulls in the `O24.1-` pregnancy codes. Filter the results by code prefix yourself.

### Replacing a retired code

- **ICD-10-CM expanded at a fiscal-year update:** the old code stays as a non-billable header, and its children are the replacements. `M51.36` checks as `valid_header`, with children `M51.360`, `M51.361`, `M51.362`, and `M51.369`.
- **ICD-10-CM no longer in the release:** the code answers `unknown_code`, and nothing names its successor. Search the key words of its old title.
- **HCPCS terminated:** the result is `terminated` with the last valid date. Search the descriptor's drug or service name for a current code. `C9027` and `J9271` are both "Injection, pembrolizumab, 1 mg"; `C9027` is terminated and `J9271` is billable.

### Drug name → product → NDCs

1. name_to_rxcui mixes ingredients, combinations, and products; each hit's `conceptType` says which. Keep the `SCD` (generic product) and `SBD` (branded product) hits: "metformin" returns `6809` (`IN`) and `285129` (`MIN`) ahead of products such as `860975` (`SCD`). To narrow by strength, search RXNORM with the chapter set to `SCD` or `SBD`; a row's chapter is its term type. "metformin 500 MG" with chapter `SCD` returns `861007` "metformin hydrochloride 500 MG Oral Tablet", alongside combination products that contain it.
2. NDCs sit on products: an ingredient such as `6809` returns none.
3. rxcui_to_ndc returns 11-digit NDCs without hyphens. `medcode_get_code` decodes that form, and the label's hyphenated form, back to the product.

### Drug class → member drugs

1. Find the class ID with rxcui_to_classes on a drug known to belong to the class. Lisinopril `29046` yields `N0000000181`. Then list the class with class_to_rxcuis.
2. Read each hit's relation before counting. A relation starting `ci_` marks a drug contraindicated with the class, not a member: `N0000000181` lists fosinopril and aliskiren as `ci_moa`. Keep the member relation (`has_moa` here), then dedupe by RXCUI, since a drug appears once per asserting source: captopril is listed twice, once from FDASPL and once from MEDRT.
3. The member level depends on the class type. MOA and EPC classes list ingredients, both base (IN) and salt-form (PIN): `N0000000181` lists captopril, enalapril, and lisinopril alongside perindopril erbumine. VA and SCHEDULE classes list products: `CV800` lists products such as "lisinopril 10 MG Oral Tablet [Zestril]".
4. A broad class can have no direct members. EPC "Diuretic" (`N0000193873`) comes back empty, because its drugs attach to narrower classes. Take a narrower class from a member drug instead.

### ICD-10-PCS

A section value the browse lists (`0`, `B`) is not a code: sent back under ICD10PCS, it misses with a note naming the section. The axes below the section are not enumerable, and sections and body systems are not codes. A three-character table row such as `0DT` ("Gastrointestinal System, Resection") is a header: it checks as `valid_header`, `medcode_map_codes` children lists the complete codes that begin with it (page with `nextCursor`; the largest table holds 1,560), and parents on a complete code returns its table row. Pass `system: "ICD10PCS"` when walking a table row: 61 of them (`B00`, `F07`) are also ICD-10-CM categories, and without it the walk lists the ICD-10-CM category's children. Find a table row or code through `medcode_search_codes` with PCS vocabulary. `medcode_get_code` decodes a complete code to its title, which names the operation, body part, and approach in prose, not position by position.
