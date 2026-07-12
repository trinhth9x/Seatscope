// Microsoft 365 / Entra connector (read-only) via Microsoft Graph.
// App-only (client credentials). Where the biggest license waste usually hides:
// users holding E5/E3/Power BI/Copilot seats who haven't signed in for weeks.
//
// Requires in .env:
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
// Entra app (Application permissions, admin-consented, all read-only):
//   Organization.Read.All   -> subscribedSkus (license inventory + seat counts)
//   User.Read.All           -> users + assignedLicenses + department
//   AuditLog.Read.All       -> signInActivity.lastSignInDateTime  (needs Entra ID P1)
//
// Graph has NO price API. Edit PRICE_MAP with your negotiated monthly price per
// SKU (by skuPartNumber). Unknown SKUs default to 0 (shown, not counted as spend).

const AUTH = (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`;
const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";

// Common friendly names + default monthly USD prices. Adjust to your contract.
const SKU = {
  SPE_E5:            { name: "Microsoft 365 E5", price: 57 },
  SPE_E3:            { name: "Microsoft 365 E3", price: 36 },
  ENTERPRISEPACK:    { name: "Office 365 E3", price: 23 },
  ENTERPRISEPREMIUM: { name: "Office 365 E5", price: 38 },
  SPB:               { name: "Microsoft 365 Business Premium", price: 22 },
  O365_BUSINESS_PREMIUM: { name: "Microsoft 365 Business Standard", price: 12.5 },
  POWER_BI_PRO:      { name: "Power BI Pro", price: 10 },
  PBI_PREMIUM_PER_USER: { name: "Power BI Premium Per User", price: 20 },
  Microsoft_365_Copilot: { name: "Microsoft 365 Copilot", price: 30 },
  FLOW_FREE:         { name: "Power Automate Free", price: 0 },
  POWER_BI_STANDARD: { name: "Power BI (free)", price: 0 },
  // Windows subscription licenses (per-user) — appear here when licensed via M365/Entra
  WIN10_VDA_E3:      { name: "Windows 10/11 Enterprise E3", price: 7 },
  WIN10_VDA_E5:      { name: "Windows 10/11 Enterprise E5", price: 10 },
  WINDOWS_STORE:     { name: "Windows Store", price: 0 },
  Windows_365_Business_2_vCPU_4_GB_128_GB: { name: "Windows 365 Business", price: 41 },
  CPC_E_2C_4GB_128GB: { name: "Windows 365 Enterprise 2vCPU/4GB", price: 41 },
};

function humanizeSkuName(name) {
  return String(name || "").replace(/_/g, " ").trim();
}

// most recent of several ISO datetime strings (ignoring null/undefined)
function maxDate(...vals) {
  let best = null;
  for (const v of vals) {
    if (!v) continue;
    if (!best || new Date(v).getTime() > new Date(best).getTime()) best = v;
  }
  return best;
}

function sumUnits(units = {}) {
  return [units.enabled, units.warning, units.suspended, units.lockedOut]
    .reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
}

function subscriptionStatus(statuses = new Set(), fallback = null) {
  if (statuses.has("Enabled") || statuses.has("Warning")) return "Active";
  if (statuses.has("Suspended") || statuses.has("LockedOut")) return "Disabled";
  if (statuses.has("Deleted")) return "Deleted";
  if (fallback === "Enabled" || fallback === "Warning") return "Active";
  if (fallback === "Suspended" || fallback === "LockedOut") return "Disabled";
  return fallback;
}

async function token(cfg) {
  const t = cfg.tenantId;
  const res = await fetch(AUTH(t), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Entra token error: ${j.error} ${j.error_description?.slice(0, 160)}`);
  return j.access_token;
}

async function graphAll(path, tok) {
  const out = [];
  let url = GRAPH + path;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`Graph ${path} -> ${res.status}: ${j.error?.message?.slice(0, 180)}`);
    out.push(...(j.value || []));
    url = j["@odata.nextLink"] || null;
  }
  return out;
}

