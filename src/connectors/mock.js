// Mock connector — produces realistic sample data so the portal is fully
// viewable before real credentials are provided. Real connectors (microsoft365,
// github, azuredevops) implement the same shape: async collect() -> RawData.
//
// RawData = {
//   services:    [{ id, name, vendor }]
//   skus:        [{ id, serviceId, name, unitCostMonthly, seatsTotal, renewalDate }]
//   people:      [{ id, displayName, email, department, tenant }]
//   assignments: [{ personId, skuId, assignedDate, lastActivity|null }]
// }

// tiny seeded RNG so numbers are stable between reloads
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const services = [
  { id: "m365", name: "Microsoft 365", vendor: "Microsoft" },
  { id: "powerbi", name: "Power BI", vendor: "Microsoft" },
  { id: "azdo", name: "Azure DevOps", vendor: "Microsoft" },
  { id: "ghe", name: "GitHub Enterprise", vendor: "GitHub" },
  { id: "copilot", name: "GitHub Copilot", vendor: "GitHub" },
  { id: "slack", name: "Slack", vendor: "Salesforce" },
  { id: "zoom", name: "Zoom", vendor: "Zoom" },
  { id: "jetbrains", name: "JetBrains", vendor: "JetBrains" },
  { id: "adobe", name: "Adobe CC", vendor: "Adobe" },
];

const skus = [
  { id: "m365-e5", serviceId: "m365", name: "Microsoft 365 E5", unitCostMonthly: 57, seatsTotal: 30, renewalDate: daysAgo(-24) },
  { id: "m365-e3", serviceId: "m365", name: "Microsoft 365 E3", unitCostMonthly: 36, seatsTotal: 25, renewalDate: daysAgo(-51) },
  { id: "pbi-pro", serviceId: "powerbi", name: "Power BI Pro", unitCostMonthly: 10, seatsTotal: 20, renewalDate: daysAgo(-12) },
  { id: "azdo-basic", serviceId: "azdo", name: "Azure DevOps Basic", unitCostMonthly: 6, seatsTotal: 25, renewalDate: daysAgo(-88) },
  { id: "ghe-seat", serviceId: "ghe", name: "GitHub Enterprise", unitCostMonthly: 21, seatsTotal: 30, renewalDate: daysAgo(-9) },
  { id: "copilot-biz", serviceId: "copilot", name: "Copilot Business", unitCostMonthly: 19, seatsTotal: 25, renewalDate: daysAgo(-40) },
  { id: "slack-pro", serviceId: "slack", name: "Slack Pro", unitCostMonthly: 8.75, seatsTotal: 40, renewalDate: daysAgo(-33) },
  { id: "zoom-pro", serviceId: "zoom", name: "Zoom Pro", unitCostMonthly: 14, seatsTotal: 15, renewalDate: daysAgo(-19) },
  { id: "jb-all", serviceId: "jetbrains", name: "JetBrains All Products", unitCostMonthly: 25, seatsTotal: 15, renewalDate: daysAgo(-62) },
  { id: "adobe-cc", serviceId: "adobe", name: "Adobe Creative Cloud", unitCostMonthly: 55, seatsTotal: 8, renewalDate: daysAgo(-27) },
];

const departments = ["Engineering", "Data", "Product", "Design", "Marketing", "Sales", "Finance", "HR", "IT"];
const firstNames = ["An", "Bình", "Chi", "Dũng", "Hà", "Hoa", "Khoa", "Lan", "Minh", "Nam", "Ngọc", "Phúc", "Quân", "Sơn", "Trang", "Tú", "Vy", "Yến", "Bảo", "Linh"];
const lastNames = ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Vũ", "Đặng", "Bùi", "Đỗ", "Hồ"];

function buildPeople(n) {
  const people = [];
  for (let i = 0; i < n; i++) {
    const fn = firstNames[i % firstNames.length];
    const ln = pick(lastNames);
    const name = `${ln} ${fn}`;
    people.push({
      id: `u${i + 1}`,
      displayName: name,
      email: `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@contoso.com`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d"),
      department: pick(departments),
      tenant: rand() < 0.15 ? "contoso-eu" : "contoso-main",
    });
  }
  return people;
}

function buildAssignments(people) {
  const assignments = [];
  const devSkus = ["ghe-seat", "copilot-biz", "azdo-basic", "jb-all"];
  const allSkus = skus.map((s) => s.id);
  for (const p of people) {
    const isDev = ["Engineering", "Data", "Product"].includes(p.department);
    // everyone gets an M365 license
    assignments.push(mkAssign(p.id, rand() < 0.6 ? "m365-e5" : "m365-e3"));
    // devs get dev tools (some unused)
    if (isDev) {
      for (const sku of devSkus) if (rand() < 0.7) assignments.push(mkAssign(p.id, sku));
    }
    // random extras
    for (const sku of allSkus) {
      if (["m365-e5", "m365-e3", ...devSkus].includes(sku)) continue;
      if (rand() < 0.4) assignments.push(mkAssign(p.id, sku));
    }
  }
  return assignments;
}

function mkAssign(personId, skuId) {
  const r = rand();
  let lastActivity;
  if (r < 0.18) lastActivity = null;               // never used
  else if (r < 0.38) lastActivity = daysAgo(60 + Math.floor(rand() * 200)); // stale
  else lastActivity = daysAgo(Math.floor(rand() * 25)); // active
  return { personId, skuId, assignedDate: daysAgo(120 + Math.floor(rand() * 400)), lastActivity };
}

export async function collect() {
  const people = buildPeople(46);
  const assignments = buildAssignments(people);
  return { services, skus, people, assignments };
}

export const meta = { id: "mock", label: "Sample data" };
