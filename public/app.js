// Seatscope — frontend
let DATA = null;
let charts = {};

const $ = (sel) => document.querySelector(sel);
const money = (n) =>
  "$" + (n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
// normalize a typed amount so both "10,5" and "10.5" work
const toDot = (v) => String(v ?? "").replace(",", ".").trim();
const money2 = (n) =>
  "$" + (n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

/* ---------- Excel export (SheetJS) ---------- */
function downloadXlsx(baseName, sheetName, rows) {
  if (!window.XLSX) { alert("Excel library still loading — please try again in a moment."); return; }
  if (!rows || !rows.length) { alert("Nothing to export."); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `seatscope-${baseName}-${stamp}.xlsx`);
}
// small right-aligned toolbar with an Excel button
const excelToolbar = (btnId) =>
  `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
     <button class="btn" id="${btnId}">⬇ Excel</button>
   </div>`;

const PAGE = {
  overview: { title: "Overview", sub: "License usage, cost & waste across all connected services" },
  users: { title: "Users", sub: "Every user with the licenses they hold and their total monthly license cost" },
  waste: { title: "Wasted licenses", sub: "Assigned seats that appear idle or never used — review before reclaiming a license" },
  inactive: { title: "Inactive users", sub: "People with no detected license usage — review before removing a user or license" },
  renewals: { title: "Renewals", sub: "Subscriptions renewing in the next 45 days" },
  licenses: { title: "License types", sub: "Prices are fetched automatically — override any to recompute all waste & savings" },
  connectors: { title: "Connectors", sub: "Connect GitHub & Microsoft 365 — credentials are read-only and stay on your server" },
};

// force=true re-runs the connectors on the server (fresh data); otherwise the
// server serves its cached data (fast; used after in-app edits).
async function load(force = false) {
  $("#content").innerHTML = `<div class="loading">${force ? "Refreshing data from connectors…" : "Loading…"}</div>`;
  const res = await fetch("/api/dashboard" + (force ? "?refresh=1" : ""));
  DATA = await res.json();
  if (DATA.error) {
    $("#content").innerHTML = `<div class="loading">Error: ${DATA.error}</div>`;
    return;
  }
  $("#srcBadge").textContent = "SOURCE: " + (DATA.source || "mock").toUpperCase();
  const fetched = DATA.dataFetchedAt || DATA.generatedAt;
  $("#genAt").textContent = "Data as of " + new Date(fetched).toLocaleString();
  const active = document.querySelector(".nav-item.active")?.dataset.section || "overview";
  render(active);
}

function render(section) {
  const meta = PAGE[section] || PAGE.overview;
  $("#pageTitle").textContent = meta.title;
  $("#pageSub").textContent = meta.sub;
  destroyCharts();
  ({
    overview: renderOverview,
    users: renderUsers,
    waste: renderWaste,
    inactive: renderInactive,
    renewals: renderRenewals,
    licenses: renderLicenses,
    connectors: renderConnectors,
  }[section] || renderOverview)();
}

/* ---------- Overview ---------- */
function renderOverview() {
  const k = DATA.kpis;
  $("#content").innerHTML = `
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Monthly spend</div>
        <div class="value">${money(k.totalMonthlySpend)}</div>
        <div class="sub muted">${k.paidPurchasedSeats} purchased paid licenses</div>
      </div>
      <div class="kpi accent-red">
        <div class="label">Wasted / month</div>
        <div class="value">${money(k.wastedMonthlySpend)}</div>
        <div class="sub"><span class="up">${k.wastePct}% of spend</span> · ${k.wastedSeats} seats</div>
      </div>
      <div class="kpi accent-red">
        <div class="label">Wasted so far</div>
        <div class="value">${money(k.wastedSoFarTotal)}</div>
        <div class="sub muted">since each license was last used</div>
      </div>
      <div class="kpi accent-green">
        <div class="label">Potential annual savings</div>
        <div class="value">${money(k.potentialAnnualSavings)}</div>
        <div class="sub down">if reclaimed now</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3>Spend vs. waste by service</h3>
        <div class="chart-wrap"><canvas id="svcChart"></canvas></div>
      </div>
      <div class="panel">
        <h3>Where your money goes</h3>
        <div class="chart-wrap"><canvas id="pieChart"></canvas></div>
      </div>
    </div>

    <div class="panel">
      <h3>Top reclaim opportunities</h3>
      ${wasteTable(DATA.wasteRows.slice(0, 8))}
    </div>
  `;

  const svc = DATA.spendByService;
  charts.svc = new Chart($("#svcChart"), {
    type: "bar",
    data: {
      labels: svc.map((s) => s.service),
      datasets: [
        { label: "Active spend", data: svc.map((s) => round(s.spend - s.waste)), backgroundColor: "#3d5afe", borderRadius: 5, stack: "s" },
        { label: "Wasted spend", data: svc.map((s) => round(s.waste)), backgroundColor: "#ef4444", borderRadius: 5, stack: "s" },
      ],
    },
    options: barOpts(),
  });

  charts.pie = new Chart($("#pieChart"), {
    type: "doughnut",
    data: {
      labels: svc.map((s) => s.service),
      datasets: [{ data: svc.map((s) => round(s.spend)), backgroundColor: ["#3d5afe", "#12b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#64748b", "#eab308"] }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { boxWidth: 12 } } }, cutout: "62%" },
  });
}

/* ---------- Users ---------- */
function renderUsers() {
  const allUsers = DATA.userLicenses || [];
  const totalCost = allUsers.reduce((s, u) => s + u.monthlyCost, 0);
  const PAGE_SIZE = 50;
  let page = 1;
  let filtered = allUsers;
  const cols = [
    { key: "user", label: "User", get: (u) => u.name },
    { key: "service", label: "Service", get: (u) => (u.services || []).join(", ") },
    { key: "tenant", label: "Tenant", get: (u) => u.tenant },
    { key: "licenses", label: "Licenses", num: true, get: (u) => u.licenseCount },
    { key: "cost", label: "Cost/mo", num: true, get: (u) => u.monthlyCost },
    { key: "wasted", label: "Wasted/mo", num: true, get: (u) => u.wastedMonthly },
  ];
  const sort = { key: "wasted", dir: -1 };

  $("#content").innerHTML = `
    <p class="section-hint small">${allUsers.length} users hold licenses totalling <b>${money2(totalCost)}/mo</b>. Users are merged only when the email address matches <b>exactly</b>; otherwise records stay separate. Click a row to see each user's licenses. Click a column header to sort.</p>
    <div class="panel">
      <div style="margin-bottom:12px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <input id="userSearch" placeholder="Search by name or email…" style="width:280px;padding:8px 12px;border:1px solid var(--border,#2a2f3a);border-radius:8px;background:transparent;color:inherit">
        <button class="btn" id="exportUsers">⬇ Excel</button>
      </div>
      <div id="userTableMount"></div>
      <div id="userPager" style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"></div>
    </div>`;

  function drawTable() {
    if (!filtered.length) {
      $("#userTableMount").innerHTML = `<p class="muted">${allUsers.length ? "No matching users." : "No users found."}</p>`;
      return;
    }
    const sorted = sortRows(filtered, cols, sort);
    const start = (page - 1) * PAGE_SIZE;
    const pageUsers = sorted.slice(start, start + PAGE_SIZE);
    $("#userTableMount").innerHTML = `
      <table id="userTable">
        <thead><tr>${sortHeaders(cols, sort)}</tr></thead>
        <tbody>
          ${pageUsers.map((u, idx) => {
            const i = start + idx;
            return `
            <tr class="user-row" data-i="${i}" style="cursor:pointer">
              <td><div class="person"><span class="avatar">${initials(u.name)}</span>
                <div><div>${escapeAttr(u.name)} <span class="muted small">▸</span></div><div class="muted small">${escapeAttr(u.email)}</div></div></div></td>
              <td>${escapeAttr((u.services || []).join(", ")) || "—"}</td>
              <td>${escapeAttr(u.tenant) || "—"}</td>
              <td class="num">${u.licenseCount}</td>
              <td class="num"><b>${money2(u.monthlyCost)}</b></td>
              <td class="num">${u.wastedMonthly ? `<span class="up">${money2(u.wastedMonthly)}</span>` : `<span class="muted">—</span>`}</td>
            </tr>
            <tr class="user-detail" data-detail="${i}" style="display:none">
              <td colspan="6" style="background:rgba(0,0,0,0.15)">
                <table style="margin:4px 0">
                  <thead><tr><th>Service</th><th>License</th><th>Status</th><th class="num">Cost/mo</th></tr></thead>
                  <tbody>
                    ${u.licenses.map((l) => `
                      <tr>
                        <td>${escapeAttr(l.service)}</td><td>${escapeAttr(l.sku)}</td>
                        <td>${statusPill(l.status)}</td>
                        <td class="num">${money2(l.costMonthly)}</td>
                      </tr>`).join("")}
                  </tbody>
                </table>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;

    $("#userTableMount").querySelectorAll(".user-row").forEach((row) => {
      row.addEventListener("click", () => {
        const d = $("#userTableMount").querySelector(`.user-detail[data-detail="${row.dataset.i}"]`);
        if (d) d.style.display = d.style.display === "none" ? "table-row" : "none";
      });
    });
    wireSort($("#userTableMount"), cols, sort, () => { page = 1; redraw(); });
  }

  function drawPager() {
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (page > totalPages) page = totalPages;
    if (totalPages <= 1) { $("#userPager").innerHTML = ""; return; }
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, filtered.length);
    $("#userPager").innerHTML = `
      <span class="muted small">Showing ${start}–${end} of ${filtered.length}</span>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn" id="prevPage" ${page <= 1 ? "disabled" : ""}>‹ Prev</button>
        <span class="small">Page ${page} / ${totalPages}</span>
        <button class="btn" id="nextPage" ${page >= totalPages ? "disabled" : ""}>Next ›</button>
      </div>`;
    $("#prevPage")?.addEventListener("click", () => { if (page > 1) { page--; redraw(); } });
    $("#nextPage")?.addEventListener("click", () => { if (page < totalPages) { page++; redraw(); } });
  }

  function redraw() { drawTable(); drawPager(); }
  redraw();

  const search = $("#userSearch");
  search?.addEventListener("input", () => {
    const q = search.value.toLowerCase().trim();
    filtered = !q ? allUsers : allUsers.filter((u) =>
      (u.name || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.services || []).join(", ").toLowerCase().includes(q) ||
      (u.tenant || "").toLowerCase().includes(q));
    page = 1;
    redraw();
  });

  $("#exportUsers")?.addEventListener("click", () => {
    const rows = (DATA.userLicenses || []).map((u) => ({
      User: u.name,
      Email: u.email,
      Service: (u.services || []).join(", "),
      Tenant: u.tenant || "",
      Licenses: u.licenseCount,
      "Monthly cost (USD)": u.monthlyCost,
      "Wasted/mo (USD)": u.wastedMonthly,
      "Last activity": u.lastActivity || "",
      "License list": (u.licenses || []).map((l) => l.sku).join(", "),
    }));
    downloadXlsx("users", "Users", rows);
  });
}

