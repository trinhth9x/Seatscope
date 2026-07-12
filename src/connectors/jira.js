// Jira / Atlassian connector (read-only).
// Uses the Atlassian Organizations admin API, whose directory/users endpoint
// returns each user's product_access with a per-product `last_active` date — so
// we can tell which paid Jira seats are actually unused (not just "assigned").
//
// Requires in .env (or via the Connectors page):
//   JIRA_ORG_ID          = Atlassian organization id (admin.atlassian.com)
//   JIRA_ADMIN_API_KEY   = org admin API key (Bearer)
// Optional:
//   JIRA_UNIT_COST       = monthly price/seat (default 8; override per-license in UI)

const STALE_DAYS = 45;

function lastActive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime()) || d.getFullYear() <= 1) return null;
  return dateStr.slice(0, 10);
}
const isJira = (p) =>
  /jira/i.test(p?.key || "") || /jira/i.test(p?.name || "") || /jira/i.test(p?.product_url || "");

async function adminGet(url, key) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira admin ${url.replace(/\?.*/, "")} -> ${res.status} ${res.statusText} ${body.slice(0, 180)}`);
  }
  return res.json();
}

export async function collect(cfg = {}) {
  const orgId = String(cfg.orgId ?? process.env.JIRA_ORG_ID ?? "").trim();
  const key = cfg.apiKey ?? process.env.JIRA_ADMIN_API_KEY;
  if (!orgId || !key) throw new Error("Jira organization ID and admin API key are required");

  const unit = Number(cfg.unitCost ?? process.env.JIRA_UNIT_COST) || 8;
  const base = `https://api.atlassian.com/admin/v1/orgs/${encodeURIComponent(orgId)}/directory/users`;

  // paged via links.next (full URLs)
  const users = [];
  let url = base;
  for (let guard = 0; guard < 500; guard++) {
    const data = await adminGet(url, key);
    users.push(...(data.data || []));
    const next = data.links?.next;
    if (!next) break;
    url = next;
  }

  const services = [{ id: "jira", name: "Jira (Atlassian)", vendor: "Atlassian" }];
  const skuMap = new Map();
  const people = [];
  const assignments = [];
  const seen = new Set();

  for (const u of users) {
    if (u.account_status && u.account_status !== "active") continue; // deactivated/closed = no billable seat
    const jiraProducts = (u.product_access || []).filter(isJira);
    if (jiraProducts.length === 0) continue;

    const email = u.email || u.name || u.account_id;
    const pid = `jira:${u.account_id || email}`;
    if (!seen.has(pid)) {
      seen.add(pid);
      people.push({ id: pid, displayName: u.name || email, email, department: "", tenant: "Atlassian" });
    }

    for (const p of jiraProducts) {
      const productName = p.name || p.key || "Jira";
      const skuId = `jira-${orgId}-${(p.key || productName).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      if (!skuMap.has(skuId)) {
        skuMap.set(skuId, {
          id: skuId,
          serviceId: "jira",
          name: `${productName}`,
          unitCostMonthly: unit,
          seatsTotal: 0,
          renewalDate: null,
        });
      }
      skuMap.get(skuId).seatsTotal++;
      assignments.push({
        personId: pid,
        skuId,
        assignedDate: null,
        lastActivity: lastActive(p.last_active),
      });
    }
  }

  return { services, skus: [...skuMap.values()], people, assignments };
}

export const meta = { id: "jira", label: "Jira (Atlassian)" };
