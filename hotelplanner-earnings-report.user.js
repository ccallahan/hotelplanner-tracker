// ==UserScript==
// @name         HotelPlanner Earnings Report
// @namespace    https://agents.hotelplanner.com/
// @version      1.0
// @description  Scrapes the My Bookings page, calculates settlement/payment dates, and shows a weekly earnings report.
// @author       ccallahan
// @match        https://agents.hotelplanner.com/_Admin/offlineSoftphone/Bookings.htm*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse a date string in the formats used by the page:
   *   "10-May-2026"  →  Date
   *   "08-May-2026 09:35 AM"  →  Date (time portion ignored for settlement calc)
   */
  function parsePageDate(str) {
    if (!str || !str.trim()) return null;
    // Strip time portion if present
    const datePart = str.trim().split(' ')[0]; // e.g. "10-May-2026"
    const d = new Date(datePart);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Format a Date as "YYYY-MM-DD" for use as a map key.
   */
  function toKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Format a Date as a human-readable string: "Tue, Jun 17, 2026"
   */
  function fmtDate(d) {
    return d.toLocaleDateString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  /**
   * Add N calendar days to a Date (returns new Date).
   */
  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  /**
   * Return the first Tuesday that is >= the given date.
   * If the date itself is a Tuesday (getDay() === 2) it is returned as-is.
   */
  function firstTuesdayOnOrAfter(d) {
    const day = d.getDay(); // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
    const daysUntilTue = day === 2 ? 0 : (2 - day + 7) % 7;
    return addDays(d, daysUntilTue);
  }

  // ---------------------------------------------------------------------------
  // Scrape the bookings table
  // ---------------------------------------------------------------------------

  /**
   * Column indices (0-based) from the table header:
   * 0  ID
   * 1  Status
   * 2  Booked
   * 3  Prepaid
   * 4  Rooms
   * 5  Nights
   * 6  Check In
   * 7  Check Out
   * 8  Cancelled
   * 9  Cxl Reason
   * 10 Hotel
   * 11 Est. Gross Profit
   * 12 Share %
   * 13 Discount Applied
   * 14 Your Est. Earnings
   * 15 Actual Earnings
   * 16 Est. Protection Earnings
   * 17 Actual Protection Earnings
   * 18 wheel (icon)
   * 19 Settled Date
   * 20 Protection Settled Date
   */
  const COL = {
    ID: 0,
    STATUS: 1,
    BOOKED: 2,
    CHECK_IN: 6,
    CHECK_OUT: 7,
    HOTEL: 10,
    EST_GROSS: 11,
    SHARE_PCT: 12,
    EST_EARN: 14,
    ACTUAL_EARN: 15,
    EST_PROT: 16,
    ACTUAL_PROT: 17,
    SETTLED_DATE: 19,
    PROT_SETTLED_DATE: 20,
  };

  function scrapeReservations() {
    const reservations = [];

    // Find the bookings table by locating the first <th> or <td> with text "ID".
    // This works regardless of whether the page uses <thead>/<tbody> or not.
    let dataTable = null;
    for (const t of document.querySelectorAll('table')) {
      const firstHeader = t.querySelector('th, td');
      if (firstHeader && firstHeader.textContent.trim() === 'ID') {
        dataTable = t;
        break;
      }
    }

    if (!dataTable) {
      console.warn('[HP Earnings] Could not locate bookings table.');
      return reservations;
    }

    // Iterate every <tr> in the table; identify data rows by whether the
    // first <td> cell is a pure numeric reservation ID.
    {
      const rows = dataTable.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 15) continue;

        const idText = cells[COL.ID].textContent.trim();
        if (!/^\d+$/.test(idText)) continue; // skip header / summary rows

        const status    = cells[COL.STATUS].textContent.trim();
        const booked    = cells[COL.BOOKED].textContent.trim();
        const checkIn   = cells[COL.CHECK_IN].textContent.trim();
        const checkOut  = cells[COL.CHECK_OUT].textContent.trim();
        const hotel     = cells[COL.HOTEL].textContent.trim();
        const estGross  = cells[COL.EST_GROSS].textContent.trim();
        const sharePct  = cells[COL.SHARE_PCT].textContent.trim();
        const estEarn   = cells[COL.EST_EARN].textContent.trim();
        const actEarn   = cells[COL.ACTUAL_EARN].textContent.trim();
        const estProt   = cells[COL.EST_PROT].textContent.trim();
        const actProt   = cells[COL.ACTUAL_PROT].textContent.trim();
        const settledDate     = cells.length > COL.SETTLED_DATE     ? cells[COL.SETTLED_DATE].textContent.trim()     : '';
        const protSettledDate = cells.length > COL.PROT_SETTLED_DATE ? cells[COL.PROT_SETTLED_DATE].textContent.trim() : '';

        // Parse earnings — use actual if available, otherwise estimated
        const parseAmt = s => parseFloat(s.replace(/[^0-9.\-]/g, '')) || 0;
        const earnAmt  = actEarn && actEarn !== '0' && actEarn !== '' ? parseAmt(actEarn)  : parseAmt(estEarn);
        const protAmt  = actProt && actProt !== '0' && actProt !== '' ? parseAmt(actProt)  : parseAmt(estProt);
        const isActualEarn = !!(actEarn && actEarn !== '0' && actEarn !== '');
        const isActualProt = !!(actProt && actProt !== '0' && actProt !== '');

        const checkOutDate = parsePageDate(checkOut);

        let settlementDate = null;
        let paymentDate    = null;

        if (checkOutDate) {
          settlementDate = addDays(checkOutDate, 7);
          paymentDate    = firstTuesdayOnOrAfter(settlementDate);
        }

        reservations.push({
          id: idText,
          status,
          booked,
          checkIn,
          checkOut,
          hotel,
          estGross,
          sharePct,
          earnAmt,
          protAmt,
          isActualEarn,
          isActualProt,
          checkOutDate,
          settlementDate,
          paymentDate,
          settledDate,
          protSettledDate,
        });

        console.log(
          `[HP Earnings] ID=${idText} | Hotel=${hotel} | CheckOut=${checkOut} ` +
          `| Settlement=${settlementDate ? fmtDate(settlementDate) : 'N/A'} ` +
          `| PayDate=${paymentDate ? fmtDate(paymentDate) : 'N/A'} ` +
          `| Earnings=${isActualEarn ? 'ACTUAL' : 'EST'} $${earnAmt.toFixed(2)} ` +
          `| Protection=${isActualProt ? 'ACTUAL' : 'EST'} $${protAmt.toFixed(2)}`
        );
      }
    }

    return reservations;
  }

  // ---------------------------------------------------------------------------
  // Build the weekly payment report
  // ---------------------------------------------------------------------------

  function buildReport(reservations) {
    // Group by payment date key
    const byPayDate = new Map();

    for (const r of reservations) {
      if (!r.paymentDate) continue;
      const key = toKey(r.paymentDate);
      if (!byPayDate.has(key)) {
        byPayDate.set(key, { paymentDate: r.paymentDate, rows: [] });
      }
      byPayDate.get(key).rows.push(r);
    }

    // Also collect cancelled/no-checkout rows separately
    const noDate = reservations.filter(r => !r.paymentDate);

    // Sort by payment date ascending
    const sorted = Array.from(byPayDate.values()).sort(
      (a, b) => a.paymentDate - b.paymentDate
    );

    return { sorted, noDate };
  }

  // ---------------------------------------------------------------------------
  // Render the UI panel
  // ---------------------------------------------------------------------------

  const PANEL_ID = 'hp-earnings-panel';

  function renderPanel(reservations) {
    // Remove existing panel if present
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const { sorted, noDate } = buildReport(reservations);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      top: 60px;
      right: 16px;
      width: 560px;
      max-height: 85vh;
      overflow-y: auto;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,.25);
      font-family: Arial, sans-serif;
      font-size: 13px;
      z-index: 99999;
      padding: 0;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      background: #1a3c5e;
      color: #fff;
      padding: 10px 14px;
      border-radius: 8px 8px 0 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;
    header.innerHTML = `
      <span style="font-weight:bold;font-size:14px;">📅 Weekly Earnings Report</span>
      <span style="font-size:11px;opacity:.8;">${reservations.length} reservation(s) scraped</span>
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background: transparent;
      border: none;
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      margin-left: 10px;
      padding: 0 4px;
    `;
    closeBtn.addEventListener('click', () => panel.remove());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.style.padding = '10px 14px';

    // Legend
    const legend = document.createElement('p');
    legend.style.cssText = 'margin:0 0 10px;color:#555;font-size:11px;';
    legend.textContent =
      'Settlement = checkout + 7 days. Payment = first Tuesday ≥ settlement date. ' +
      'Amounts show Actual if available, otherwise Estimated (shown in italics).';
    body.appendChild(legend);

    if (sorted.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No reservations with checkout dates found.';
      body.appendChild(empty);
    }

    for (const group of sorted) {
      const totalEarn = group.rows.reduce((s, r) => s + r.earnAmt, 0);
      const totalProt = group.rows.reduce((s, r) => s + r.protAmt, 0);
      const totalAll  = totalEarn + totalProt;

      const section = document.createElement('details');
      section.style.cssText = 'margin-bottom:10px;border:1px solid #ddd;border-radius:6px;overflow:hidden;';
      section.open = true;

      const summary = document.createElement('summary');
      summary.style.cssText = `
        background: #eef3f8;
        padding: 8px 12px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: bold;
        list-style: none;
        user-select: none;
      `;
      summary.innerHTML = `
        <span>Pay Date: ${fmtDate(group.paymentDate)}</span>
        <span style="color:#1a6e2e;">$${totalAll.toFixed(2)} total&nbsp;
          <span style="font-size:11px;font-weight:normal;">(earn $${totalEarn.toFixed(2)} + prot $${totalProt.toFixed(2)})</span>
        </span>
      `;
      section.appendChild(summary);

      // Table of reservations in this payment week
      const tbl = document.createElement('table');
      tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';

      const thead = document.createElement('thead');
      thead.innerHTML = `
        <tr style="background:#f5f5f5;text-align:left;">
          <th style="padding:4px 6px;border-bottom:1px solid #ddd;">ID</th>
          <th style="padding:4px 6px;border-bottom:1px solid #ddd;">Hotel</th>
          <th style="padding:4px 6px;border-bottom:1px solid #ddd;">Check Out</th>
          <th style="padding:4px 6px;border-bottom:1px solid #ddd;">Settlement</th>
          <th style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:right;">Earnings</th>
          <th style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:right;">Protection</th>
        </tr>
      `;
      tbl.appendChild(thead);

      const tbody = document.createElement('tbody');
      group.rows.forEach((r, i) => {
        const tr = document.createElement('tr');
        tr.style.background = i % 2 === 0 ? '#fff' : '#fafafa';

        const earnCell = r.isActualEarn
          ? `<strong>$${r.earnAmt.toFixed(2)}</strong>`
          : `<em style="color:#888;">~$${r.earnAmt.toFixed(2)}</em>`;
        const protCell = r.protAmt > 0
          ? (r.isActualProt
              ? `<strong>$${r.protAmt.toFixed(2)}</strong>`
              : `<em style="color:#888;">~$${r.protAmt.toFixed(2)}</em>`)
          : `<span style="color:#bbb;">—</span>`;

        const isTuesdaySettlement = r.settlementDate && r.settlementDate.getDay() === 2;
        const settleBadge = isTuesdaySettlement
          ? ` <span title="Settles on Tuesday — paid same day" style="color:#b8860b;">★</span>`
          : '';

        tr.innerHTML = `
          <td style="padding:4px 6px;">${r.id}</td>
          <td style="padding:4px 6px;" title="${r.hotel}">${r.hotel.length > 18 ? r.hotel.slice(0,18) + '…' : r.hotel}</td>
          <td style="padding:4px 6px;">${r.checkOut}</td>
          <td style="padding:4px 6px;">${r.settlementDate ? fmtDate(r.settlementDate) : 'N/A'}${settleBadge}</td>
          <td style="padding:4px 6px;text-align:right;">${earnCell}</td>
          <td style="padding:4px 6px;text-align:right;">${protCell}</td>
        `;
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      section.appendChild(tbl);
      body.appendChild(section);
    }

    // Reservations without checkout dates
    if (noDate.length > 0) {
      const section = document.createElement('details');
      section.style.cssText = 'margin-bottom:10px;border:1px solid #f5c6cb;border-radius:6px;overflow:hidden;';

      const summary = document.createElement('summary');
      summary.style.cssText = `
        background: #fff3cd;
        padding: 8px 12px;
        cursor: pointer;
        font-weight: bold;
        list-style: none;
      `;
      summary.textContent = `⚠ No checkout date (${noDate.length})`;
      section.appendChild(summary);

      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:6px 12px;padding:0;list-style:none;';
      for (const r of noDate) {
        const li = document.createElement('li');
        li.style.padding = '2px 0';
        li.textContent = `ID ${r.id} — ${r.hotel} (${r.status})`;
        ul.appendChild(li);
      }
      section.appendChild(ul);
      body.appendChild(section);
    }

    // Grand total
    const totalEarn = reservations.reduce((s, r) => s + r.earnAmt, 0);
    const totalProt = reservations.reduce((s, r) => s + r.protAmt, 0);
    const grandDiv = document.createElement('div');
    grandDiv.style.cssText = `
      border-top: 2px solid #1a3c5e;
      padding-top: 8px;
      font-weight: bold;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
    `;
    grandDiv.innerHTML = `
      <span>Grand Total</span>
      <span style="color:#1a6e2e;">$${(totalEarn + totalProt).toFixed(2)}
        <span style="font-size:11px;font-weight:normal;">
          (earn $${totalEarn.toFixed(2)} + prot $${totalProt.toFixed(2)})
        </span>
      </span>
    `;
    body.appendChild(grandDiv);

    panel.appendChild(body);
    document.body.appendChild(panel);
  }

  // ---------------------------------------------------------------------------
  // Floating toggle button
  // ---------------------------------------------------------------------------

  function addToggleButton(reservations) {
    const btn = document.createElement('button');
    btn.id = 'hp-earnings-toggle';
    btn.textContent = '💰 Earnings Report';
    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99998;
      background: #1a3c5e;
      color: #fff;
      border: none;
      border-radius: 24px;
      padding: 10px 18px;
      font-size: 14px;
      font-family: Arial, sans-serif;
      font-weight: bold;
      cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,.3);
    `;
    btn.addEventListener('click', () => {
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        panel.remove();
      } else {
        renderPanel(reservations);
      }
    });
    document.body.appendChild(btn);
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  function init() {
    // Wait a moment for any dynamic rendering
    setTimeout(() => {
      const reservations = scrapeReservations();
      if (reservations.length === 0) {
        console.warn('[HP Earnings] No reservations found. The report will not be shown.');
        return;
      }
      addToggleButton(reservations);
      renderPanel(reservations);
    }, 800);
  }

  // If the page uses AJAX to load data, re-scrape when the URL hash changes
  // (the page uses #reportData after submitting the form)
  window.addEventListener('hashchange', init);

  init();
})();
