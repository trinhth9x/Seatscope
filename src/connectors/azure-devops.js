// Azure DevOps connector (read-only).
// Pulls user entitlements (license assignments) and each user's last access date,
// so paid Basic / Basic+Test-Plans seats that nobody uses show up as waste.
//
// "Who holds a license" = the accessLevel on each user entitlement.
// "Is it used" = lastAccessedDate. Azure DevOps returns "0001-01-01T..." when a
// user has never accessed the org, which we treat as never used.
//
// Requires in .env (or via the Connectors page):
//   AZURE_DEVOPS_ORG    = organization name (dev.azure.com/<org>)
//   AZURE_DEVOPS_TOKEN  = PAT with "Member Entitlement Management (Read)"
//                         scope: vso.memberentitlementmanagement
//
// Prices are Microsoft list defaults; override per-license on the License types page.
//   Basic $6/user/mo (first 5 free), Basic + Test Plans $52, Stakeholder free,
//   Visual Studio subscription seats are $0 to the org (paid via the VS sub).

const API_VERSION = "7.1-preview.3";

// accountLicenseType -> { display name, default monthly cost }
const TIERS = {
  express: { name: "Basic", cost: 6 },
  advanced: { name: "Basic + Test Plans", cost: 52 },
  stakeholder: { name: "Stakeholder", cost: 0 },
  professional: { name: "Visual Studio", cost: 0 },
  none: { name: "None", cost: 0 },
};

const tierOf = (t) => TIERS[t] || { name: t || "Unknown", cost: 0 };

// Accept "myorg", "https://dev.azure.com/myorg", "dev.azure.com/myorg",
// or the legacy "myorg.visualstudio.com" and reduce it to just "myorg".
function normalizeOrg(raw) {
  let s = (raw || "").trim();
  s = s.replace(/^https?:\/\//i, "");                 // strip protocol
  const legacy = s.match(/^([^.\/]+)\.visualstudio\.com/i);
  if (legacy) return legacy[1];
  s = s.replace(/^(?:vsaex\.)?dev\.azure\.com\//i, ""); // strip host
  s = s.split("/")[0];                                 // keep first path segment only
  return s;
}

// Azure DevOps returns 0001-01-01 for "never accessed"
function lastAccess(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime()) || d.getFullYear() <= 1) return null;
  return dateStr.slice(0, 10);
}

async function adoEntitlements(org, token) {
  const auth = Buffer.from(":" + token).toString("base64");
  const out = [];
  let cont = "";
  for (let guard = 0; guard < 200; guard++) {
    const url =
      `https://vsaex.dev.azure.com/${encodeURIComponent(org)}/_apis/userentitlements` +
      `?api-version=${API_VERSION}` + (cont ? `&continuationToken=${encodeURIComponent(cont)}` : "");
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let hint = "";
      if (res.status === 401)
        hint = " — check the PAT: it must belong to org '" + org + "' (or 'All accessible organizations'), " +
          "have the 'Member Entitlement Management (Read)' scope (this API returns 401 when that scope is missing), and not be expired.";
      throw new Error(`Azure DevOps userentitlements -> ${res.status} ${res.statusText}${hint} ${body.slice(0, 160)}`);
    }
    const data = await res.json();
    const items = data.members || data.value || data.items || [];
    out.push(...items);
    cont = data.continuationToken || "";
    if (!cont || items.length === 0) break;
  }
  return out;
}

export async function collect(cfg = {}) {
  const org = normalizeOrg(cfg.org ?? process.env.AZURE_DEVOPS_ORG);
  const token = cfg.token ?? process.env.AZURE_DEVOPS_TOKEN;
  if (!org || !token) throw new Error("Azure DevOps organization and token are required");

  const entitlements = await adoEntitlements(org, token);

  const services = [{ id: "azuredevops", name: "Azure DevOps", vendor: "Microsoft" }];
  const skuMap = new Map();
  const people = [];
  const assignments = [];
  const seen = new Set();

  for (const e of entitlements) {
    const al = e.accessLevel || {};
    const type = al.accountLicenseType || "none";
    if (type === "none") continue; // no license consumed

    const tier = tierOf(type);
    const skuId = `ado-${org}-${type}`;
    if (!skuMap.has(skuId)) {
      skuMap.set(skuId, {
        id: skuId,
        serviceId: "azuredevops",
        name: `Azure DevOps ${al.licenseDisplayName || tier.name} (${org})`,
        unitCostMonthly: tier.cost,
        seatsTotal: 0,
        renewalDate: null,
      });
    }
    skuMap.get(skuId).seatsTotal++;

    const user = e.user || {};
    const email = user.mailAddress || user.principalName || user.displayName || e.id;
    const pid = `ado:${e.id || email}`;
    if (!seen.has(pid)) {
      seen.add(pid);
      people.push({ id: pid, displayName: user.displayName || email, email, department: "", tenant: org });
    }
    assignments.push({
      personId: pid,
      skuId,
      assignedDate: e.dateCreated ? String(e.dateCreated).slice(0, 10) : null,
      lastActivity: lastAccess(e.lastAccessedDate),
    });
  }

  return { services, skus: [...skuMap.values()], people, assignments };
}

export const meta = { id: "azure-devops", label: "Azure DevOps" };