/* ---------- Waste ---------- */
function renderWaste() {
  const k = DATA.kpis;
  const rows = DATA.wasteRows || [];
  const cols = [
    { key: "person", label: "Person", get: (r) => r.personName },
    { key: "service", label: "Service", get: (r) => r.service },
    { key: "license", label: "License", get: (r) => r.sku },
    { key: "status", label: "Status", get: (r) => r.status },
    { key: "lastused", label: "Last used", get: (r) => r.lastActivity || "" },
    { key: "days", label: "Unused days", num: true, get: (r) => r.wastedDays },
    { key: "cost", label: "Cost/mo", num: true, get: (r) => r.costMonthly },
    { key: "wastedSoFar", label: "Wasted so far", num: true, get: (r) => r.wastedSoFar },
  ];
  const sort = { key: "wastedSoFar", dir: -1 };

  $("#content").innerHTML = `
    <p class="section-hint small">${k.wastedSeats} wasted seats costing <b>${money(k.wastedMonthlySpend)}/mo</b> (${money(k.potentialAnnualSavings)}/yr). "Never" = assigned but never used; "Idle" = no activity in 45+ days. Click a column header to sort.</p>
    <div class="panel">
      ${excelToolbar("exportWaste")}
      <div id="wasteMount"></div>
    </div>
  `;

  function draw() {
    if (!rows.length) { $("#wasteMount").innerHTML = `<p class="muted">No waste detected 🎉</p>`; return; }
    const sorted = sortRows(rows, cols, sort);
    $("#wasteMount").innerHTML = `
      <table>
        <thead><tr>${sortHeaders(cols, sort)}</tr></thead>
        <tbody>${wasteRowsHtml(sorted)}</tbody>
      </table>`;
    wireSort($("#wasteMount"), cols, sort, draw);
  }
  draw();

  $("#exportWaste")?.addEventListener("click", () => {
    const rows = (DATA.wasteRows || []).map((r) => ({
      Person: r.personName,
      Email: r.email,
      Department: r.department || "",
      Service: r.service,
      License: r.sku,
      Status: r.status,
      "Last used": r.lastActivity || "Never",
      "Unused days": r.wastedDays ?? "",
      "Cost/mo (USD)": r.costMonthly,
      "Wasted so far (USD)": r.wastedSoFar ?? "",
    }));
    downloadXlsx("wasted-licenses", "Wasted", rows);
  });
}

