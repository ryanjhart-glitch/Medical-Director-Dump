# CLAUDE.md — Veterinarian Medical Director Candidate Sourcer

## Project Overview

A **Node.js daily automation tool** that sources Veterinarian Medical Director candidates, stores them in a local CSV file, and emails an HTML report of new candidates each run. Designed to run unattended via Windows Task Scheduler.

---

## Repository Structure

```
Medical-Director-Dump/
├── candidate-sourcer.js   # Main app — CandidateSourcer class + entry point
├── config.js              # Search configuration (keywords, locations, job boards)
├── mailer.js              # Email notification module (nodemailer/Gmail)
├── candidates.csv         # Persistent candidate data store (CSV)
├── run.bat                # Windows Task Scheduler launcher
├── package.json           # Node.js dependencies (nodemailer, dotenv)
├── .env.example           # Template for required environment variables
├── .gitignore             # Ignores node_modules/, .env, *.log
└── README.md              # Setup and Task Scheduler instructions
```

### File Responsibilities

| File | Purpose |
|---|---|
| `candidate-sourcer.js` | Core logic: load/save CSV, deduplicate, source candidates, call mailer, generate console report |
| `config.js` | All tunable parameters: search keywords, target locations, job boards, run interval |
| `mailer.js` | Builds and sends an HTML email report via Gmail SMTP (nodemailer) |
| `candidates.csv` | Data file; header row + one candidate per line; committed to the repo |
| `run.bat` | Batch launcher: `cd` to repo root → `node candidate-sourcer.js` → log to `run.log` |
| `.env` | Runtime secrets (gitignored); copy from `.env.example` and fill in |

---

## Architecture

### `CandidateSourcer` class (`candidate-sourcer.js`)

- **`constructor()`** — Sets file path and calls `loadCandidates()` on instantiation.
- **`loadCandidates()`** — Reads `candidates.csv`, parses CSV rows into objects: `name`, `title`, `location`, `experience`, `source`, `date`.
- **`addCandidate(candidate)`** — Deduplicates by `(name, location)` (case-insensitive), appends to in-memory array, persists to CSV. Returns `true` if added, `false` if duplicate.
- **`saveCandidates()`** — Overwrites `candidates.csv` with current in-memory array (always full rewrite — not incremental).
- **`sourceCandidates()`** — `async`; currently uses simulated (hardcoded) candidate data. Collects newly added candidates into an array, calls `sendDailyReport()`, returns count of new candidates. **This is the extension point for real job board integrations.**
- **`generateReport()`** — Prints the last 10 candidates to stdout in a formatted console report.

**Entry point** (bottom of file): Instantiates `CandidateSourcer`, runs `sourceCandidates()` (which triggers email), then `generateReport()`.

### `mailer.js`

- Reads `EMAIL_FROM`, `EMAIL_APP_PASSWORD`, `EMAIL_TO`, `EMAIL_SUBJECT` from environment (loaded via `dotenv`).
- If any required vars are missing, logs a warning and skips silently — **does not throw**.
- Uses Gmail SMTP via `nodemailer`. Authentication requires a Gmail App Password (not the account password).
- Sends an HTML table of new candidates, with counts of new and total.
- **`sendDailyReport(addedCount, totalCount, newCandidates)`** is the only exported function.

### `config.js`

Exports a plain object with:
- `searchKeywords` — Array of job title strings to target.
- `locations` — Array of US locations to search within.
- `jobBoards` — Array of site hostnames to source from.
- `vetNetworks` — Array of veterinary professional organizations (reference/extension point).
- `runInterval` — Minutes between runs (1440 = daily); scheduling is external (Task Scheduler).
- `outputFormat` — Always `'csv'`.
- `minExperience` — Minimum years of experience (integer); not currently enforced in sourcing logic.
- `saveLocation` — Relative path to CSV output (`'./candidates.csv'`).

---

## Environment Variables (`.env`)

| Variable | Required | Description |
|---|---|---|
| `EMAIL_FROM` | Yes | Gmail address the report is sent from |
| `EMAIL_APP_PASSWORD` | Yes | Gmail App Password (16-char, not the account password) |
| `EMAIL_TO` | Yes | Comma-separated recipient email addresses |
| `EMAIL_SUBJECT` | No | Override the default email subject line |

Copy `.env.example` to `.env` and fill in values. Never commit `.env`.

---

## CSV Data Format

```
Name,Title,Location,Experience,Source,Date Added
Dr. Sarah Johnson,Medical Director,California,8 years,LinkedIn,2026-03-11
```

- **No field quoting** — commas in field values will break parsing.
- **Deduplication key**: `name` + `location` (normalized to lowercase).
- **Date format**: `YYYY-MM-DD`.

---

## Windows Task Scheduler (Daily Automation)

The `run.bat` file:
1. `cd`s to the repo folder (resolves relative paths correctly regardless of Task Scheduler's working directory).
2. Runs `node candidate-sourcer.js`.
3. Appends all output to `run.log` (in the repo root).

Task Scheduler should be set to run `cmd.exe` with argument `/c "C:\Users\<you>\Desktop\Medical-Director-Dump\run.bat"`.

---

## Development Conventions

- **Runtime**: Node.js with CommonJS (`require` / `module.exports`).
- **Credentials**: Always via `.env` / `dotenv`. Never hardcoded.
- **CSV safety**: Field values must not contain commas. If adding quoting support, update both `loadCandidates()` (parsing) and `saveCandidates()` (serialization) together.
- **Deduplication lives in `addCandidate()`** — never push directly to `this.candidates`.
- **`saveCandidates()` is destructive** — always full rewrite. Ensure `this.candidates` is fully loaded before calling.
- **`sourceCandidates()` is the extension point** — real scraping/API calls replace or augment the `simulatedCandidates` array inside it.
- **`mailer.js` fails gracefully** — missing env vars produce a warning log, not an exception.
- **`candidates.csv` is committed data** — treat changes to it as meaningful data, not build artifacts.
- **No test suite** exists currently. If adding tests, use Jest (add to `package.json` devDependencies).
