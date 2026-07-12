// GitHub Enterprise seat connector (read-only).
// Detects members who consume a GitHub Enterprise license but are truly inactive.
//
// "Who holds a seat" is easy (org members). "Is this person active" is the hard
// part. We combine TWO signals and take the most recent, because neither alone
// is complete:
//
//   1. Audit log (PRIMARY) — captures real day-to-day work that isn't a
//      "contribution": merging PRs, approving deployments, workflow approvals,
//      repo/team actions, and git pushes (if git-event logging is enabled).
//      This is what catches leads / DevOps / managers who don't author commits.
//      Needs token scope: read:audit_log.
//
//   2. contributionsCollection (SECONDARY) — commits/PRs/issues/reviews, incl.
//      private ones via restrictedContributionsCount. Catches devs whose work
//      is authoring code but who may have no recent audit-log web events.
//
// A member is only "dormant" when BOTH signals are empty.
//
// Requires in .env:
//   GITHUB_ORG               = one or more org logins, comma-separated
//   GITHUB_TOKEN             = org owner token: read:org, read:audit_log
//   GITHUB_ENTERPRISE_SEATS  = true            (opt-in switch)
// Optional:
//   GITHUB_ENTERPRISE_UNIT_COST = monthly price/seat (default 21)

const API = "https://api.github.com";
const GQL = "https://api.github.com/graphql";
const STALE_DAYS = 45;
const WINDOW_DAYS = 180;
const GQL_BATCH = 10;   // users per GraphQL request
const AUDIT_POOL = 6;   // concurrent audit-log lookups

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