function wasteRowsHtml(rows) {
  return rows.map((r) => `
          <tr>
            <td><div class="person"><span class="avatar">${initials(r.personName)}</span>
              <div><div>${escapeAttr(r.personName)}</div><div class="muted small">${escapeAttr(r.email)}</div></div></div></td>
            <td>${escapeAttr(r.service)}</td>
            <td>${escapeAttr(r.sku)}</td>
            <td>${statusPill(r.status)}</td>
            <td>${r.lastActivity ? new Date(r.lastActivity).toLocaleDateString() : `<span class="muted">Never</span>`}</td>
            <td class="num">${r.wastedDays ?? "—"}</td>
            <td class="num">${money2(r.costMonthly)}</td>
            <td class="num">${r.wastedSoFar == null ? `<span class="muted" title="Assignment start date unknown">—</span>` : `<b class="up">${money2(r.wastedSoFar)}</b>`}</td>
          </tr>`).join("");
}

// static (non-sortable) table — used on the Overview "top reclaim" panel
function wasteTable(rows) {
  if (!rows.length) return `<p class="muted">No waste detected 🎉</p>`;
  return `
    <table>
      <thead><tr>
        <th>Person</th><th>Service</th><th>License</th><th>Status</th>
        <th>Last used</th><th class="num">Unused days</th>
        <th class="num">Cost/mo</th><th class="num">Wasted so far</th>
      </tr></thead>
      <tbody>${wasteRowsHtml(rows)}</tbody>
    </table>`;
}

