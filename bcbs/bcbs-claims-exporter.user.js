// ==UserScript==
// @name         BCBS MA Claims Exporter
// @namespace    https://github.com/benjaminkraus/tampermonkey-scripts
// @version      1.0.0
// @description  Export the billing breakdown of every listed Blue Cross Blue Shield of MA claim to CSV and download each claim's explanation of benefits.
// @author       Benjamin Kraus
// @homepageURL  https://github.com/benjaminkraus/tampermonkey-scripts
// @supportURL   https://github.com/benjaminkraus/tampermonkey-scripts/issues
// @icon         https://www.bluecrossma.org/sites/g/files/csphws2356/files/favicon.ico
// @match        https://member.bluecrossma.com/*
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FOLDER = 'BCBS';
  const DELAY_MS = 500;
  const LIMIT = Infinity; // set to e.g. 2 while testing
  const API = 'https://digitalapi.bluecrossma.com/digital/user-claims';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // "2026-01-31" -> "20260131"
  const compactDate = (iso) => (iso ?? '').replace(/-/g, '');

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };

  // Characters Windows/Linux/macOS can't have in a filename; trailing dots ("Jane Doe M.d.") would
  // otherwise produce "M.d..pdf".
  const safeName = (s) =>
    s
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.\s]+$/, '');

  const money = (v) => (typeof v === 'number' ? v.toFixed(2) : v);

  // The API requires X-ClientVersion; the site's release id appears in its asset paths
  // (e.g. /sites/default/files/myblue/26.11.21-aup.9/favicon.ico).
  function clientVersion() {
    for (const el of document.querySelectorAll('script[src], link[href], img[src]')) {
      const m = (el.src || el.href).match(/\/myblue\/(\d[\w.-]*)\//);
      if (m) return m[1];
    }
    return '26.11.21-aup.9';
  }

  // The Angular app keeps its OAuth token and session id in sessionStorage.
  function apiHeaders(claimNumber) {
    const token = JSON.parse(sessionStorage.getItem('loggedinUserApigee') ?? '{}').access_token;
    if (!token) throw new Error('not logged in (no access token in sessionStorage)');
    return {
      accept: 'application/json, text/plain, */*',
      authorization: `Bearer ${token}`,
      'x-claimnumber': claimNumber,
      'x-clientsessionid': sessionStorage.getItem('clientSessionId') ?? '',
      'x-clientname': 'MyBlueWeb',
      'x-clientlocale': 'EN',
      'x-clientversion': clientVersion(),
    };
  }

  async function getClaimDetails(claimNumber) {
    const res = await fetch(`${API}/v1/claim-details`, { headers: apiHeaders(claimNumber) });
    if (!res.ok) throw new Error(`claim-details HTTP ${res.status}`);
    return res.json();
  }

  // Returns the EOB as a PDF Blob, or null when the claim has none (the API answers 500 with a wrapped 404).
  async function getEob(claimNumber) {
    const res = await fetch(`${API}/v3/eob-document`, { headers: apiHeaders(claimNumber) });
    if (!res.ok) return null;
    const { eobDocument } = await res.json();
    if (typeof eobDocument !== 'string' || !eobDocument.startsWith('JVBER')) return null; // base64 of "%PDF"
    const bytes = Uint8Array.from(atob(eobDocument), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: 'application/pdf' });
  }

  // Claim cards on /myclaims, in the order (and filter) currently shown.
  function findClaims() {
    return [...document.querySelectorAll('[data-qa="myclaims-claims-information-list-containers"]')].map((card) => {
      const text = (sel) => card.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? '';
      const display = text('[data-qa^="myclaims-claims-information-claim-id-"]');
      return {
        display, // "1234 5678 9012 345"
        number: display.replace(/\s/g, ''),
        patient: text('[data-qa^="myclaims-claims-information-member-name-"]'), // "Jane Doe (Subscriber)"
        provider: text('[data-qa^="myclaims-claims-information-provider-name-"]'),
        isEstimate: !!card.querySelector('.pre-label'),
      };
    });
  }

  const COLUMNS = [
    ['Claim Number', (c) => c.claim.display],
    ['Patient', (c) => c.claim.patient],
    ['Claim Type', (c) => c.d.claimType],
    ['Claim Status', (c) => c.d.displayClaimStatus ?? c.d.claimStatus],
    ['Network', (c) => ({ I: 'In-network', O: 'Out-of-network' })[c.d.network] ?? c.d.network],
    ['Provider', (c) => c.claim.provider],
    ['Service Provider', (c) => c.s.provider?.name],
    ['Service Start Date', (c) => c.s.firstDateOfService ?? c.d.firstDateOfService],
    ['Service End Date', (c) => c.s.lastDateOfService ?? c.d.lastDateOfService],
    ['Service Type', (c) => c.s.serviceType],
    ['Procedure Code', (c) => c.s.procedureCode],
    ['Diagnosis', (c) => [c.s.diagnosticCode, c.s.diagnosticCodeDesc].filter(Boolean).join(' - ')],
    ['Tooth', (c) => [c.s.toothNumber, c.s.toothSurface].filter(Boolean).join(' ')],
    ['Units', (c) => c.s.unitOfService],
    ['Amount charged by health care provider', (c) => money(c.a.amountCharged)],
    ['Amount allowed by Blue Cross', (c) => money(c.a.amountAllowedByInsurance)],
    ['Blue Cross discount', (c) => money(c.a.blueCrossDiscount)],
    ['Amount paid by Blue Cross', (c) => money(c.a.amountCoveredByInsurance)],
    ['Amount paid by other insurance', (c) => money(c.a.amountCoveredByOtherInsurance)],
    ['Copayment', (c) => money(c.a.coPayment)],
    ['Applied to deductible', (c) => money(c.a.appliedToDeductible)],
    ['Coinsurance', (c) => money(c.a.coInsurance)],
    ['Amount not covered', (c) => money(c.a.amountNotCovered)],
    ['Amount you owe', (c) => money(c.a.amountOwed)],
    ['Message', (c) => c.s.lineMessageCodeDesc],
  ];

  // One row per service; a claim without a breakdown yet (e.g. Pending) gets one row of claim totals.
  function rowsFor(claim, d) {
    const services = d.services?.length ? d.services : [null];
    return services.map((s) => COLUMNS.map(([, get]) => get({ claim, d, s: s ?? {}, a: s ?? d }) ?? ''));
  }

  const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  // BOM so Excel opens it as UTF-8.
  const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      GM_download({
        url,
        name: `${FOLDER}/${name}`,
        saveAs: false,
        conflictAction: 'uniquify',
        onload: resolve,
        onerror: (e) => reject(new Error(`download failed: ${e.error}${e.details ? ` (${e.details})` : ''}`)),
        ontimeout: () => reject(new Error('download timed out')),
      });
    }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 60_000));
  }

  async function run(button) {
    const claims = findClaims()
      .filter((c) => !c.isEstimate)
      .slice(0, LIMIT);
    if (!claims.length) {
      alert('No claims are listed. Adjust the filter and click Apply.');
      return;
    }

    button.disabled = true;
    const rows = [COLUMNS.map(([name]) => name)];
    const failures = [];
    let pdfs = 0;
    for (const [i, claim] of claims.entries()) {
      button.textContent = `Exporting ${i + 1}/${claims.length}…`;
      try {
        const d = await getClaimDetails(claim.number);
        rows.push(...rowsFor(claim, d));

        if (d.claimStatus !== 'Pending') {
          const pdf = await getEob(claim.number);
          if (pdf) {
            const name = `${compactDate(d.firstDateOfService ?? d.dateOfService)} - ${safeName(claim.provider)}.pdf`;
            await saveBlob(pdf, name);
            pdfs++;
            console.log(`[BCBS] saved ${name}`);
          }
        }
      } catch (err) {
        console.error(`[BCBS] claim ${claim.display}:`, err);
        failures.push(`${claim.display} (${claim.provider}): ${err.message}`);
      }
      if (i < claims.length - 1) await sleep(DELAY_MS);
    }

    let csvError = null;
    const csvName = `${today()} - BCBS Claims.csv`;
    try {
      await saveBlob(new Blob([toCsv(rows)], { type: 'text/csv' }), csvName);
    } catch (err) {
      csvError = err.message;
      console.error('[BCBS] CSV:', err);
    }

    button.disabled = false;
    button.textContent = 'Export claims';
    const ok = claims.length - failures.length;
    alert(
      `Exported ${ok} of ${claims.length} claims (${rows.length - 1} rows) and ${pdfs} PDFs.` +
        (csvError ? `\n\nCSV not saved: ${csvError}` : `\nCSV: ${FOLDER}/${csvName}`) +
        (failures.length ? `\n\nFailed:\n${failures.join('\n')}` : ''),
    );
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Export claims';
  Object.assign(button.style, {
    position: 'fixed',
    bottom: '20px',
    left: '20px', // the site's chat button and feedback tab occupy the right side
    zIndex: 99999,
    padding: '10px 16px',
    background: '#0057b8',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    font: 'bold 14px sans-serif',
    cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(0,0,0,.3)',
    display: 'none',
  });
  button.addEventListener('click', () => run(button));
  document.body.appendChild(button);

  // The site is a single-page app, so the claims list can appear without a page load:
  // show the button only while claim cards are on screen.
  setInterval(() => {
    const onList = location.pathname.replace(/\/$/, '') === '/myclaims' && findClaims().length > 0;
    if (!button.disabled) button.style.display = onList ? 'block' : 'none';
  }, 1000);
})();
