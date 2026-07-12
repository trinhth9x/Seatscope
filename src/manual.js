// Manually-entered licenses (e.g. Odoo, Figma) that have no connector/API.
// The user provides seats + how many are unused; we synthesize the same raw
// shape as connectors so everything (spend, waste, wasted-so-far, charts) flows
// through buildDashboard() unchanged. Synthetic seat-holders are flagged so they
// don't pollute the real "Inactive users" list.

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "misc";
const today = () => new Date().toISOString().slice(0, 10);

// `knownPeople` (real users from connectors) lets us attach real name/email/dept
// when a manual license is assigned to specific users, so their license count &
// cost roll up correctly on the Users page.
export function manualRaw(licenses, knownPeople = []) {
  const known = Object.fromEntries((knownPeople || []).map((p) => [p.id, p]));
  const services = [];
  const svcSeen = new Set();
  const skus = [];
  const people = [];
  const assignments = [];

  for (const l of licenses) {
    const serviceName = l.service || "Other";
    const serviceId = "manual:" + slug(serviceName);
    if (!svcSeen.has(serviceId)) {
      svcSeen.add(serviceId);
      services.push({ id: serviceId, name: serviceName, vendor: serviceName });
    }

    // real users this license is explicitly assigned to (these seats are "in use")
    const assignedIds = Array.isArray(l.assignedTo) ? [...new Set(l.assignedTo.filter(Boolean))] : [];
    const usedByReal = assignedIds.length;

    // total seats can't be fewer than the number of assigned users
    const seats = Math.max(Math.max(0, Math.floor(Number(l.seatsTotal) || 0)), usedByReal);

    // unused (waste) seats: when assigned to real users, every unassigned seat is
    // unused; otherwise fall back to the manually-entered unused count.
    const unused = usedByReal > 0
      ? seats - usedByReal
      : Math.min(seats, Math.max(0, Math.floor(Number(l.unusedSeats) || 0)));
    const usedSynthetic = seats - usedByReal - unused; // legacy "used" seats with no named user

    skus.push({
      id: l.id,
      serviceId,
      name: l.name,
      unitCostMonthly: Number(l.unitCostMonthly) || 0,
      seatsTotal: seats,
      renewalDate: l.renewalDate || null,
      manual: true,
    });

    // 1) named real users — active seats linked to actual people
    for (const pid of assignedIds) {
      const rp = known[pid];
      people.push({
        id: pid,
        displayName: rp?.displayName || pid,
        email: rp?.email || "",
        department: rp?.department || "",
        tenant: rp?.tenant || serviceName,
        synthetic: false, // real user; connector record wins on merge if present
      });
      assignments.push({ personId: pid, skuId: l.id, assignedDate: null, lastActivity: today() });
    }

    // 2) anonymous used seats (legacy manual "used" with no assignment)
    for (let i = 0; i < usedSynthetic; i++) {
      const pid = `${l.id}#used#${i}`;
      people.push({ id: pid, displayName: l.name, email: `${serviceName} (manual)`, department: "", tenant: serviceName, synthetic: true });
      assignments.push({ personId: pid, skuId: l.id, assignedDate: null, lastActivity: today() });
    }

    // 3) unused seats (waste)
    for (let i = 0; i < unused; i++) {
      const pid = `${l.id}#free#${i}`;
      people.push({ id: pid, displayName: l.name, email: `${serviceName} (manual)`, department: "", tenant: serviceName, synthetic: true });
      assignments.push({ personId: pid, skuId: l.id, assignedDate: l.unusedSince || null, lastActivity: null });
    }
  }

  return { services, skus, people, assignments };
}

// merge connector raw + manual raw into one dataset
export function mergeRaw(a, b) {
  const svc = new Map();
  for (const s of [...a.services, ...b.services]) svc.set(s.id, s);
  const ppl = new Map();
  for (const p of [...a.people, ...b.people]) if (!ppl.has(p.id)) ppl.set(p.id, p);
  return {
    services: [...svc.values()],
    skus: [...a.skus, ...b.skus],
    people: [...ppl.values()],
    assignments: [...a.assignments, ...b.assignments],
  };
}