/* ---------- Inactive ---------- */
function renderInactive() {
  const rows = DATA.inactivePeople || [];
  const cols = [
    { key: "person", label: "Person", get: (p) => p.name },
    { key: "service", label: "Service", get: (p) => (p.services || []).join(", ") },
    { key: "tenant", label: "Tenant", get: (p) => p.tenant },
    { key: "licenses", label: "Licenses", num: true, get: (p) => p.licenses },
    { key: "lastlogin", label: "Last login", get: (p) => p.lastActivity || "" },
    { key: "days", label: "Days inactive", num: true, get: (p) => (p.daysSinceLastLogin == null ? Infinity : p.daysSinceLastLogin) },
    { key: "wasted", label: "Wasted/mo", num: true, get: (p) => p.wastedMonthly },
  ];
  const sort = { key: "wasted", dir: -1 };

  $("#content").innerHTML = `
    <p class="section-hint small">${rows.length} people haven't logged in / had any activity for <b>45+ days</b> — review for offboarding or license removal. Click a column header to sort.</p>
    <div class="panel">
      ${excelToolbar("exportInactive")}
      <div id="inactiveMount"></div>
    </div>`;

  function draw() {
    if (!rows.length) { $("#inactiveMount").innerHTML = `<p class="muted">Everyone is active 🎉</p>`; return; }
    const sorted = sortRows(rows, cols, sort);
    $("#inactiveMount").innerHTML = `
      <table>
        <thead><tr>${sortHeaders(cols, sort)}</tr></thead>
        <tbody>
          ${sorted.map((p) => `
            <tr>
              <td><div class="person"><span class="avatar">${initials(p.name)}</span>
                <div><div>${escapeAttr(p.name)}</div><div class="muted small">${escapeAttr(p.email)}</div></div></div></td>
              <td>${escapeAttr((p.services || []).join(", ")) || "—"}</td>
              <td>${escapeAttr(p.tenant) || "—"}</td>
              <td class="num">${p.licenses}</td>
              <td>${p.lastActivity ? new Date(p.lastActivity).toLocaleDateString() : `<span class="pill never">Never</span>`}</td>
              <td class="num">${p.daysSinceLastLogin ?? "∞"}</td>
              <td class="num">${money2(p.wastedMonthly)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    wireSort($("#inactiveMount"), cols, sort, draw);
  }
  draw();

  $("#exportInactive")?.addEventListener("click", () => {
    const out = (DATA.inactivePeople || []).map((p) => ({
      Person: p.name,
      Email: p.email,
      Service: (p.services || []).join(", "),
      Tenant: p.tenant || "",
      Licenses: p.licenses,
      "Last login": p.lastActivity || "Never",
      "Days inactive": p.daysSinceLastLogin ?? "",
      "Wasted/mo (USD)": p.wastedMonthly,
    }));
    downloadXlsx("inactive-users", "Inactive", out);
  });
}

/* ---------- Renewals ---------- */
function renderRenewals() {
  const rows = DATA.upcomingRenewals || [];
  const cols = [
    { key: "service", label: "Service", get: (s) => s.service },
    { key: "license", label: "License", get: (s) => s.name },
    { key: "seats", label: "Seats", num: true, get: (s) => s.seatsTotal },
    { key: "unit", label: "Unit/mo", num: true, get: (s) => s.unitCostMonthly },
    { key: "date", label: "Renewal date", get: (s) => s.renewalDate || "" },
    { key: "indays", label: "In days", num: true, get: (s) => s.inDays },
  ];
  const sort = { key: "indays", dir: 1 };

  $("#content").innerHTML = `
    <p class="section-hint small">${rows.length} subscription(s) renewing within 45 days. Review before auto-renewal to cut wasted seats first. Click a column header to sort.</p>
    <div class="panel">
      ${excelToolbar("exportRenewals")}
      <div id="renewalMount"></div>
    </div>`;

  function draw() {
    if (!rows.length) { $("#renewalMount").innerHTML = `<p class="muted">No renewals in the next 45 days.</p>`; return; }
    const sorted = sortRows(rows, cols, sort);
    $("#renewalMount").innerHTML = `
      <table>
        <thead><tr>${sortHeaders(cols, sort)}</tr></thead>
        <tbody>
          ${sorted.map((s) => `
            <tr>
              <td>${escapeAttr(s.service)}</td>
              <td>${escapeAttr(s.name)}</td>
              <td class="num">${s.seatsTotal ?? "—"}</td>
              <td class="num">${money2(s.unitCostMonthly)}</td>
              <td>${new Date(s.renewalDate).toLocaleDateString()}</td>
              <td class="num">${renewPill(s.inDays)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    wireSort($("#renewalMount"), cols, sort, draw);
  }
  draw();

  $("#exportRenewals")?.addEventListener("click", () => {
    const out = (DATA.upcomingRenewals || []).map((s) => ({
      Service: s.service,
      License: s.name,
      Seats: s.seatsTotal ?? "",
      "Unit/mo (USD)": s.unitCostMonthly,
      "Renewal date": s.renewalDate,
      "In days": s.inDays,
    }));
    downloadXlsx("renewals", "Renewals", out);
  });
}

/* ---------- License types (editable pricing) ---------- */
async function renderLicenses() {
  $("#content").innerHTML = `<div class="loading">Loading license types…</div>`;
  const [res, mres] = await Promise.all([fetch("/api/licenses"), fetch("/api/manual-licenses")]);
  const data = await res.json();
  if (data.error) { $("#content").innerHTML = `<div class="loading">Error: ${data.error}</div>`; return; }
  const rows = data.licenses;
  const purchasedSeats = (l) => l.seatsPurchased ?? l.seatsTotal ?? l.billableSeats ?? l.seatsAssigned;
  const assignedSeats = (l) => l.seatsAssigned ?? 0;
  const availableSeats = (l) => l.seatsAvailable ?? Math.max(purchasedSeats(l) - assignedSeats(l), 0);
  const billableSeats = (l) => l.billableSeats ?? purchasedSeats(l);
  const formatDate = (v) => v ? new Date(v).toLocaleDateString() : "—";
  const statusPill = (status) => {
    if (!status) return `<span class="pill na">N/A</span>`;
    const s = String(status || "").toLowerCase();
    const cls = s === "active" ? "active" : s === "warning" ? "idle" : s === "disabled" ? "never" : "na";
    return `<span class="pill ${cls}">${escapeAttr(status)}</span>`;
  };
  const manualById = {};
  try { (await mres.json()).manual.forEach((m) => (manualById[m.id] = m)); } catch {}

  $("#content").innerHTML = `
    <div class="panel" style="margin-bottom:16px">
      <h3>Add a license manually</h3>
      <p class="section-hint small" style="margin-top:0">For tools with no connector/API (e.g. Odoo, Figma, Canva). Enter seats and how many are unused to track its cost & waste.</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
        <label class="fld">Vendor / service<input id="mService" placeholder="Odoo"></label>
        <label class="fld">License name<input id="mName" placeholder="Odoo Enterprise"></label>
        <label class="fld">Price/license ($/mo)<input id="mPrice" type="text" inputmode="decimal" placeholder="30"></label>
        <label class="fld">Total seats<input id="mSeats" type="number" min="0" step="1" placeholder="10"></label>
        <label class="fld">Unused seats<input id="mUnused" type="number" min="0" step="1" placeholder="3"></label>
        <label class="fld">Unused since (opt.)<input id="mSince" type="date"></label>
        <button class="btn primary" id="addManual">+ Add license</button>
      </div>
      <span class="muted small" id="addMsg"></span>
    </div>

    <p class="section-hint small">Click <b>Edit</b> on any license to change its details. For <b>fetched</b> licenses you can edit the name & price; <b>manual</b> licenses are fully editable. Monthly cost is now calculated from <b>purchased quantity</b> when the connector provides it, because that is what billing typically follows. Click a column header to sort.</p>
    <div class="panel">
      <div id="licTableMount"></div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
        <button class="btn" id="resetPrices">Reset fetched to defaults</button>
        <button class="btn" id="exportLicenses">⬇ Excel</button>
        <span class="muted small" id="saveMsg"></span>
      </div>
    </div>
    <div id="modalMount"></div>`;

  // ---- Add manual license ----
  $("#addManual").addEventListener("click", async () => {
    const body = {
      service: $("#mService").value,
      name: $("#mName").value,
      unitCostMonthly: toDot($("#mPrice").value),
      seatsTotal: $("#mSeats").value,
      unusedSeats: $("#mUnused").value,
      unusedSince: $("#mSince").value || null,
    };
    if (!body.name.trim()) { $("#addMsg").textContent = "License name is required."; return; }
    $("#addMsg").textContent = "Adding…";
    const r = await fetch("/api/manual-licenses", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) { $("#addMsg").textContent = "Error: " + j.error; return; }
    await load();
  });

  // ---- Sortable, re-drawable license table ----
  const byId = Object.fromEntries(rows.map((l) => [l.skuId, l]));
  const licCols = [
    { key: "name", label: "License type", get: (l) => l.name },
    { key: "service", label: "Service", get: (l) => l.service },
    { key: "status", label: "Status", get: (l) => l.status || "" },
    { key: "purchased", label: "Purchased", num: true, get: (l) => billableSeats(l) },
    { key: "assigned", label: "Assigned", num: true, get: (l) => assignedSeats(l) },
    { key: "available", label: "Available", num: true, get: (l) => availableSeats(l) },
    { key: "renewal", label: "Renewal / expiration", get: (l) => l.renewalDate || "" },
    { key: "default", label: "Fetched default", num: true, get: (l) => l.defaultPrice },
    { key: "price", label: "Price / license ($/mo)", num: true, get: (l) => l.price },
    { key: "monthly", label: "Monthly cost", num: true, get: (l) => l.price * billableSeats(l) },
    { key: "__actions", label: "", num: true, sortable: false, get: () => 0 },
  ];
  const licSort = { key: "monthly", dir: -1 };

  function drawLicTable() {
    if (!rows.length) { $("#licTableMount").innerHTML = `<p class="muted">No licenses found.</p>`; return; }
    const sorted = sortRows(rows, licCols, licSort);
    $("#licTableMount").innerHTML = `
      <div class="table-scroll">
      <table class="license-table">
        <thead><tr>${sortHeaders(licCols, licSort)}</tr></thead>
        <tbody>
          ${sorted.map((l) => `
            <tr data-sku="${encodeURIComponent(l.skuId)}">
              <td>
                <b>${escapeAttr(l.name)}</b>
                ${l.manual ? `<span class="pill idle">manual</span>` : ""} ${l.overridden ? `<span class="pill active">edited</span>` : ""}
              </td>
              <td>${escapeAttr(l.service)}</td>
              <td>${statusPill(l.status)}</td>
              <td class="num">${billableSeats(l)}</td>
              <td class="num">${assignedSeats(l)}</td>
              <td class="num">${availableSeats(l)}</td>
              <td>${formatDate(l.renewalDate)}</td>
              <td class="num muted">${money2(l.defaultPrice)}</td>
              <td class="num">${money2(l.price)}</td>
              <td class="num">${money2(l.price * billableSeats(l))}</td>
              <td class="num">
                <div class="row-actions">
                  <button class="btn edit-lic" data-sku="${encodeURIComponent(l.skuId)}" style="padding:5px 11px">Edit</button>
                  ${l.manual ? `<button class="btn danger del-manual" data-id="${l.skuId}" style="padding:5px 11px">Delete</button>` : ""}
                </div>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>`;

    $("#licTableMount").querySelectorAll(".del-manual").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this manual license?")) return;
        await fetch("/api/manual-licenses/" + encodeURIComponent(btn.dataset.id), { method: "DELETE" });
        await load();
      });
    });
    $("#licTableMount").querySelectorAll(".edit-lic").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sku = decodeURIComponent(btn.dataset.sku);
        openEditModal(byId[sku], manualById[sku]);
      });
    });
    wireSort($("#licTableMount"), licCols, licSort, drawLicTable);
  }
  drawLicTable();

  function closeModal() { $("#modalMount").innerHTML = ""; }

  function openEditModal(lic, manual) {
    const isManual = !!lic.manual;
    const fields = isManual
      ? `
        <label class="fld">Vendor / service<input id="eService" value="${escapeAttr(manual?.service ?? lic.service)}"></label>
        <label class="fld">License name<input id="eName" value="${escapeAttr(lic.name)}"></label>
        <label class="fld">Price / license ($/mo)<input id="ePrice" type="text" inputmode="decimal" value="${manual?.unitCostMonthly ?? lic.price}"></label>
        <label class="fld">Total seats<input id="eSeats" type="number" min="0" step="1" value="${manual?.seatsTotal ?? lic.seatsAssigned}"></label>
        <label class="fld">Unused seats<input id="eUnused" type="number" min="0" step="1" value="${manual?.unusedSeats ?? 0}"
          ${manual?.assignedTo?.length ? "disabled" : ""}>
          <span class="fld-note">${manual?.assignedTo?.length ? "Auto-computed from assigned users below." : "Used only when no users are assigned."}</span></label>
        <label class="fld">Unused since (opt.)<input id="eSince" type="date" value="${manual?.unusedSince ?? ""}"></label>
        <div class="fld" style="grid-column:1/-1">
          Assign to users
          <span class="fld-note">Linked users count this license in their totals; unassigned seats are treated as unused/waste.</span>
          <input id="assignSearch" placeholder="Search users…" style="width:100%;padding:7px 10px;margin-top:6px;border:1px solid var(--border,#2a2f3a);border-radius:8px;background:transparent;color:inherit">
          <div id="assignList" style="max-height:190px;overflow:auto;border:1px solid var(--border,#2a2f3a);border-radius:8px;margin-top:6px;padding:6px">
            <span class="muted small">Loading users…</span>
          </div>
          <span class="muted small" id="assignCount"></span>
        </div>`
      : `
        <label class="fld">License name<input id="eName" value="${escapeAttr(lic.name)}">
          <span class="fld-note">Fetched name: ${escapeAttr(lic.defaultName)}</span></label>
        <label class="fld">Price / license ($/mo)<input id="ePrice" type="text" inputmode="decimal" value="${lic.price}">
          <span class="fld-note">Fetched default: ${money2(lic.defaultPrice)}</span></label>
        <label class="fld">Service<input value="${escapeAttr(lic.service)}" disabled>
          <span class="fld-note">From connector — read-only</span></label>
        <label class="fld">Purchased quantity<input value="${billableSeats(lic)}" disabled>
          <span class="fld-note">Used for monthly spend when the connector provides purchased quantity.</span></label>
        <label class="fld">Assigned quantity<input value="${assignedSeats(lic)}" disabled>
          <span class="fld-note">Current user assignments from the connector.</span></label>
        <label class="fld">Available quantity<input value="${availableSeats(lic)}" disabled>
          <span class="fld-note">Purchased minus assigned.</span></label>
        <label class="fld">Status<input value="${escapeAttr(lic.status || "N/A")}" disabled>
          <span class="fld-note">Subscription state from the connector.</span></label>
        <label class="fld">Renewal / expiration<input value="${escapeAttr(formatDate(lic.renewalDate))}" disabled>
          <span class="fld-note">Best available lifecycle date from the connector.</span></label>`;

    $("#modalMount").innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <h3>Edit license</h3>
          <p class="modal-sub">${isManual ? "Manual license — all fields editable." : "Fetched license — name & price override the connector values."}</p>
          ${fields}
          <div class="modal-actions">
            <button class="btn" id="mCancel">Cancel</button>
            <button class="btn primary" id="mSave">Save changes</button>
          </div>
          <span class="muted small" id="mMsg"></span>
        </div>
      </div>`;

    $("#mCancel").addEventListener("click", closeModal);
    $("#modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") closeModal(); });

    // user-assignment picker (manual licenses only)
    const selected = new Set(manual?.assignedTo || []);
    let allUsers = [];
    if (isManual) {
      const updateCount = () => { $("#assignCount").textContent = `${selected.size} user(s) assigned`; };
      const drawList = (q = "") => {
        const ql = q.toLowerCase().trim();
        const shown = allUsers.filter((u) =>
          !ql || (u.name || "").toLowerCase().includes(ql) || (u.email || "").toLowerCase().includes(ql));
        $("#assignList").innerHTML = shown.length
          ? shown.map((u) => `
            <label style="display:flex;gap:8px;align-items:center;padding:4px 2px;font-size:13px;cursor:pointer">
              <input type="checkbox" data-uid="${escapeAttr(u.id)}" ${selected.has(u.id) ? "checked" : ""}>
              <span>${escapeAttr(u.name || u.id)}${u.email ? ` <span class="muted small">${escapeAttr(u.email)}</span>` : ""}</span>
            </label>`).join("")
          : `<span class="muted small">No matching users.</span>`;
        $("#assignList").querySelectorAll("input[data-uid]").forEach((cb) => {
          cb.addEventListener("change", () => {
            if (cb.checked) selected.add(cb.dataset.uid); else selected.delete(cb.dataset.uid);
            updateCount();
          });
        });
      };
      updateCount();
      fetch("/api/users").then((r) => r.json()).then((j) => {
        allUsers = j.users || [];
        if (!allUsers.length) { $("#assignList").innerHTML = `<span class="muted small">No connector users found — configure a connector first.</span>`; return; }
        drawList();
        $("#assignSearch").addEventListener("input", () => drawList($("#assignSearch").value));
      }).catch(() => { $("#assignList").innerHTML = `<span class="muted small">Failed to load users.</span>`; });
    }

    $("#mSave").addEventListener("click", async () => {
      $("#mMsg").textContent = "Saving…";
      if (isManual) {
        const body = {
          service: $("#eService").value,
          name: $("#eName").value,
          unitCostMonthly: toDot($("#ePrice").value),
          seatsTotal: $("#eSeats").value,
          unusedSeats: $("#eUnused").value,
          unusedSince: $("#eSince").value || null,
          assignedTo: [...selected],
        };
        if (!body.name.trim()) { $("#mMsg").textContent = "License name is required."; return; }
        const r = await fetch("/api/manual-licenses/" + encodeURIComponent(lic.skuId), {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!j.ok) { $("#mMsg").textContent = "Error: " + j.error; return; }
      } else {
        const entry = {};
        const name = $("#eName").value.trim();
        const priceVal = toDot($("#ePrice").value);
        if (name) entry.name = name;
        if (priceVal !== "") entry.price = Number(priceVal);
        await fetch("/api/prices", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides: { [lic.skuId]: entry } }),
        });
      }
      closeModal();
      await load();
    });
  }

  // ---- Reset fetched overrides ----
  $("#resetPrices").addEventListener("click", async () => {
    if (!confirm("Reset all fetched-license name/price overrides to their connector defaults?")) return;
    await fetch("/api/prices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    await load();
  });

  $("#exportLicenses")?.addEventListener("click", () => {
    const out = rows.map((l) => ({
      "License type": l.name,
      Service: l.service,
      Status: l.status || "",
      "Purchased quantity": billableSeats(l),
      "Assigned quantity": assignedSeats(l),
      "Available quantity": availableSeats(l),
      "Renewal / expiration": l.renewalDate || "",
      "Fetched default (USD)": l.defaultPrice,
      "Price/license (USD)": l.price,
      "Monthly cost (USD)": Math.round(l.price * billableSeats(l) * 100) / 100,
      Manual: l.manual ? "yes" : "no",
      Edited: l.overridden ? "yes" : "no",
    }));
    downloadXlsx("license-types", "Licenses", out);
  });
}

