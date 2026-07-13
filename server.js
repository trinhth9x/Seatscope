import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildDashboard } from "./src/aggregate.js";
import { manualRaw, mergeRaw } from "./src/manual.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dependency) ---
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const PORT = process.env.PORT || 4000;
const OVERRIDES_FILE = path.join(__dirname, "data", "price-overrides.json");
const MANUAL_FILE = path.join(__dirname, "data", "manual-licenses.json");
const CONNECTORS_FILE = path.join(__dirname, "data", "connectors.json");

// --- connectors (data/connectors.json). Instance-based: the user can add many
// connectors, including several of the same type (e.g. two GitHub orgs). The
// user's real .env is never modified; env values only seed the first run. ---
//
// Each connector type declares its config fields; `secret` fields are masked on
// read (never sent to the browser) and preserved when saved blank.
const CONNECTOR_CATALOG = [
  {
    id: "github", label: "GitHub",
    fields: [
      { key: "org", label: "Organization", type: "text", placeholder: "myorg" },
      { key: "token", label: "Access token", type: "secret" },
      { key: "enterpriseSeats", label: "Also detect dormant GitHub Enterprise members", type: "bool" },
      { key: "copilotUnitCost", label: "Copilot $/seat (opt.)", type: "number" },
      { key: "enterpriseUnitCost", label: "Enterprise $/seat (opt.)", type: "number" },
    ],
    hint: "One org per connector — add another GitHub connector for each org. Copilot seats need a classic PAT with read:org, manage_billing:copilot; Enterprise activity also needs read:audit_log. For SAML orgs, authorize the token via “Configure SSO”.",
    required: ["org", "token"],
  },
  {
    id: "m365", label: "Microsoft 365 / Entra ID",
    fields: [
      { key: "tenantId", label: "Tenant ID", type: "text", placeholder: "00000000-0000-…" },
      { key: "clientId", label: "Client ID", type: "text", placeholder: "app registration id" },
      { key: "clientSecret", label: "Client secret", type: "secret" },
    ],
    hint: "Read-only app-only Graph. Entra app needs admin-consented Organization.Read.All, User.Read.All, AuditLog.Read.All. Last-used (signInActivity) requires Entra ID P1.",
    required: ["tenantId", "clientId", "clientSecret"],
  },
  {
    id: "azure-devops", label: "Azure DevOps",
    fields: [
      { key: "org", label: "Organization", type: "text", placeholder: "myorg (not the full URL)" },
      { key: "token", label: "Access token (PAT)", type: "secret" },
    ],
    hint: "PAT needs Member Entitlement Management (Read). Detects unused paid Basic / Basic + Test Plans seats.",
    required: ["org", "token"],
  },
  {
    id: "jira", label: "Jira (Atlassian)",
    fields: [
      { key: "orgId", label: "Organization ID", type: "text", placeholder: "admin.atlassian.com org id" },
      { key: "apiKey", label: "Admin API key", type: "secret" },
      { key: "unitCost", label: "$/seat (opt.)", type: "number" },
    ],
    hint: "Read-only via the Atlassian Organizations admin API — per-product last_active, so unused Jira seats are measured, not guessed.",
    required: ["orgId", "apiKey"],
  },
];
const CATALOG_BY_ID = Object.fromEntries(CONNECTOR_CATALOG.map((c) => [c.id, c]));
const secretKeys = (type) => (CATALOG_BY_ID[type]?.fields || []).filter((f) => f.type === "secret").map((f) => f.key);

