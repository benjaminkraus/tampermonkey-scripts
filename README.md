# Tampermonkey scripts

Userscripts that automate routine chores on websites, mostly downloading statement PDFs.

| Script | Site | What it does |
| --- | --- | --- |
| [eversource/eversource-bill-downloader.user.js](eversource/eversource-bill-downloader.user.js) | Eversource (billing at `secure8.i-doxs.net`) | Adds a **Download bills** button to Account History that saves every listed bill PDF |
| [bcbs/bcbs-claims-exporter.user.js](bcbs/bcbs-claims-exporter.user.js) | Blue Cross Blue Shield of MA (`member.bluecrossma.com`) | Adds an **Export claims** button to My Claims that saves a CSV of every listed claim's billing breakdown plus each claim's explanation-of-benefits PDF |

## Installing a script

1. Open the Tampermonkey dashboard → **+** (new script), paste the file contents, save.
2. One-time Tampermonkey settings (Settings → Config mode: **Advanced** → *Downloads BETA*):
   - **Download Mode:** `Browser API` (needed for saving into a subfolder like `Downloads/Eversource/`).
   - **Whitelisted File Extensions:** add `.pdf`.
   - The first download may prompt Chrome to grant Tampermonkey the "downloads" permission.

## Eversource

1. Log in at eversource.com → Account & Billing → Bill & Payment History. This opens
   `secure8.i-doxs.net/Eversource/Secure/AccountHistory.aspx`.
2. Choose the account (Electric / Gas), the date range, and **Apply Filters**.
3. Click **Download bills** (bottom-right). Every row with a View button is saved as
   `Downloads/Eversource/<yyyymmdd> - Eversource <Electric|Gas> - <account> - <dockey>.pdf`,
   where the date is the bill's **Statement Date** (issue date) read from the PDF. The table only
   shows due dates; if the PDF has no Statement Date, the due date is used and the final summary says so.

How it works: each View link is an ASP.NET postback. The script replays that POST with `fetch`,
follows the redirect to `BillView.aspx`, reads the PDF URL from its `#main_printPdf` iframe,
reads the Statement Date from page 1 with pdf.js, and downloads it. Set `LIMIT` in the script to a small number when testing.

## Blue Cross Blue Shield of MA

1. Log in at member.bluecrossma.com → My Plan & Claims → My Claims.
2. Set the filter (dates, provider, etc.) and **Apply**.
3. Click **Export claims** (bottom-left). For every listed claim except pre-treatment estimates it saves:
   - `Downloads/BCBS/<today yyyymmdd> - BCBS Claims.csv`: one row per service in the claim's billing
     breakdown (claim number, patient, provider, service dates and codes, amount charged, allowed,
     paid by Blue Cross, deductible, coinsurance, what you owe, …). Claims with no breakdown yet
     (Pending) get a single row of claim totals.
   - `Downloads/BCBS/<date of service yyyymmdd> - <Provider>.pdf`: the claim's explanation of
     benefits, when one exists (pharmacy, pending, and some older claims have none).

How it works: claim numbers are read from the list, then the script calls the same JSON API the
site uses (`digitalapi.bluecrossma.com/digital/user-claims/v1/claim-details` and `v3/eob-document`)
with the page's own access token, instead of opening each claim page.
