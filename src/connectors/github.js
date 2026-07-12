// GitHub connector (read-only).
// Proves value fastest: the Copilot billing API returns EXACT last_activity_at
// per seat, so "paid Copilot seat, never used" is measured, not guessed.
//
// Requires in .env:
//   GITHUB_ORG    = one or more org logins, comma-separated (e.g. org-a,org-b).
//                   Handles multiple orgs under one enterprise. Copilot is billed
//                   per org, so each org's seats are counted separately — and a
//                   person holding a seat in BOTH orgs shows up as double-billed.
//   GITHUB_TOKEN  = enterprise/org owner token. Scopes (classic): read:org,
//                   manage_billing:copilot (fine-grained PAT: org "Copilot Business" = Read)
// Optional:
//   GITHUB_COPILOT_UNIT_COST  = monthly price per seat (default 19 Business / 39 Enterprise)

const API = "https://api.github.com";

async function gh(path, token) {
  const res = await fetch(API + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 180)}`);
  }
  return res.json();
}

async function ghPaged(path, token, key) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await gh(`${path}${sep}per_page=100&page=${page}`, token);
    const items = key ? data[key] : data;
    if (!items || items.length === 0) break;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

export async function collect(cfg = {}) {
  const org = String(cfg.org ?? process.env.GITHUB_ORG ?? "").trim();
  const token = cfg.token ?? process.env.GITHUB_TOKEN;
  if (!org || !token) throw new Error("GitHub organization and token are required");
  const orgs = [org];

  const services = [{ id: "ghcopilot", name: "GitHub Copilot", vendor: "GitHub" }];
  const skus = [];
  const people = [];
  const assignments = [];
  const seen = new Set();

  const addPerson = (login, name, org) => {
    const id = `gh:${login}`;
    if (!seen.has(id)) {
      seen.add(id);
      people.push({ id, displayName: name || login, email: `${login} (github)`, department: "", tenant: org });
    }
    return id;
  };

  const override = Number(cfg.copilotUnitCost ?? process.env.GITHUB_COPILOT_UNIT_COST) || 0;

  for (const org of orgs) {
    // Copilot plan price (no exact negotiated price via API — use override or plan default)
    let unit = override;
    if (!unit) {
      try {
        const billing = await gh(`/orgs/${org}/copilot/billing`, token);
        unit = billing?.plan_type === "enterprise" ? 39 : 19;
      } catch {
        unit = 19;
      }
    }

    // Exact per-seat usage, per org (each org billed separately)
    const seats = await ghPaged(`/orgs/${org}/copilot/billing/seats`, token, "seats");
    const skuId = `gh-copilot-${org}`;
    skus.push({
      id: skuId,
      serviceId: "ghcopilot",
      name: `GitHub Copilot (${org})`,
      unitCostMonthly: unit,
      seatsTotal: seats.length,
      renewalDate: null,
    });

    for (const s of seats) {
      const login = s.assignee?.login;
      if (!login) continue;
      const pid = addPerson(login, s.assignee?.name, org);
      assignments.push({
        personId: pid,
        skuId,
        assignedDate: s.created_at ? s.created_at.slice(0, 10) : null,
        lastActivity: s.last_activity_at ? s.last_activity_at.slice(0, 10) : null, // null => never used
      });
    }
  }

  return { services, skus, people, assignments };
}

export const meta = { id: "github", label: "GitHub" };