async function graphql(query, token) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub GraphQL -> ${res.status} ${res.statusText} ${body.slice(0, 180)}`);
  }
  const j = await res.json().catch(() => ({}));
  if (j.errors) throw new Error("GitHub GraphQL: " + JSON.stringify(j.errors).slice(0, 200));
  // A 200 with neither data nor errors (rate limit, SAML notice, {"message":…})
  // must not silently return undefined — that crashed callers with `data.u0`.
  if (!j.data) throw new Error("GitHub GraphQL: empty response " + JSON.stringify(j).slice(0, 180));
  return j.data;
}

const iso = (d) => d.toISOString();
const day = (d) => d.toISOString().slice(0, 10);
const daysAgoDate = (n) => new Date(Date.now() - n * 86400000);
const daysSince = (dateStr) => Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
// max of "YYYY-MM-DD" strings (lexicographic == chronological for ISO dates)
const maxDay = (...ds) => ds.filter(Boolean).sort().pop() || null;

// PRIMARY: most recent audit-log event per member (their real activity).
async function auditLastByLogin(org, logins, token) {
  const map = {};
  let disabled = false;
  let idx = 0;
  async function worker() {
    while (idx < logins.length && !disabled) {
      const login = logins[idx++];
      try {
        const data = await gh(
          `/orgs/${org}/audit-log?phrase=${encodeURIComponent("actor:" + login)}&include=all&per_page=1&order=desc`,
          token
        );
        if (Array.isArray(data) && data.length > 0) {
          const e = data[0];
          const ts = e["@timestamp"] || (e.created_at ? new Date(e.created_at).getTime() : null);
          if (ts) map[login] = day(new Date(ts));
        }
      } catch (e) {
        if (/-> 40[13]/.test(e.message)) {
          disabled = true; // token lacks read:audit_log, or org has no audit log
          console.warn(`  [github-enterprise] audit log unavailable, using contributions only: ${e.message.slice(0, 90)}`);
        }
        // other errors for a single user are ignored (treated as no audit activity)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(AUDIT_POOL, logins.length) }, worker));
  return { map, disabled };
}

// SECONDARY: contribution activity (commits/PRs/issues/reviews, incl. private).
async function contribLastByLogin(logins, token) {
  const now = new Date();
  const fromYear = iso(daysAgoDate(365));
  const from45 = iso(daysAgoDate(STALE_DAYS));
  const from180 = iso(daysAgoDate(WINDOW_DAYS));
  const nowIso = iso(now);
  const map = {};

  for (let i = 0; i < logins.length; i += GQL_BATCH) {
    const chunk = logins.slice(i, i + GQL_BATCH);
    const parts = chunk.map((login, k) => `
      u${k}: user(login: ${JSON.stringify(login)}) {
        cal: contributionsCollection(from: "${fromYear}", to: "${nowIso}") {
          contributionCalendar { weeks { contributionDays { date contributionCount } } }
        }
        r45: contributionsCollection(from: "${from45}", to: "${nowIso}") { restrictedContributionsCount }
        r180: contributionsCollection(from: "${from180}", to: "${nowIso}") { restrictedContributionsCount }
      }`);
    let data;
    try {
      data = await graphql(`query { ${parts.join("\n")} }`, token);
    } catch (e) {
      console.warn(`  [github-enterprise] contributions batch failed: ${e.message.slice(0, 90)}`);
      continue;
    }
    for (let k = 0; k < chunk.length; k++) {
      const login = chunk[k];
      const u = data[`u${k}`];
      if (!u) { map[login] = null; continue; }
      let latest = null;
      for (const w of u.cal?.contributionCalendar?.weeks || [])
        for (const d of w.contributionDays)
          if (d.contributionCount > 0 && (!latest || d.date > latest)) latest = d.date;
      const r45 = u.r45?.restrictedContributionsCount || 0;
      const r180 = u.r180?.restrictedContributionsCount || 0;
      let last = latest;
      if (r45 > 0 && (!last || daysSince(last) >= STALE_DAYS)) last = day(now);
      else if (r180 > 0 && (!last || daysSince(last) >= WINDOW_DAYS)) last = day(daysAgoDate(60));
      map[login] = last;
    }
  }
  return map;
}

export async function collect(cfg = {}) {
  const org = String(cfg.org ?? process.env.GITHUB_ORG ?? "").trim();
  const token = cfg.token ?? process.env.GITHUB_TOKEN;
  if (!org || !token) throw new Error("GitHub organization and token are required");
  const orgs = [org];

  const unit = Number(cfg.enterpriseUnitCost ?? process.env.GITHUB_ENTERPRISE_UNIT_COST) || 21;
  const services = [{ id: "ghenterprise", name: "GitHub Enterprise", vendor: "GitHub" }];
  const skus = [];
  const people = [];
  const assignments = [];
  const seen = new Set();

  const addPerson = (login, org) => {
    const id = `gh:${login}`;
    if (!seen.has(id)) {
      seen.add(id);
      people.push({ id, displayName: login, email: `${login} (github)`, department: "", tenant: org });
    }
    return id;
  };

  for (const org of orgs) {
    const members = await ghPaged(`/orgs/${org}/members`, token);
    const logins = members.map((m) => m.login);

    // primary + secondary signals, take the most recent of the two
    const { map: auditMap, disabled } = await auditLastByLogin(org, logins, token);
    const contribMap = await contribLastByLogin(logins, token);
    if (disabled) console.warn(`  [github-enterprise] ${org}: audit log off — dormant detection is less accurate for merge/approve-only users.`);

    const skuId = `gh-enterprise-${org}`;
    skus.push({
      id: skuId,
      serviceId: "ghenterprise",
      name: `GitHub Enterprise (${org})`,
      unitCostMonthly: unit,
      seatsTotal: members.length,
      renewalDate: null,
    });

    for (const login of logins) {
      const pid = addPerson(login, org);
      assignments.push({
        personId: pid,
        skuId,
        assignedDate: null,
        lastActivity: maxDay(auditMap[login], contribMap[login]), // null => dormant in both signals
      });
    }
  }

  return { services, skus, people, assignments };
}

export const meta = { id: "github-enterprise", label: "GitHub Enterprise" };