/* ---------- Connectors ---------- */
function connStatusPill(ok) {
  return `<span class="pill ${ok ? "active" : "never"}">${ok ? "configured" : "not set"}</span>`;
}

// render one config field (input id is scoped by instance id)
function connField(instId, f, config, secretSet) {
  const fid = `f_${instId}_${f.key}`;
  if (f.type === "bool") {
    return `<label style="display:flex;gap:8px;align-items:center;font-size:13px;font-weight:600">
        <input id="${fid}" data-key="${f.key}" data-type="bool" type="checkbox" ${config[f.key] ? "checked" : ""}> ${f.label}
      </label>`;
  }
  if (f.type === "secret") {
    const isSet = secretSet?.[f.key];
    return `<label class="fld">${f.label}<input id="${fid}" data-key="${f.key}" data-type="secret" type="password"
        placeholder="${isSet ? "•••••• (leave blank to keep)" : (f.placeholder || "")}" style="width:260px"></label>`;
  }
  const isNum = f.type === "number";
  const dataType = isNum ? "number" : "text";
  const extra = isNum ? `inputmode="decimal"` : "";
  return `<label class="fld">${f.label}<input id="${fid}" data-key="${f.key}" data-type="${dataType}" type="text" ${extra}
      value="${escapeAttr(config[f.key] ?? "")}" placeholder="${escapeAttr(f.placeholder || "")}" style="width:${isNum ? 140 : 260}px"></label>`;
}