// Fallback last sign-in from the raw sign-in logs, by userId (reliable — the
// aggregated signInActivity property is missing/lagging for some users, and a
// userPrincipalName filter does NOT always match). Best-effort: returns null on
// any error (e.g. tenant without Entra ID P1, throttling, or no logs in range).
async function lastSignInFromLogs(userId, tok) {
  const filter = `userId eq '${userId}' and (signInEventTypes/any(t: t eq 'interactiveUser') or signInEventTypes/any(t: t eq 'nonInteractiveUser'))`;
  const url = `${GRAPH_BETA}/auditLogs/signIns?$filter=${encodeURIComponent(filter)}&$top=1&$orderby=${encodeURIComponent("createdDateTime desc")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) return null;
  const j = await res.json();
  return j.value?.[0]?.createdDateTime || null;
}

// run an async fn over items with a bounded concurrency pool
async function pooled(items, size, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await fn(items[idx]); }
    })
  );
}

export async function collect(cfg = {}) {
  const conf = {
    tenantId: cfg.tenantId ?? process.env.MS_TENANT_ID,
    clientId: cfg.clientId ?? process.env.MS_CLIENT_ID,
    clientSecret: cfg.clientSecret ?? process.env.MS_CLIENT_SECRET,
  };
  if (!conf.tenantId || !conf.clientId || !conf.clientSecret)
    throw new Error("Microsoft 365 tenant ID, client ID and client secret are required");
  const tok = await token(conf);

  const services = [{ id: "m365", name: "Microsoft 365", vendor: "Microsoft" }];
  const skus = [];
  const skuBySkuId = {};

  const subs = await graphAll("/subscribedSkus", tok);
  let dirSubs = [];
  try {
    dirSubs = await graphAll("/directory/subscriptions", tok);
  } catch (e) {
    console.warn(`  [m365] directory subscriptions unavailable, renewal metadata skipped: ${e.message.slice(0, 120)}`);
  }
  const dirMetaBySkuId = {};
  for (const s of dirSubs) {
    const meta = (dirMetaBySkuId[s.skuId] ??= { totalLicenses: 0, statuses: new Set(), nextLifecycleDateTime: null });
    meta.totalLicenses += Math.max(0, Number(s.totalLicenses) || 0);
    if (s.status) meta.statuses.add(s.status);
    if (s.nextLifecycleDateTime && (!meta.nextLifecycleDateTime || s.nextLifecycleDateTime > meta.nextLifecycleDateTime)) {
      meta.nextLifecycleDateTime = s.nextLifecycleDateTime;
    }
  }
  for (const s of subs) {
    const subMeta = dirMetaBySkuId[s.skuId];
    const productMeta = SKU[s.skuPartNumber] || { name: humanizeSkuName(s.skuPartNumber), price: 0 };
    const sku = {
      id: s.skuId,
      serviceId: "m365",
      name: productMeta.name,
      unitCostMonthly: productMeta.price,
      seatsTotal: subMeta?.totalLicenses || sumUnits(s.prepaidUnits) || null,
      renewalDate: subMeta?.nextLifecycleDateTime ? subMeta.nextLifecycleDateTime.slice(0, 10) : null,
      status: subscriptionStatus(subMeta?.statuses, s.capabilityStatus),
    };
    skus.push(sku);
    skuBySkuId[s.skuId] = sku;
  }

  const people = [];
  const assignments = [];
  const users = await graphAll(
    "/users?$select=id,displayName,userPrincipalName,department,accountEnabled,assignedLicenses,signInActivity&$top=999",
    tok
  );

  const fallbackNeeded = []; // users licensed but missing aggregated signInActivity
  for (const u of users) {
    if (!u.assignedLicenses || u.assignedLicenses.length === 0) continue;
    // A license is "in use" if there is ANY sign-in: interactive OR non-interactive
    // (background clients, token refresh) OR the last successful sign-in.
    const sa = u.signInActivity || {};
    const last = maxDate(
      sa.lastSignInDateTime,
      sa.lastNonInteractiveSignInDateTime,
      sa.lastSuccessfulSignInDateTime
    );
    people.push({
      id: `m365:${u.id}`,
      displayName: u.displayName || u.userPrincipalName,
      email: u.userPrincipalName,
      department: u.department || "",
      tenant: conf.tenantId,
    });
    const userAssignments = [];
    for (const lic of u.assignedLicenses) {
      if (!skuBySkuId[lic.skuId]) continue; // ignore SKUs not in subscribedSkus
      const a = {
        personId: `m365:${u.id}`,
        skuId: lic.skuId,
        assignedDate: null,
        lastActivity: last ? last.slice(0, 10) : null, // null => never signed in
      };
      assignments.push(a);
      userAssignments.push(a);
    }
    // Aggregated signInActivity is missing/lagging for some users; fall back to
    // the raw sign-in logs so real activity isn't shown as "Never".
    if (!last && userAssignments.length) fallbackNeeded.push({ id: u.id, userAssignments });
  }

  if (fallbackNeeded.length) {
    await pooled(fallbackNeeded, 5, async ({ id, userAssignments }) => {
      const ts = await lastSignInFromLogs(id, tok);
      if (ts) for (const a of userAssignments) a.lastActivity = ts.slice(0, 10);
    });
  }

  return { services, skus, people, assignments };
}

export const meta = { id: "m365", label: "Microsoft 365" };
