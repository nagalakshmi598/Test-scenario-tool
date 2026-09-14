# QA Test Scenario Tool

A small internal tool for the Product Engineering QA flow: every time a new enhancement,
customization or feature comes in, create it under its product and upload the test scenario
CSV/XLSX. The dashboard then shows the scenarios one per row with clean serial numbers.

Theme: white + deep blue `#0129ac`.

## Run it

```bash
npm install      # once
npm start        # http://localhost:4310
```

Use a different port with `PORT=5000 npm start` (PowerShell: `$env:PORT=5000; npm start`).

## How it works

```
Dashboard
 └── Products:  Message  |  Email  |  Content
      └── click a product  →  list of enhancements / features for it
           └── click an enhancement name  →  its test scenarios
                S.No | Test Scenario | (extra columns from your file) | Action

 Documents:  Enhancement Documents
              └── click a document  →  its matter and screenshots, shown in the tool
```

- **+ New Enhancement** — pick the product, type the enhancement/feature name, then attach the
  scenario CSV/XLSX, the enhancement document, or both. Both files are optional; at least one is
  needed. One enhancement name per product (duplicates are rejected).
- **Upload CSV** (inside an enhancement) — re-upload for the same enhancement, either
  *replacing* the scenarios or *appending* to them (serial numbers are re-generated so the
  list stays 1..N).
- **Add a test scenario in the tool** — the box under the table appends one typed scenario as the
  next numbered row, without any file.
- **Delete** on a scenario row — asks *Yes, delete / No, cancel* first, then removes that row and
  renumbers the rest 1..N.
- **Test Cases** on a scenario row — expands a panel under that row with detailed test cases
  (Test Case / Test Scenario / Preconditions / Test Steps / Expected Result), written by OpenAI or Claude
  from that scenario. Cached after the first run; **Regenerate** writes a fresh set. Needs an API
  key — see below.
- **Export CSV** — download the stored scenarios back as a clean CSV.
- **Enhancement document** — attach the write-up while creating an enhancement, or upload one from
  **Enhancement Documents** in the left panel. Word files are shown inside the tool with their
  screenshots, PDFs open in the built-in viewer, images show as a single screenshot, and
  .md/.txt are formatted as text. Inside an enhancement, **View document** opens its write-up.
- **Documents tabs** — inside Documents, one tab per product (Message / Email / Content) so each
  product keeps its own write-ups. A document panel has **Edit** to rename it or move it to
  another product tab.
- **Edit** next to an enhancement name renames it in place.
- **Search** — filter enhancements, filter scenarios inside one enhancement, or filter documents
  within the active tab.

## AI key for the Test Cases button (OpenAI or Claude)

Everything else works without a key. To generate test cases, copy `.env.example` to `.env` in this
folder, put in **one** key, and restart the server:

```
# OpenAI / ChatGPT — https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-4o           # optional; any chat model your account can use

# or Anthropic / Claude — https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Whichever key is present is used. If both are set OpenAI wins; `AI_PROVIDER=openai` or
`AI_PROVIDER=anthropic` forces one. `GET /api/ai-status` reports the active provider and model,
and each generated panel shows the model that produced it. Results are cached in
`server/data/db.json`, so re-opening a panel costs nothing.

A key set as a Windows environment variable also works and takes priority over `.env`.
`.env` holds a live secret — do not commit or share it.

## Accepted file formats

`.csv`, `.xlsx`, `.xls`, `.xlsm`, `.txt` — up to 10 MB.

The parser looks for a header row containing a scenario column named any of:
`Test Scenario`, `Test Scenarios`, `Scenario`, `Test Case`, `Test Description`, `Description`, `Test`.
An `S.No` / `Sr No` / `Serial No` / `#` / `No` column is recognised and re-numbered.
Every other named column (Expected Result, Priority, Status, Steps, …) is kept and shown as an
extra column in the dashboard.

If there is no header row at all, a plain one-scenario-per-line list also works
(with or without `1.` / `-` prefixes).

Blank rows are skipped, and quoted fields containing commas or newlines are handled.
With *Split multi-line cells* ticked (default), a cell holding several numbered lines becomes
several scenario rows.

See [samples/sample-test-scenarios.csv](samples/sample-test-scenarios.csv) for the expected shape.

## Layout

| Path | What it is |
| --- | --- |
| `server/index.js` | Express app, upload endpoints, CSV export |
| `server/parse.js` | CSV (RFC 4180) + XLSX reader, scenario normalisation |
| `server/documents.js` | Document intake: .docx to HTML + screenshot extraction, PDF/image/text |
| `server/testcases.js` | OpenAI / Claude call that turns a scenario into detailed test cases |
| `server/store.js` | JSON-file storage, product definitions |
| `server/data/db.json` | Your data (enhancements + scenarios) |
| `server/uploads/` | Original uploaded scenario sheets |
| `server/uploads/docs/` | Uploaded documents and the screenshots pulled out of them |
| `public/` | Dashboard UI (plain HTML/CSS/JS — no build step) |

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/products` | Products with enhancement + scenario counts |
| GET | `/api/products/:product/enhancements` | Enhancements of a product |
| POST | `/api/enhancements` | New enhancement + scenario file (multipart: `product`, `name`, `description`, `file`, `splitLines`) |
| GET | `/api/enhancements/:id` | One enhancement with all scenarios |
| POST | `/api/enhancements/:id/scenarios` | Re-upload scenarios (`mode=replace\|append`) |
| POST | `/api/enhancements/:id/scenario` | Add one scenario typed in the tool (JSON: `scenario`, `extra`) |
| DELETE | `/api/enhancements/:id/scenarios/:sno` | Delete one scenario row, renumber the rest |
| POST | `/api/enhancements/:id/scenarios/:sno/testcases` | Test cases for one scenario (JSON: `regenerate`); cached unless `regenerate: true` |
| GET | `/api/documents` | All stored enhancement documents |
| POST | `/api/documents` | Upload a document (multipart: `name`, `description`, `file`) |
| GET | `/api/documents/:id` | One document, with its converted HTML |
| GET | `/api/documents/:id/file` | The original file (`?download=1` to save it) |
| GET | `/api/documents/:id/assets/:name` | A screenshot extracted from a .docx |
| PATCH | `/api/documents/:id` | Rename a document or move it to another product |
| DELETE | `/api/documents/:id` | Delete a document and its files |
| GET | `/api/ai-status` | Whether a key is configured, plus the active provider and model |
| PATCH | `/api/enhancements/:id` | Rename / edit notes |
| DELETE | `/api/enhancements/:id` | Delete an enhancement |
| GET | `/api/enhancements/:id/export.csv` | Download scenarios as CSV |

## Notes

- Storage is a JSON file, which suits a single-user internal tool. If several QA engineers
  will use one shared instance at the same time, move `server/store.js` onto a database
  (SQLite/Mongo) — the rest of the code does not change.
- There is no authentication; run it on your machine or behind an internal network.