function connInstancePanel(inst, cat) {
  const fields = cat.fields.map((f) => connField(inst.id, f, inst.config || {}, inst.secretSet)).join("");
  return `
    <div class="panel" style="margin-bottom:16px" data-inst="${inst.id}" data-type="${inst.type}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div style="flex:1">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input class="inst-name" value="${escapeAttr(inst.name)}" placeholder="${escapeAttr(cat.label)}"
              style="font-size:15px;font-weight:700;border:1px solid transparent;border-radius:7px;padding:4px 7px;min-width:220px">
            ${connStatusPill(inst.configured)}
            <span class="muted small">${escapeAttr(cat.label)}</span>
          </div>
        </div>
        <button class="btn danger inst-remove" style="padding:5px 11px">Remove</button>
      </div>
      ${cat.hint ? `<p class="section-hint small" style="margin-top:8px">${escapeAttr(cat.hint)}</p>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-top:8px">${fields}</div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
        <button class="btn primary inst-save">Save</button>
        <span class="muted small inst-msg"></span>
      </div>
    </div>`;
}

async function renderConnectors() {
  $("#content").innerHTML = `<div class="loading">Loading connectors…</div>`;
  const c = await (await fetch("/api/connectors")).json();
  const live = c.source === "live";
  const catById = Object.fromEntries((c.catalog || []).map((x) => [x.id, x]));
  const instances = c.instances || [];

  $("#content").innerHTML = `
    <div class="panel" style="margin-bottom:16px">
      <h3>Data source</h3>
      <p class="section-hint small" style="margin-top:0">Switch to <b>Live</b> to pull real usage from your connectors. <b>Mock</b> shows sample data.</p>
      <div style="display:flex;gap:12px;align-items:flex-end">
        <label class="fld" style="max-width:220px">Mode
          <select id="cSource" style="padding:9px 11px;border:1px solid var(--line);border-radius:8px">
            <option value="mock" ${live ? "" : "selected"}>Mock (sample data)</option>
            <option value="live" ${live ? "selected" : ""}>Live connectors</option>
          </select>
        </label>
        <button class="btn primary" id="saveSource">Save</button>
        <span class="muted small" id="sourceMsg"></span>
      </div>
    </div>

    <div class="panel" style="margin-bottom:16px">
      <h3>Add a connector</h3>
      <p class="section-hint small" style="margin-top:0">Pick a supported service. You can add several of the same type (e.g. two GitHub orgs or two M365 tenants).</p>
      <div style="display:flex;gap:12px;align-items:flex-end">
        <label class="fld" style="max-width:280px">Connector
          <select id="addConnSel" style="padding:9px 11px;border:1px solid var(--line);border-radius:8px">
            ${(c.catalog || []).map((x) => `<option value="${x.id}">${x.label}</option>`).join("")}
          </select>
        </label>
        <button class="btn primary" id="addConnBtn">+ Add connector</button>
      </div>
    </div>

    <h3 style="margin:18px 2px 12px">Your connectors ${instances.length ? `<span class="muted small">(${instances.length})</span>` : ""}</h3>
    ${instances.map((inst) => connInstancePanel(inst, catById[inst.type] || { label: inst.type, fields: [] })).join("")}
    ${instances.length === 0 ? `<p class="muted small">No connectors yet — add one above.</p>` : ""}`;

  // data source
  $("#saveSource").addEventListener("click", async () => {
    $("#sourceMsg").textContent = "Saving…";
    await fetch("/api/connectors/source", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: $("#cSource").value }),
    });
    $("#sourceMsg").textContent = "Saved. Re-fetching…";
    await load();
    render("connectors");
  });

  // add instance
  $("#addConnBtn").addEventListener("click", async () => {
    const type = $("#addConnSel").value;
    await fetch("/api/connectors/instances", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type }),
    });
    render("connectors");
  });

  // per-instance save + remove
  $("#content").querySelectorAll("[data-inst]").forEach((panel) => {
    const id = panel.dataset.inst;
    const msg = panel.querySelector(".inst-msg");

    panel.querySelector(".inst-save").addEventListener("click", async () => {
      const config = {};
      panel.querySelectorAll("input[data-key]").forEach((inp) => {
        const key = inp.dataset.key;
        if (inp.dataset.type === "bool") config[key] = inp.checked;
        else if (inp.dataset.type === "number") config[key] = toDot(inp.value);
        else config[key] = inp.value;
      });
      const name = panel.querySelector(".inst-name").value;
      msg.textContent = "Saving…";
      const r = await fetch("/api/connectors/instances/" + encodeURIComponent(id), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, config }),
      });
      const j = await r.json();
      if (!j.ok) { msg.textContent = "Error: " + j.error; return; }
      msg.textContent = "Saved. Re-fetching…";
      await load();
      render("connectors");
    });

    panel.querySelector(".inst-remove").addEventListener("click", async () => {
      if (!confirm("Remove this connector? Its saved credentials will be deleted.")) return;
      await fetch("/api/connectors/instances/" + encodeURIComponent(id), { method: "DELETE" });
      await load();
      render("connectors");
    });
  });
}


/* ---------- helpers ---------- */
function statusPill(s) {
  if (s === "never") return `<span class="pill never">Never</span>`;
  if (s === "idle") return `<span class="pill idle">Idle</span>`;
  return `<span class="pill active">Active</span>`;
}
function renewPill(d) {
  const cls = d <= 14 ? "never" : d <= 30 ? "idle" : "active";
  return `<span class="pill ${cls}">${d}d</span>`;
}
function initials(name) {
  return escapeAttr((name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase());
}
function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------- sortable tables ----------
   cols: [{ key, label, num?, sortable?, get(row) }]
   state: { key, dir }  (dir: 1 asc, -1 desc)  */
function sortIndicator(col, state) {
  if (state.key !== col.key) return `<span class="muted" style="opacity:.4">↕</span>`;
  return `<span>${state.dir === 1 ? "▲" : "▼"}</span>`;
}
function sortHeaders(cols, state) {
  return cols.map((c) => {
    if (c.sortable === false) return `<th class="${c.num ? "num" : ""}">${escapeAttr(c.label)}</th>`;
    return `<th class="${c.num ? "num " : ""}sortable" data-sortkey="${escapeAttr(c.key)}" style="cursor:pointer;user-select:none;white-space:nowrap">${escapeAttr(c.label)} ${sortIndicator(c, state)}</th>`;
  }).join("");
}
function sortRows(rows, cols, state) {
  const col = cols.find((c) => c.key === state.key);
  if (!col || col.sortable === false) return rows.slice();
  const get = col.get;
  return rows.slice().sort((a, b) => {
    let x = get(a), y = get(b);
    const xn = x == null, yn = y == null;
    if (xn && yn) return 0;
    if (xn) return 1;  // nulls always last
    if (yn) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * state.dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" }) * state.dir;
  });
}
function wireSort(container, cols, state, redraw) {
  container.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortkey;
      if (state.key === key) state.dir = -state.dir;
      else { const c = cols.find((x) => x.key === key); state.key = key; state.dir = c && c.num ? -1 : 1; } // numeric first click = high→low
      redraw();
    });
  });
}
function round(n) { return Math.round(n * 100) / 100; }
function barOpts() {
  return {
    responsive: true, maintainAspectRatio: false,
    scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v) => "$" + v } } },
    plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } },
  };
}
function destroyCharts() {
  Object.values(charts).forEach((c) => c?.destroy());
  charts = {};
}

/* ---------- nav ---------- */
document.querySelectorAll(".nav-item").forEach((el) => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    el.classList.add("active");
    render(el.dataset.section);
  });
});
$("#refreshBtn").addEventListener("click", () => load(true));

load();
