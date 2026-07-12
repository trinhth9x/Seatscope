// Live aggregation. Runs every configured connector *instance* and merges their
// output into one dataset (same shape as mock.js). Multiple instances of the same
// type are supported (e.g. two GitHub orgs, two M365 tenants); each instance's
// ids are namespaced so they never collide.

const MODULES = {
  github: () => import("./github.js"),
  m365: () => import("./m365.js"),
  "azure-devops": () => import("./azure-devops.js"),
  jira: () => import("./jira.js"),
};

// merge two raw datasets from the SAME instance (dedupe people by id)
function mergeSame(a, b) {
  const people = [...a.people];
  const seen = new Set(a.people.map((p) => p.id));
  for (const p of b.people) if (!seen.has(p.id)) { seen.add(p.id); people.push(p); }
  return {
    services: [...a.services, ...b.services],
    skus: [...a.skus, ...b.skus],
    people,
    assignments: [...a.assignments, ...b.assignments],
  };
}

// namespace all instance-local ids so different instances never collide.
// serviceId is intentionally left un-prefixed so licenses group by vendor.
function namespace(raw, prefix) {
  const rid = (id) => `${prefix}::${id}`;
  return {
    services: raw.services,
    skus: raw.skus.map((s) => ({ ...s, id: rid(s.id) })),
    people: raw.people.map((p) => ({ ...p, id: rid(p.id) })),
    assignments: raw.assignments.map((a) => ({ ...a, personId: rid(a.personId), skuId: rid(a.skuId) })),
  };
}

async function collectInstance(inst) {
  const cfg = inst.config || {};
  if (inst.type === "github") {
    const gh = await (MODULES.github());
    let raw = await gh.collect(cfg);
    if (cfg.enterpriseSeats) {
      const ent = await import("./github-enterprise.js");
      raw = mergeSame(raw, await ent.collect(cfg));
    }
    return raw;
  }
  const load = MODULES[inst.type];
  if (!load) throw new Error(`unknown connector type: ${inst.type}`);
  const mod = await load();
  return mod.collect(cfg);
}

// GitHub bills ONE license per unique user across the whole enterprise, no matter
// how many orgs they belong to. With several GitHub connectors (one per org), the
// same person would otherwise be counted once per org. Collapse GitHub Copilot &
// Enterprise seats to one seat per unique login (keeping the most recent activity),
// so seat counts and cost match GitHub's actual billing.
const GITHUB_DEDUP_SERVICES = new Set(["ghcopilot", "ghenterprise"]);

function dedupeGithubSeats(raw) {
  const svcOfSku = Object.fromEntries(raw.skus.map((s) => [s.id, s.serviceId]));
  const loginOf = (pid) => {
    const i = pid.indexOf("::gh:"); // namespaced person id: `${instanceId}::gh:${login}`
    return i === -1 ? null : pid.slice(i + 5);
  };

  const kept = {}; // `${serviceId}\u0000${login}` -> the assignment we keep
  const assignments = [];
  let dropped = 0;
  for (const a of raw.assignments) {
    const svc = svcOfSku[a.skuId];
    const login = loginOf(a.personId);
    if (!GITHUB_DEDUP_SERVICES.has(svc) || !login) { assignments.push(a); continue; }
    const key = svc + "\u0000" + login;
    const prev = kept[key];
    if (!prev) { kept[key] = a; assignments.push(a); continue; }
    // same user already holds this GitHub license via another org — merge activity, drop the extra seat
    if (a.lastActivity && (!prev.lastActivity || a.lastActivity > prev.lastActivity)) prev.lastActivity = a.lastActivity;
    dropped++;
  }
  if (dropped) console.log(`  github dedup: collapsed ${dropped} duplicate GitHub seat(s) for users in multiple orgs`);
  return { ...raw, assignments };
}

export async function collect(instances = []) {
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new Error(
      "No connectors configured. Add a connector on the Connectors page (fastest: GitHub org + token), then set the data source to Live."
    );
  }

  const merged = { services: [], skus: [], people: [], assignments: [] };
  const svcSeen = new Set();
  const errors = [];

  for (const inst of instances) {
    const label = inst.name || inst.type;
    try {
      const raw = namespace(await collectInstance(inst), inst.id);
      for (const s of raw.services) if (!svcSeen.has(s.id)) { svcSeen.add(s.id); merged.services.push(s); }
      merged.skus.push(...raw.skus);
      merged.assignments.push(...raw.assignments);
      merged.people.push(...raw.people);
      console.log(`  connector ${label}: ${raw.people.length} people, ${raw.assignments.length} assignments`);
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      console.error(`  connector ${label} FAILED: ${e.message}`);
    }
  }

  if (merged.assignments.length === 0) {
    throw new Error("All live connectors failed: " + errors.join(" | "));
  }
  return dedupeGithubSeats(merged);
}

export const meta = { id: "live", label: "Live connectors" };
