# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A collection of standalone Tampermonkey userscripts (`<site>/<name>.user.js`) that automate chores on
websites, mainly bulk-downloading statement PDFs. There is no build, package manager, or test suite;
each script is a single self-contained file pasted into Tampermonkey by hand. Scripts are used mainly
in **Firefox** Tampermonkey; the debug Chrome profile in `local/chrome-debug-profile/` (gitignored, holds
live session cookies) exists only so Claude can inspect sites through the chrome-devtools MCP.

Syntax check after editing: `node --check <site>/<name>.user.js`

## Workflow for a new site

1. The user logs in and opens the statements page in the debug Chrome (never handle credentials).
2. `take_snapshot` to find the statement list and its download controls; `evaluate_script` for DOM details.
3. The user clicks **one** statement; inspect `list_network_requests` / `get_network_request` to see how
   the PDF is actually delivered (postback, redirect, iframe, API call, required headers).
4. Replay that request from inside the live page with `evaluate_script` before writing the script.
   Test page-dependent code in the real page, not only in node: the site's own JS can break libraries
   (see the Eversource `Array.prototype` note below), which node tests miss.
5. Dry-run the finished script with `evaluate_script` (via `sourcePath`, since full runs exceed the 120 s
   inline limit and go to the background): wrap the script source in an async function that defines a
   `GM_download` stub recording name/size, plus `alert` and `URL.createObjectURL` stubs (sites may wrap
   `fetch` so it can't read `blob:` URLs), then click the injected button and wait for it to re-enable.

## Conventions

- **Filenames:** `<FOLDER>/<yyyymmdd> - <Company> <Type> - <account> - <billID>.pdf`, saved via
  `GM_download` into a `Downloads/<Company>/` subfolder. The date must be the statement/issue date,
  not the due date; if the site only shows due dates, read the issue date from the PDF and fall back
  to the due date with a warning in the end-of-run summary.
- **Header:** `@namespace`/`@homepageURL` = `https://github.com/benjaminkraus/tampermonkey-scripts`,
  `@supportURL` = its `/issues`, `@author Benjamin Kraus`, `@icon` = the site's favicon. No `@license`,
  no email, and no `@updateURL`/`@downloadURL` — the repo is private, so updates are manual paste.
  Pin `@require` libraries to exact versions on cdnjs.
- **Script shape:** a fixed-position button injected into the page (no auto-run), a `LIMIT` constant
  for test runs, a `DELAY_MS` throttle between items, `[Site]`-prefixed console logging, and a final
  `alert` summarising successes, failures, and warnings.

## Eversource script (`eversource/eversource-bill-downloader.user.js`)

Runs on `secure8.i-doxs.net/Eversource/Secure/AccountHistory.aspx` (Eversource's billing vendor, an
ASP.NET WebForms site — not eversource.com). Flow per table row that has a View link:

1. `getPdfUrl` replays the row's `__doPostBack` by POSTing every field of `#frmMain` with
   `__EVENTTARGET=ctl00$main$lvAccountHistory$ctrlN$viewBtn`. The same form state can be reused for
   every row. The server 302s to `BillView.aspx?BillView=4|dbid|dockey|pages|...`; the PDF URL is the
   `src` of `#main_printPdf` (`__ImageGrabber.axd?...`). `dockey` is the unique bill ID.
2. The PDF is fetched in-page and `readStatementDate` extracts "Statement Date" from page 1 with pdf.js
   (3.11.174). pdf.js returns text in out-of-order fragments, so lines are rebuilt by grouping items on
   the same baseline (`transform[5]`) and sorting by x.
3. `GM_download` saves the same URL (Tampermonkey re-fetches it).

Gotchas:
- The site adds an enumerable `Array.prototype.last`; pdf.js refuses to run unless it is made
  non-enumerable (done at the top of `readStatementDate`).
- `pdf.worker.min.js` is `@require`d so `globalThis.pdfjsWorker` exists and pdf.js uses its in-page
  "fake worker" (the "Setting up fake worker" console warning is expected) instead of a Worker the
  site's CSP could block.
- The table's dates/amounts don't always match the PDF the row opens; trust the PDF.

## BCBS MA script (`bcbs/bcbs-claims-exporter.user.js`)

Runs on `member.bluecrossma.com` (Angular SPA; `@match` is the whole site and the button is shown only
while `/myclaims` has claim cards, since the list can be reached without a page load). Claim cards
have stable `data-qa="myclaims-claims-information-*"` attributes; the claim number is the displayed
"Claim No." with spaces removed. Pre-treatment estimates (`.pre-label`) are skipped.
Output names were chosen by the user and differ from the general convention: EOBs are
`BCBS/<first date of service> - <Provider as shown in the list>.pdf`; the CSV is
`BCBS/<today> - BCBS Claims.csv` (one row per service; Pending claims get one totals row).

API (`https://digitalapi.bluecrossma.com/digital/user-claims`), GET with headers only:
`authorization: Bearer <sessionStorage.loggedinUserApigee .access_token>`, `x-claimnumber`,
`x-clientsessionid` (`sessionStorage.clientSessionId`), `x-clientname: MyBlueWeb`, `x-clientlocale: EN`,
and **required** `x-clientversion` (the release id in the site's asset paths, e.g. `26.11.21-aup.9`;
missing → 400). The anti-bot headers the site's wrapped `fetch` adds are not needed.
- `v1/claim-details` → claim totals plus `services[]` (per-line amounts, codes, provider).
- `v3/eob-document` → `{ eobDocument: <base64 PDF> }`; claims without one answer HTTP 500 wrapping a 404.