function loadConnectors() {
  try { return normalizeConnectorState(JSON.parse(fs.readFileSync(CONNECTORS_FILE, "utf8"))); } catch { return {}; }
}
function saveConnectors(cfg) {
  const normalized = normalizeConnectorState(cfg);
  fs.mkdirSync(path.dirname(CONNECTORS_FILE), { recursive: true });
  fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

// First run: turn any credentials found in .env (or a legacy flat config) into
// connector instances so existing live setups keep working after the upgrade.
function seedFromEnv() {
  const e = process.env;
  const out = [];
  if (e.GITHUB_TOKEN && e.GITHUB_ORG) {
    // one GitHub connector per org (env may list several comma-separated)
    for (const org of e.GITHUB_ORG.split(",").map((s) => s.trim()).filter(Boolean)) {
      out.push({
        type: "github", name: `GitHub — ${org}`,
        config: {
          org, token: e.GITHUB_TOKEN,
          enterpriseSeats: !!e.GITHUB_ENTERPRISE_SEATS && e.GITHUB_ENTERPRISE_SEATS !== "0",
          copilotUnitCost: e.GITHUB_COPILOT_UNIT_COST || "", enterpriseUnitCost: e.GITHUB_ENTERPRISE_UNIT_COST || "",
        },
      });
    }
  }
  if (e.MS_TENANT_ID && e.MS_CLIENT_ID && e.MS_CLIENT_SECRET) out.push({
    type: "m365", name: `Microsoft 365 — ${e.MS_TENANT_ID}`,
    config: { tenantId: e.MS_TENANT_ID, clientId: e.MS_CLIENT_ID, clientSecret: e.MS_CLIENT_SECRET },
  });
  if (e.AZURE_DEVOPS_ORG && e.AZURE_DEVOPS_TOKEN) out.push({
    type: "azure-devops", name: `Azure DevOps — ${e.AZURE_DEVOPS_ORG}`,
    config: { org: e.AZURE_DEVOPS_ORG, token: e.AZURE_DEVOPS_TOKEN },
  });
  if (e.JIRA_ORG_ID && e.JIRA_ADMIN_API_KEY) out.push({
    type: "jira", name: `Jira — ${e.JIRA_ORG_ID}`,
    config: { orgId: e.JIRA_ORG_ID, apiKey: e.JIRA_ADMIN_API_KEY, unitCost: e.JIRA_UNIT_COST || "" },
  });
  return out.map((i) => ({ id: randomUUID(), ...i }));
}

// migrate legacy config (flat fields / no instances) to instance-based on load.
// Legacy UI values were stored as flat fields; copy them into process.env first
// so seedFromEnv() captures connectors the user configured via the old UI too.
(function migrateConnectors() {
  const cfg = loadConnectors();
  if (Array.isArray(cfg.instances)) return;
  const LEGACY_ENV = {
    githubOrg: "GITHUB_ORG", githubToken: "GITHUB_TOKEN", githubEnterpriseSeats: "GITHUB_ENTERPRISE_SEATS",
    githubCopilotUnitCost: "GITHUB_COPILOT_UNIT_COST", githubEnterpriseUnitCost: "GITHUB_ENTERPRISE_UNIT_COST",
    msTenantId: "MS_TENANT_ID", msClientId: "MS_CLIENT_ID", msClientSecret: "MS_CLIENT_SECRET",
    azureDevopsOrg: "AZURE_DEVOPS_ORG", azureDevopsToken: "AZURE_DEVOPS_TOKEN",
    jiraOrgId: "JIRA_ORG_ID", jiraApiKey: "JIRA_ADMIN_API_KEY", jiraUnitCost: "JIRA_UNIT_COST",
  };
  for (const [k, envKey] of Object.entries(LEGACY_ENV)) {
    if (cfg[k] != null && String(cfg[k]) !== "") process.env[envKey] = String(cfg[k]);
  }
  const next = { instances: seedFromEnv() };
  if (cfg.dataSource) next.dataSource = cfg.dataSource;
  saveConnectors(next);
})();

function getInstances() {
  return getInstancesFrom(loadConnectors());
}
function getInstancesFrom(cfg, { configuredOnly = false } = {}) {
  const instances = Array.isArray(cfg?.instances) ? cfg.instances : [];
  return configuredOnly ? instances.filter(connectorConfigured) : instances;
}
function connectorConfigured(inst) {
  const req = CATALOG_BY_ID[inst.type]?.required || [];
  return req.every((k) => String(inst.config?.[k] ?? "").trim() !== "");
}
function normalizeConnectorState(cfg) {
  if (!cfg || typeof cfg !== "object") return {};
  if (cfg.dataSource === "live" && getInstancesFrom(cfg, { configuredOnly: true }).length === 0) {
    return { ...cfg, dataSource: "mock" };
  }
  return cfg;
}
// strip secret values before sending an instance to the browser
function maskInstance(inst) {
  const secrets = new Set(secretKeys(inst.type));
  const config = {};
  const secretSet = {};
  for (const [k, v] of Object.entries(inst.config || {})) {
    if (secrets.has(k)) { secretSet[k] = String(v ?? "").trim() !== ""; }
    else config[k] = v;
  }
  for (const k of secrets) if (!(k in secretSet)) secretSet[k] = false;
  return { id: inst.id, type: inst.type, name: inst.name || "", config, secretSet, configured: connectorConfigured(inst) };
}

const currentSource = () => {
  const cfg = loadConnectors();
  const hasConfiguredConnectors = getInstancesFrom(cfg, { configuredOnly: true }).length > 0;
  return cfg.dataSource === "live" || (!cfg.dataSource && process.env.DATA_SOURCE === "live" && hasConfiguredConnectors)
    ? "live"
    : "mock";
};

const app = express();
app.disable("x-powered-by");

// --- security headers (no dependency). The frontend is fully self-hosted
// (vendored JS/CSS, no external CDNs), so a strict CSP is safe here. ---
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- price overrides (persisted, no DB) ---
function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveOverrides(obj) {
  fs.mkdirSync(path.dirname(OVERRIDES_FILE), { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(obj, null, 2));
}
// an override may be a plain number (legacy = price) or an object { price, name }
function ovOf(v) {
  if (v && typeof v === "object") return v;
  if (v != null && v !== "") return { price: Number(v) };
  return {};
}

function normalizeFetchedLicenseName(sku, name) {
  if (sku?.manual || sku?.serviceId !== "m365") return String(name || "").trim();
  return String(name || "").replace(/_/g, " ").trim();
}

function applyOverrides(raw, overrides) {
  return {
    ...raw,
    skus: raw.skus.map((s) => {
      const o = ovOf(overrides[s.id]);
      if (o.price == null && !o.name) return s;
      return {
        ...s,
        unitCostMonthly: o.price != null && o.price !== "" ? Number(o.price) : s.unitCostMonthly,
        name: o.name && String(o.name).trim() ? normalizeFetchedLicenseName(s, o.name) : s.name,
      };
    }),
  };
}

// --- manual licenses (persisted) ---
function loadManual() {
  try {
    const arr = JSON.parse(fs.readFileSync(MANUAL_FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveManual(arr) {
  fs.mkdirSync(path.dirname(MANUAL_FILE), { recursive: true });
  fs.writeFileSync(MANUAL_FILE, JSON.stringify(arr, null, 2));
}

// --- caches: connector raw (slow) is kept; manual + prices merge in cheaply ---
let rawCache = null; // connector-only
let dashCache = null;
let rawFetchedAt = null; // when connectors were last actually run

async function getConnectorRaw() {
  if (rawCache) return rawCache;
  const source = currentSource();
  const mod = await import(`./src/connectors/${source}.js`);
  rawCache = source === "live"
    ? await mod.collect(getInstancesFrom(loadConnectors(), { configuredOnly: true }))
    : await mod.collect();
  rawFetchedAt = new Date().toISOString();
  return rawCache;
}
async function getMergedRaw() {
  const conn = await getConnectorRaw();
  return mergeRaw(conn, manualRaw(loadManual(), conn.people));
}
async function getDashboard() {
  if (dashCache) return dashCache;
  dashCache = buildDashboard(applyOverrides(await getMergedRaw(), loadOverrides()));
  return dashCache;
}

app.get("/api/dashboard", async (req, res) => {
  try {
    if (req.query.refresh === "1") { rawCache = null; dashCache = null; } // re-run connectors
    res.json({ source: currentSource(), dataFetchedAt: rawFetchedAt, ...(await getDashboard()) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// license types with default (fetched) price + current effective price
app.get("/api/licenses", async (_req, res) => {
  try {
    const raw = await getMergedRaw();
    const overrides = loadOverrides();
    const svc = Object.fromEntries(raw.services.map((s) => [s.id, s.name]));
    const seatsHeld = {};
    for (const a of raw.assignments) seatsHeld[a.skuId] = (seatsHeld[a.skuId] || 0) + 1;
    const licenses = raw.skus.map((s) => {
      const o = ovOf(overrides[s.id]);
      const seatsAssigned = seatsHeld[s.id] || 0;
      const seatsPurchased = s.seatsTotal ?? null;
      const billableSeats = seatsPurchased ?? seatsAssigned;
      const effectiveName = o.name && String(o.name).trim() ? normalizeFetchedLicenseName(s, o.name) : s.name;
      return {
        skuId: s.id,
        service: svc[s.serviceId] || s.serviceId,
        name: effectiveName, // effective (edited) name
        defaultName: s.name, // fetched name
        seatsTotal: seatsPurchased,
        seatsPurchased,
        seatsAssigned,
        seatsAvailable: seatsPurchased != null ? Math.max(seatsPurchased - seatsAssigned, 0) : null,
        billableSeats,
        status: s.status || null,
        renewalDate: s.renewalDate || null,
        defaultPrice: s.unitCostMonthly,
        price: o.price != null && o.price !== "" ? Number(o.price) : s.unitCostMonthly,
        overridden: o.price != null || !!o.name,
        manual: !!s.manual,
      };
    });
    licenses.sort((a, b) => b.price * b.billableSeats - a.price * a.billableSeats); // highest monthly cost first
    res.json({ licenses });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// real users (from connectors) available to assign manual licenses to
app.get("/api/users", async (_req, res) => {
  try {
    const conn = await getConnectorRaw();
    const users = (conn.people || [])
      .filter((p) => !p.synthetic)
      .map((p) => ({ id: p.id, name: p.displayName, email: p.email, dept: p.department, tenant: p.tenant }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- manual licenses CRUD ---
app.get("/api/manual-licenses", (_req, res) => res.json({ manual: loadManual() }));

app.post("/api/manual-licenses", (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: "name is required" });
    const item = {
      id: "manual-" + randomUUID(),
      service: (b.service || "Other").trim(),
      name: b.name.trim(),
      unitCostMonthly: Math.max(0, Number(b.unitCostMonthly) || 0),
      seatsTotal: Math.max(0, Math.floor(Number(b.seatsTotal) || 0)),
      unusedSeats: Math.max(0, Math.floor(Number(b.unusedSeats) || 0)),
      unusedSince: b.unusedSince || null,
      assignedTo: Array.isArray(b.assignedTo) ? [...new Set(b.assignedTo.filter(Boolean))] : [],
    };
    const arr = loadManual();
    arr.push(item);
    saveManual(arr);
    dashCache = null;
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put("/api/manual-licenses/:id", (req, res) => {
  try {
    const b = req.body || {};
    const arr = loadManual();
    const i = arr.findIndex((x) => x.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: "not found" });
    arr[i] = {
      ...arr[i],
      service: (b.service ?? arr[i].service).trim(),
      name: (b.name ?? arr[i].name).trim(),
      unitCostMonthly: Math.max(0, Number(b.unitCostMonthly ?? arr[i].unitCostMonthly) || 0),
      seatsTotal: Math.max(0, Math.floor(Number(b.seatsTotal ?? arr[i].seatsTotal) || 0)),
      unusedSeats: Math.max(0, Math.floor(Number(b.unusedSeats ?? arr[i].unusedSeats) || 0)),
      unusedSince: b.unusedSince ?? arr[i].unusedSince ?? null,
      assignedTo: Array.isArray(b.assignedTo)
        ? [...new Set(b.assignedTo.filter(Boolean))]
        : (arr[i].assignedTo || []),
    };
    saveManual(arr);
    dashCache = null;
    res.json({ ok: true, item: arr[i] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete("/api/manual-licenses/:id", (req, res) => {
  try {
    saveManual(loadManual().filter((x) => x.id !== req.params.id));
    const ov = loadOverrides();
    if (ov[req.params.id]) { delete ov[req.params.id]; saveOverrides(ov); } // drop orphan override
    dashCache = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// save fetched-license overrides { overrides: { skuId: { price?, name? } | number } } and recompute
app.post("/api/prices", (req, res) => {
  try {
    // Reset-all: clear every override.
    if (req.body?.reset) {
      saveOverrides({});
      dashCache = null;
      return res.json({ ok: true, saved: 0 });
    }
    // Otherwise MERGE incoming overrides into the existing ones so editing one
    // license never wipes the others. An empty entry (name & price cleared)
    // removes that license's override, reverting it to the connector default.
    const incoming = req.body?.overrides || {};
    const merged = loadOverrides();
    for (const [id, v] of Object.entries(incoming)) {
      const o = v && typeof v === "object" ? v : { price: v };
      const entry = {};
      if (o.price !== "" && o.price != null) {
        const n = Number(o.price);
        if (!Number.isNaN(n) && n >= 0) entry.price = n;
      }
      if (o.name != null && String(o.name).trim() !== "") entry.name = String(o.name).trim();
      if (Object.keys(entry).length) merged[id] = entry;
      else delete merged[id];
    }
    saveOverrides(merged);
    dashCache = null; // recompute on next read (raw kept, no re-fetch)
    res.json({ ok: true, saved: Object.keys(merged).length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, source: currentSource() }));

// --- connectors: supported catalog + configured instances (secrets masked) ---
app.get("/api/connectors", (_req, res) => {
  res.json({
    source: currentSource(),
    catalog: CONNECTOR_CATALOG.map((c) => ({ id: c.id, label: c.label, fields: c.fields, hint: c.hint || "" })),
    instances: getInstances().map(maskInstance),
  });
});

// data source toggle (mock/live)
app.post("/api/connectors/source", (req, res) => {
  try {
    const cfg = loadConnectors();
    const nextSource = req.body?.source === "live" ? "live" : "mock";
    if (nextSource === "live" && getInstancesFrom(cfg, { configuredOnly: true }).length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Add and save at least one connector before switching to Live.",
        source: currentSource(),
      });
    }
    cfg.dataSource = nextSource;
    const saved = saveConnectors(cfg);
    rawCache = null; dashCache = null;
    res.json({ ok: true, source: saved.dataSource || "mock" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// add a connector instance (optionally several of the same type)
app.post("/api/connectors/instances", (req, res) => {
  try {
    const type = req.body?.type;
    if (!CATALOG_BY_ID[type]) return res.status(400).json({ error: "unknown connector type" });
    const cfg = loadConnectors();
    if (!Array.isArray(cfg.instances)) cfg.instances = [];
    const count = cfg.instances.filter((i) => i.type === type).length;
    const inst = {
      id: randomUUID(),
      type,
      name: `${CATALOG_BY_ID[type].label}${count ? " " + (count + 1) : ""}`,
      config: {},
    };
    cfg.instances.push(inst);
    saveConnectors(cfg);
    res.json({ ok: true, instance: maskInstance(inst) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// update a connector instance (name + config; blank secrets keep existing)
app.put("/api/connectors/instances/:id", (req, res) => {
  try {
    const cfg = loadConnectors();
    const arr = Array.isArray(cfg.instances) ? cfg.instances : [];
    const inst = arr.find((i) => i.id === req.params.id);
    if (!inst) return res.status(404).json({ error: "not found" });

    const b = req.body || {};
    if (typeof b.name === "string") inst.name = b.name.trim();
    const secrets = new Set(secretKeys(inst.type));
    const validKeys = new Set((CATALOG_BY_ID[inst.type]?.fields || []).map((f) => f.key));
    inst.config = inst.config || {};
    for (const [k, v] of Object.entries(b.config || {})) {
      if (!validKeys.has(k)) continue;
      if (secrets.has(k) && String(v ?? "").trim() === "") continue; // keep existing secret on blank
      inst.config[k] = typeof v === "string" ? v.trim() : v;
    }
    saveConnectors(cfg);
    rawCache = null; dashCache = null;
    res.json({ ok: true, instance: maskInstance(inst), source: currentSource() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// remove a connector instance
app.delete("/api/connectors/instances/:id", (req, res) => {
  try {
    const cfg = loadConnectors();
    cfg.instances = (Array.isArray(cfg.instances) ? cfg.instances : []).filter((i) => i.id !== req.params.id);
    saveConnectors(cfg);
    rawCache = null; dashCache = null;
    res.json({ ok: true, source: currentSource() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- scheduled refresh (self-host long runs) ---
// Connector data is cached in memory and otherwise only re-fetched on restart,
// a connector change, or ?refresh=1. A refresh only re-calls the vendor APIs
// (network I/O, no heavy CPU), so running it once a day is cheap.
//
// Default: daily at local 00:00.
//  - REFRESH_DAILY_HOUR (0-23): change the hour of the daily run (default 0).
//  - REFRESH_INTERVAL_HOURS: use a fixed interval instead (e.g. 168 = weekly).
//  - Set REFRESH_INTERVAL_HOURS=0 (or REFRESH_DAILY_HOUR=off) to disable.
const INTERVAL_HOURS = process.env.REFRESH_INTERVAL_HOURS != null
  ? Number(process.env.REFRESH_INTERVAL_HOURS)
  : null;
const DAILY_HOUR = process.env.REFRESH_DAILY_HOUR != null
  ? Number(process.env.REFRESH_DAILY_HOUR)
  : 0;

async function scheduledRefresh() {
  rawCache = null;
  dashCache = null;
  try {
    await getDashboard(); // re-runs connectors and warms the cache
    console.log(`  data refreshed (scheduled) at ${new Date().toISOString()}`);
  } catch (e) {
    console.error(`  scheduled refresh failed: ${String(e.message || e)}`);
  }
}

let refreshLabel;
if (INTERVAL_HOURS != null) {
  // fixed-interval mode (opt-in); 0 disables
  if (Number.isFinite(INTERVAL_HOURS) && INTERVAL_HOURS > 0) {
    setInterval(scheduledRefresh, INTERVAL_HOURS * 60 * 60 * 1000).unref();
    refreshLabel = `every ${INTERVAL_HOURS}h`;
  } else {
    refreshLabel = "disabled";
  }
} else if (Number.isInteger(DAILY_HOUR) && DAILY_HOUR >= 0 && DAILY_HOUR <= 23) {
  // daily at local DAILY_HOUR:00 — self-rescheduling to stay aligned across DST
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(DAILY_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(async () => {
      await scheduledRefresh();
      scheduleNext();
    }, next - now).unref();
  };
  scheduleNext();
  refreshLabel = `daily at ${String(DAILY_HOUR).padStart(2, "0")}:00 (local)`;
} else {
  refreshLabel = "disabled";
}

app.listen(PORT, () => {
  console.log(`\n  Seatscope:  http://localhost:${PORT}   (data: ${currentSource()})`);
  console.log(`  auto-refresh: ${refreshLabel}\n`);
});
