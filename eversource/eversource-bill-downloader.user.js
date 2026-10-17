// ==UserScript==
// @name         Eversource Bill Downloader
// @namespace    https://github.com/benjaminkraus/tampermonkey-scripts
// @version      1.0.0
// @description  Download every bill PDF listed on the Eversource Account History page.
// @author       Benjamin Kraus
// @homepageURL  https://github.com/benjaminkraus/tampermonkey-scripts
// @supportURL   https://github.com/benjaminkraus/tampermonkey-scripts/issues
// @icon         https://www.eversource.com/favicon.ico
// @match        https://secure8.i-doxs.net/Eversource/Secure/AccountHistory.aspx*
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FOLDER = 'Eversource';
  const DELAY_MS = 1000;
  const LIMIT = Infinity; // set to Infinity to download all bills.

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // "10/30/2026" or "10/30/26" -> "20261030"
  function compactDate(us) {
    const m = us.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/);
    if (!m) return us.replace(/\W+/g, '');
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`;
  }

  // The table only shows the due date; the issue date is printed on the bill as "Statement Date: 10/05/26".
  // pdf.js returns page text as fragments ("Sta", "tement", "Da", "te:") in no useful order, so rebuild
  // page-1 lines by grouping fragments on the same baseline and sorting them left to right.
  // (The @require'd worker sets globalThis.pdfjsWorker, so pdf.js runs in-page instead of spawning a Worker.)
  async function readStatementDate(bytes) {
    // The site adds an enumerable Array.prototype.last, which pdf.js rejects ("Array.prototype contains
    // unexpected enumerable properties"). Hiding it from for...in keeps it usable by the site.
    for (const key in []) Object.defineProperty(Array.prototype, key, { enumerable: false });

    const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    try {
      const { items } = await (await pdf.getPage(1)).getTextContent();
      const lines = [];
      for (const it of items.filter((i) => i.str.trim())) {
        const [x, y] = [it.transform[4], it.transform[5]];
        let line = lines.find((l) => Math.abs(l.y - y) < 3);
        if (!line) lines.push((line = { y, parts: [] }));
        line.parts.push({ x, end: x + it.width, str: it.str });
      }
      for (const line of lines) {
        line.parts.sort((a, b) => a.x - b.x);
        const text = line.parts.reduce((s, p, i) => s + (i && p.x - line.parts[i - 1].end > 2 ? ' ' : '') + p.str, '');
        const m = text.match(/Statement\s*Date:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
        if (m) return compactDate(m[1]);
      }
      return null;
    } finally {
      pdf.destroy();
    }
  }

  // Each bill row has a "View" link whose href is a postback to ctl00$main$lvAccountHistory$ctrlN$viewBtn.
  function findBills() {
    return [...document.querySelectorAll('a[id^="main_lvAccountHistory_viewBtn_"]')].map((a) => {
      const row = a.closest('tr');
      const text = (cls) => row.querySelector(`.${cls}`)?.textContent.trim() ?? '';
      return {
        target: a.href.match(/(ctl00\$main\$lvAccountHistory\$ctrl\d+\$viewBtn)/)[1],
        account: text('tdAccountNo').match(/\d+/)?.[0] ?? 'unknown',
        type: text('tdAccountType') || 'Bill',
        date: compactDate(text('tdDate')),
      };
    });
  }

  // Replays the VIEW postback; the server 302s to BillView.aspx, whose iframe holds the PDF URL.
  async function getPdfUrl(form, target) {
    const body = new URLSearchParams();
    for (const el of form.elements) {
      if (!el.name || ['submit', 'button', 'image', 'file'].includes(el.type)) continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      body.append(el.name, el.value);
    }
    body.set('__EVENTTARGET', target);
    body.set('__EVENTARGUMENT', '');

    const res = await fetch(form.action, { method: 'POST', body, credentials: 'include' });
    if (!res.ok) throw new Error(`postback HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const src = doc.getElementById('main_printPdf')?.getAttribute('src');
    if (!src) throw new Error(`no PDF iframe on ${res.url}`);

    // BillView=4|dbid|dockey|pages|... — dockey uniquely identifies the bill
    const dockey = new URL(res.url).searchParams.get('BillView')?.split('|')[2] ?? '';
    return { url: new URL(src, res.url).href, dockey };
  }

  function download(url, name) {
    return new Promise((resolve, reject) => {
      GM_download({
        url,
        name,
        saveAs: false,
        conflictAction: 'uniquify',
        onload: resolve,
        onerror: (e) => reject(new Error(`download failed: ${e.error}${e.details ? ` (${e.details})` : ''}`)),
        ontimeout: () => reject(new Error('download timed out')),
      });
    });
  }

  async function run(button) {
    const form = document.getElementById('frmMain');
    const bills = findBills().slice(0, LIMIT);
    if (!bills.length) {
      alert('No bills with a View button are listed. Adjust the filters and click Apply Filters.');
      return;
    }

    button.disabled = true;
    const failures = [];
    const warnings = [];
    for (const [i, bill] of bills.entries()) {
      button.textContent = `Downloading ${i + 1}/${bills.length}…`;
      try {
        const { url, dockey } = await getPdfUrl(form, bill.target);

        const pdfRes = await fetch(url, { credentials: 'include' });
        if (!pdfRes.ok) throw new Error(`PDF HTTP ${pdfRes.status}`);
        let date = await readStatementDate(new Uint8Array(await pdfRes.arrayBuffer())).catch((err) => {
          console.warn(`[Eversource] could not read PDF ${dockey}:`, err);
          return null;
        });
        if (!date) {
          date = bill.date;
          warnings.push(`${bill.date}: no Statement Date found, named by due date`);
        }

        const name = `${FOLDER}/${date} - Eversource ${bill.type} - ${bill.account} - ${dockey}.pdf`;
        await download(url, name);
        console.log(`[Eversource] saved ${name}`);
      } catch (err) {
        console.error(`[Eversource] ${bill.date} (${bill.target}):`, err);
        failures.push(`${bill.date}: ${err.message}`);
      }
      if (i < bills.length - 1) await sleep(DELAY_MS);
    }

    button.disabled = false;
    button.textContent = 'Download bills';
    const ok = bills.length - failures.length;
    alert(
      `Downloaded ${ok} of ${bills.length} bills.` +
        (failures.length ? `\n\nFailed:\n${failures.join('\n')}` : '') +
        (warnings.length ? `\n\nWarnings:\n${warnings.join('\n')}` : ''),
    );
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Download bills';
  Object.assign(button.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: 99999,
    padding: '10px 16px',
    background: '#00754a',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    font: 'bold 14px sans-serif',
    cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(0,0,0,.3)',
  });
  button.addEventListener('click', () => run(button));
  document.body.appendChild(button);
})();
