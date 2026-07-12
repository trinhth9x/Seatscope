// Turns raw connector data into the datasets the dashboard renders.
// Central place for the "waste" logic.

const STALE_DAYS = 45;

function daysBetween(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr).getTime();
  return Math.floor((Date.now() - then) / 86400000);
}

export function buildDashboard(raw) {
  const { services, skus, people, assignments } = raw;
  const skuById = Object.fromEntries(skus.map((s) => [s.id, s]));
  const svcById = Object.fromEntries(services.map((s) => [s.id, s]));
  const personById = Object.fromEntries(people.map((p) => [p.id, p]));

  const dailyCost = (monthly) => (monthly * 12) / 365; // avg days/month

  // enrich each assignment
  const rows = assignments.map((a) => {
    const sku = skuById[a.skuId];
    if (!sku) return null; // orphan assignment (sku removed)
    const svc = svcById[sku.serviceId];
    const person = personById[a.personId] || {
      displayName: a.personId, email: "", department: "", tenant: "", synthetic: false,
    };
    const idleDays = daysBetween(a.lastActivity);
    let status = "active";
    if (a.lastActivity === null) status = "never";
    else if (idleDays > STALE_DAYS) status = "idle";

    // Money already wasted = (days unused since last use) x daily cost.
    //   idle  -> days since last activity
    //   never -> days since the license was assigned (if we know that date)
    //   active-> 0
    let wastedDays = 0;
    if (status === "idle") wastedDays = idleDays;
    else if (status === "never") wastedDays = a.assignedDate ? daysBetween(a.assignedDate) : null;
    const wastedSoFar = wastedDays == null ? null : round(wastedDays * dailyCost(sku.unitCostMonthly));

    return {
      personId: a.personId,
      personName: person.displayName,
      email: person.email,
      department: person.department,
      tenant: person.tenant,
      service: svc.name,
      serviceId: svc.id,
      sku: sku.name,
      skuId: sku.id,
      costMonthly: sku.unitCostMonthly,
      synthetic: person.synthetic || false,
      lastActivity: a.lastActivity,
      assignedDate: a.assignedDate || null,
      idleDays: idleDays === Infinity ? null : idleDays,
      wastedDays: wastedDays == null ? null : wastedDays,
      wastedSoFar, // cumulative money wasted since last use (null = unknown start date)
      status, // active | idle | never
      wasted: status !== "active",
    };
  }).filter(Boolean);

  const totalMonthlySpend = rows.reduce((s, r) => s + r.costMonthly, 0);
  const wastedRows = rows.filter((r) => r.wasted);
  const wastedMonthlySpend = wastedRows.reduce((s, r) => s + r.costMonthly, 0);

  // spend + waste grouped by service
  const byService = {};
  for (const r of rows) {
    byService[r.service] ??= { service: r.service, spend: 0, waste: 0, seats: 0, wastedSeats: 0 };
    byService[r.service].spend += r.costMonthly;
    byService[r.service].seats += 1;
    if (r.wasted) {
      byService[r.service].waste += r.costMonthly;
      byService[r.service].wastedSeats += 1;
    }
  }
  const spendByService = Object.values(byService).sort((a, b) => b.spend - a.spend);

  // inactive people: haven't logged in / had activity anywhere for a long time.
  // "last seen" = the MOST RECENT activity across all their licenses.
  const perPerson = {};
  for (const r of rows) {
    if (r.synthetic) continue; // manual-license seat-holders aren't real users
    const p = (perPerson[r.personId] ??= {
      personId: r.personId,
      name: r.personName,
      email: r.email,
      dept: r.department,
      tenant: r.tenant,
      anyActive: false,
      lastActivity: null, // most recent activity date across their licenses
      licenses: 0,
      services: new Set(),
      wastedMonthly: 0,
    });
    p.licenses += 1;
    if (r.service) p.services.add(r.service);
    if (r.status === "active") p.anyActive = true;
    if (r.wasted) p.wastedMonthly += r.costMonthly;
    if (r.lastActivity && (!p.lastActivity || r.lastActivity > p.lastActivity)) p.lastActivity = r.lastActivity;
  }
  const rank = (p) => p.daysSinceLastLogin ?? Number.MAX_SAFE_INTEGER; // never-logged-in ranks highest
  const inactivePeople = Object.values(perPerson)
    .filter((p) => !p.anyActive) // no active license anywhere
    .map((p) => ({
      ...p,
      services: [...p.services].sort(),
      daysSinceLastLogin: p.lastActivity ? daysBetween(p.lastActivity) : null, // null => never logged in
      wastedMonthly: round(p.wastedMonthly),
    }))
    .sort((a, b) => b.wastedMonthly - a.wastedMonthly || rank(b) - rank(a)); // most wasted first, then longest-inactive

  // per-user license roll-up: every real user, how many licenses they hold,
  // and the total monthly cost of those licenses.
  const userMap = {};
  for (const r of rows) {
    if (r.synthetic) continue; // manual-license seat-holders aren't real users
    const u = (userMap[r.personId] ??= {
      personId: r.personId,
      name: r.personName,
      email: r.email,
      dept: r.department,
      tenant: r.tenant,
      licenseCount: 0,
      monthlyCost: 0,
      wastedMonthly: 0,
      lastActivity: null,
      licenses: [],
    });
    u.licenseCount += 1;
    u.monthlyCost += r.costMonthly;
    if (r.wasted) u.wastedMonthly += r.costMonthly;
    if (r.lastActivity && (!u.lastActivity || r.lastActivity > u.lastActivity)) u.lastActivity = r.lastActivity;
    u.licenses.push({ service: r.service, sku: r.sku, costMonthly: r.costMonthly, status: r.status });
  }
  const userLicenses = Object.values(userMap)
    .map((u) => ({
      ...u,
      services: [...new Set(u.licenses.map((l) => l.service).filter(Boolean))].sort(),
      monthlyCost: round(u.monthlyCost),
      wastedMonthly: round(u.wastedMonthly),
    }))
    .sort((a, b) => b.wastedMonthly - a.wastedMonthly || b.monthlyCost - a.monthlyCost); // most wasted first, then highest cost

  // upcoming renewals (next 45 days)
  const upcomingRenewals = skus
    .map((s) => ({ ...s, service: svcById[s.serviceId].name, inDays: -daysBetween(s.renewalDate) }))
    .filter((s) => s.inDays >= 0 && s.inDays <= 45)
    .sort((a, b) => a.inDays - b.inDays);

  // cumulative money already wasted (sum of what we can measure)
  const wastedSoFarTotal = wastedRows.reduce((s, r) => s + (r.wastedSoFar || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      totalMonthlySpend: round(totalMonthlySpend),
      wastedMonthlySpend: round(wastedMonthlySpend),
      potentialAnnualSavings: round(wastedMonthlySpend * 12),
      wastedSoFarTotal: round(wastedSoFarTotal),
      wastePct: round((wastedMonthlySpend / totalMonthlySpend) * 100),
      totalPeople: people.length,
      inactivePeople: inactivePeople.length,
      totalSeats: rows.length,
      wastedSeats: wastedRows.length,
    },
    spendByService,
    wasteRows: wastedRows
      .sort((a, b) => (b.wastedSoFar || 0) - (a.wastedSoFar || 0) || (b.costMonthly || 0) - (a.costMonthly || 0)) // most wasted first, then highest monthly cost
      .map((r) => ({
        personName: r.personName,
        email: r.email,
        department: r.department,
        service: r.service,
        sku: r.sku,
        costMonthly: r.costMonthly,
        status: r.status,
        idleDays: r.idleDays,
        lastActivity: r.lastActivity,
        wastedDays: r.wastedDays,
        wastedSoFar: r.wastedSoFar,
      })),
    inactivePeople,
    userLicenses,
    upcomingRenewals,
    allRows: rows,
  };
}

function round(n) { return Math.round(n * 100) / 100; }
