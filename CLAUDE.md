# CLAUDE.md — Veterinarian Medical Director Candidate Sourcer

## Project Overview

This repository is a **Node.js tool** for sourcing and tracking Veterinarian Medical Director candidates. It reads/writes a local CSV file (`candidates.csv`) and is designed to be run on a schedule to accumulate candidate records over time.

---

## Repository Structure

```
Medical-Director-Dump/
├── candidate-sourcer.js   # Main application — CandidateSourcer class + entry point
├── config.js              # Search configuration (keywords, locations, job boards)
├── candidates.csv         # Persistent candidate data store (CSV format)
└── README.md              # Setup instructions
```

### File Responsibilities

| File | Purpose |
|---|---|
| `candidate-sourcer.js` | Core logic: load/save CSV, deduplicate, source candidates, generate report |
| `config.js` | All tunable parameters: search keywords, target locations, job boards, run interval |
| `candidates.csv` | Data file; header row + one candidate per line; committed to the repo |

---

## Architecture

### `CandidateSourcer` class (`candidate-sourcer.js`)

- **`constructor()`** — Sets file path and calls `loadCandidates()` on instantiation.
- **`loadCandidates()`** — Reads `candidates.csv`, parses CSV rows into objects with fields: `name`, `title`, `location`, `experience`, `source`, `date`.
- **`addCandidate(candidate)`** — Deduplicates by `(name, location)` (case-insensitive), appends to in-memory array, persists to CSV. Returns `true` if added, `false` if duplicate.
- **`saveCandidates()`** — Overwrites `candidates.csv` with current in-memory candidates array. No incremental appends — always full rewrite.
- **`sourceCandidates()`** — `async` method; currently uses simulated (hardcoded) candidate data. Iterates candidates, calls `addCandidate()` for each, logs summary. Returns count of newly added candidates.
- **`generateReport()`** — Prints the last 10 candidates to stdout in a formatted report.

**Entry point** (bottom of file): Creates a `CandidateSourcer` instance, runs `sourceCandidates()`, then `generateReport()`.

### `config.js`

Exports a plain object with:
- `searchKeywords` — Array of job title strings to search for.
- `locations` — Array of target US locations.
- `jobBoards` — Array of site hostnames to source from.
- `vetNetworks` — Array of veterinary professional organizations.
- `runInterval` — Minutes between runs (1440 = daily); scheduling is external to the script.
- `outputFormat` — Always `'csv'`.
- `minExperience` — Minimum years of experience filter (integer); used as a reference value but not enforced in the current sourcing logic.
- `saveLocation` — Relative path to the CSV output file (`'./candidates.csv'`).

---

## CSV Data Format

```
Name,Title,Location,Experience,Source,Date Added
Dr. Sarah Johnson,Medical Director,California,8 years,LinkedIn,2026-03-11
```

- **No quoting** of fields — commas within field values will break parsing.
- **Deduplication key**: `name` + `location` (normalized to lowercase).
- **Date format**: `YYYY-MM-DD` (ISO date, no time component).

---

## Development Conventions

- **Runtime**: Node.js (no `package.json` present — uses only built-in `fs` and `path` modules; no `npm install` is currently required despite the README).
- **Module system**: CommonJS (`require` / `module.exports`).
- **No test suite** exists at this time.
- **No linter or formatter** configuration exists at this time.
- Candidate sourcing is **simulated** (hardcoded array). Real integration with LinkedIn, Indeed, or VetMedJobs would replace the `simulatedCandidates` array inside `sourceCandidates()`.

---

## Running the Tool

```bash
node candidate-sourcer.js
```

Expected output:
```
🔍 Starting candidate sourcing...
📍 Searching for: Veterinarian Medical Director,DVM Medical Director,...
✓ Added: Dr. Sarah Johnson from California
...
✅ Sourcing complete! Added N new candidates.
📊 Total candidates: N

📋 CANDIDATE REPORT
======================================================================
...
```

---

## Key Conventions for AI Assistants

1. **CSV safety**: Field values must not contain commas. If adding quoting support, update both `loadCandidates()` (parsing) and `saveCandidates()` (serialization) together.
2. **Deduplication logic lives in `addCandidate()`** — do not bypass it by pushing directly to `this.candidates`.
3. **`saveCandidates()` is destructive** — it always rewrites the full file. Ensure `this.candidates` is fully loaded before calling it.
4. **`config.js` is the single source of truth** for all tunable parameters. Do not hardcode search keywords, locations, or paths elsewhere.
5. **`sourceCandidates()` is the extension point** — real scraping/API calls should replace or augment the `simulatedCandidates` array there.
6. **No external dependencies** are currently used. If adding packages, create a `package.json` first.
7. **`candidates.csv` is committed data** — treat changes to it as meaningful data changes, not build artifacts.
