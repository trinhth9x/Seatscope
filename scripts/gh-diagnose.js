// Diagnostic: reveal every GitHub activity signal we can read for ONE user,
// so we stop guessing why they show as "Never used".
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx node scripts/gh-diagnose.js v-nhantt7 [org]
//
// Reads only. Prints raw numbers from each signal source.

const API = "https://api.github.com";
const GQL = "https://api.github.com/graphql";
const token = process.env.GITHUB_TOKEN;
const login = process.argv[2];
const org = process.argv[3];

if (!token || !login) {
  console.error("Usage: GITHUB_TOKEN=... node scripts/gh-diagnose.js <login> [org]");
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

async function rest(path) {
  const res = await fetch(API + path, { headers: H });
  const body = await res.text();
  if (!res.ok) return { error: `${res.status} ${body.slice(0, 150)}` };
  return JSON.parse(body);
}

async function graphql(query) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await res.json();
  return j;
}

(async () => {
  console.log(`\n=== Diagnosing GitHub user: ${login} ===\n`);

  // 1. contributionsCollection (what the connector uses)
  const now = iso(new Date());
  const q = `query {
    user(login: ${JSON.stringify(login)}) {
      login
      createdAt
      c365: contributionsCollection(from:"${iso(daysAgo(365))}", to:"${now}") {
        hasAnyContributions
        restrictedContributionsCount
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalPullRequestReviewContributions
        contributionCalendar { totalContributions }
      }
      c45: contributionsCollection(from:"${iso(daysAgo(45))}", to:"${now}") {
        restrictedContributionsCount
        contributionCalendar { totalContributions }
      }
    }
  }`;
  const g = await graphql(q);
  if (g.errors) {
    console.log("contributionsCollection ERROR:", JSON.stringify(g.errors).slice(0, 200));
  } else {
    const u = g.data?.user;
    if (!u) {
      console.log("contributionsCollection: user NOT FOUND (renamed/deleted login?)");
    } else {
      console.log("Account created:", u.createdAt);
      console.log("Last 365 days:");
      console.log("  hasAnyContributions:", u.c365.hasAnyContributions);
      console.log("  calendar total (visible):", u.c365.contributionCalendar.totalContributions);
      console.log("  restricted (private, hidden):", u.c365.restrictedContributionsCount);
      console.log("  commits:", u.c365.totalCommitContributions, "| PRs:", u.c365.totalPullRequestContributions,
        "| issues:", u.c365.totalIssueContributions, "| reviews:", u.c365.totalPullRequestReviewContributions);
      console.log("Last 45 days:");
      console.log("  calendar total (visible):", u.c45.contributionCalendar.totalContributions);
      console.log("  restricted (private, hidden):", u.c45.restrictedContributionsCount);
    }
  }

  // 2. Public events (only visible for other users, but may reveal recent pushes)
  console.log("\nRecent public events (GET /users/%s/events/public):", login);
  const ev = await rest(`/users/${login}/events/public?per_page=10`);
  if (ev.error) console.log("  error:", ev.error);
  else if (!Array.isArray(ev) || ev.length === 0) console.log("  (none visible)");
  else ev.slice(0, 5).forEach((e) => console.log(`  ${e.created_at}  ${e.type}  ${e.repo?.name}`));

  // 3. Org audit log for this actor (needs read:audit_log; may include git events)
  if (org) {
    console.log(`\nOrg audit log for actor:${login} (GET /orgs/${org}/audit-log):`);
    const al = await rest(`/orgs/${org}/audit-log?phrase=${encodeURIComponent("actor:" + login)}&include=all&per_page=5&order=desc`);
    if (al.error) console.log("  error (token may lack read:audit_log):", al.error);
    else if (!Array.isArray(al) || al.length === 0) console.log("  (no audit events in retention window)");
    else al.forEach((e) => console.log(`  ${new Date(e["@timestamp"] || e.created_at).toISOString()}  ${e.action}`));
  } else {
    console.log("\n(Pass an org as 3rd arg to also check the audit log.)");
  }

  console.log("\n=== Interpretation ===");
  console.log("If contributions are all 0 but the person works daily, their git commit");
  console.log("email is likely NOT linked to their GitHub account, OR they only push to");
  console.log("non-default branches / do review+browse work that the graph doesn't count.");
  console.log("In that case we must add the audit log (git events) as a second signal.\n");
})();
