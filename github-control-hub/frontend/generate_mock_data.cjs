const fs = require('fs');

const file = 'src/api/mock.ts';
let content = fs.readFileSync(file, 'utf8');

// Generate 1000 repos
const repos = [];
for (let i = 1; i <= 1000; i++) {
  repos.push(`  {
    name: "repo-${i}",
    full_name: "acme-org/repo-${i}",
    private: ${i % 3 === 0},
    default_branch: "main",
    description: "Auto-generated mock repo ${i}",
    language: ["TypeScript", "Go", "Python", "Rust", "Java"][${i % 5}],
    updated_at: "2026-03-08T18:30:00Z",
  }`);
}
const reposStr = repos.join(',\n');

// Replace MOCK_REPOS array contents partially
const startStr = 'const MOCK_REPOS: Repo[] = [';
const endStr = '];\n\nconst MOCK_BRANCHES';
const startIdx = content.indexOf(startStr);
const endIdx = content.indexOf(endStr);
if (startIdx !== -1 && endIdx !== -1) {
  content = content.slice(0, startIdx + startStr.length) + '\n' + reposStr + '\n' + content.slice(endIdx);
}

// Generate 1000 dependabot alerts
const deps = [];
for (let i = 1; i <= 1000; i++) {
  const isClean = i % 4 === 0;
  const isDisabled = i % 7 === 0;
  let severity = "low";
  if (i % 2 === 0) severity = "medium";
  if (i % 3 === 0) severity = "high";
  if (i % 5 === 0) severity = "critical";
  
  if (isClean) {
    deps.push(`  { id: "d${i}", repo: "repo-${i}", package: "", severity: "low", vulnerableVersion: "", patchedVersion: "", createdAt: "", clean: true }`);
  } else if (isDisabled) {
    deps.push(`  { id: "d${i}", repo: "repo-${i}", package: "", severity: "low", vulnerableVersion: "", patchedVersion: "", createdAt: "", disabled: true }`);
  } else {
    deps.push(`  { id: "d${i}", repo: "repo-${i}", package: "lib-${i}", severity: "${severity}", vulnerableVersion: "1.0.0", patchedVersion: "1.0.1", createdAt: "2026-03-01T00:00:00Z" }`);
  }
}
const depsStr = deps.join(',\n');

const depsStartStr = 'let mockDependencyAlerts: DependencyAlert[] = [';
const depsEndStr = '];\n\nexport async function mockFetchDependencies';
const depsStartIdx = content.indexOf(depsStartStr);
const depsEndIdx = content.indexOf(depsEndStr);
if (depsStartIdx !== -1 && depsEndIdx !== -1) {
  content = content.slice(0, depsStartIdx + depsStartStr.length) + '\n' + depsStr + '\n' + content.slice(depsEndIdx);
}

// Generate 1000 blast radius rankings
const blasts = [];
for (let i = 1; i <= 1000; i++) {
  const score = Math.floor(Math.random() * 40);
  let risk = "LOW";
  if (score > 30) risk = "CRITICAL";
  else if (score > 15) risk = "HIGH";
  else if (score > 5) risk = "MEDIUM";
  
  blasts.push(`    {
      repo: "repo-${i}",
      score: ${score},
      riskLevel: "${risk}",
      workflowsCount: ${Math.floor(Math.random() * 5)},
      vulnerabilitiesCount: ${Math.floor(Math.random() * 5)},
      accessVectorsCount: ${Math.floor(Math.random() * 10)}
    }`);
}
blasts.sort((a, b) => {
  const scoreA = parseInt(a.match(/score: (\d+)/)[1]);
  const scoreB = parseInt(b.match(/score: (\d+)/)[1]);
  return scoreB - scoreA;
});
const blastsStr = blasts.join(',\n');

const blastsStartStr = 'export async function mockGetBlastRadiusRanking(): Promise<any[]> {\n  await delay(500);\n  return [';
const blastsEndStr = '  ];\n}\n\nexport async function mockGetUserImpact';
const blastsStartIdx = content.indexOf(blastsStartStr);
const blastsEndIdx = content.indexOf(blastsEndStr);
if (blastsStartIdx !== -1 && blastsEndIdx !== -1) {
  content = content.slice(0, blastsStartIdx + blastsStartStr.length) + '\n' + blastsStr + '\n' + content.slice(blastsEndIdx);
}

// Generate 1000 bypasses
const bypasses = [];
for (let i = 1; i <= 1000; i++) {
  const bypassCount = Math.floor(Math.random() * 15);
  if (bypassCount > 0) {
    bypasses.push(`        { repo: "repo-${i}", bypasses: ${bypassCount}, reason: "${bypassCount} out of last 20 PRs bypassed the 2 reviewers requirement", score: ${bypassCount} }`);
  }
}
bypasses.sort((a, b) => {
  const scoreA = parseInt(a.match(/score: (\d+)/)[1]);
  const scoreB = parseInt(b.match(/score: (\d+)/)[1]);
  return scoreB - scoreA;
});
const bypassesStr = bypasses.join(',\n');

const bypassesStartStr = '    case "protection-bypasses-ranking":\n      return [';
const bypassesEndStr = '      ];\n    default:';
const bypassesStartIdx = content.indexOf(bypassesStartStr);
const bypassesEndIdx = content.indexOf(bypassesEndStr);
if (bypassesStartIdx !== -1 && bypassesEndIdx !== -1) {
  content = content.slice(0, bypassesStartIdx + bypassesStartStr.length) + '\n' + bypassesStr + '\n' + content.slice(bypassesEndIdx);
}

// Also update 'repos-with-branch' in mockFetchSecurityQuery
const branches = [];
for (let i = 1; i <= 1000; i++) {
  if (i % 2 !== 0) {
    branches.push(`        { repo: "repo-${i}", reason: \`Has branch: \${param || 'main'}\` }`);
  }
}
const branchesStr = branches.join(',\n');
const branchStartStr = '    case "repos-with-branch":\n      return [';
const branchEndStr = '      ];\n    case "repos-with-branch-rules":';
const branchStartIdx = content.indexOf(branchStartStr);
const branchEndIdx = content.indexOf(branchEndStr);
if (branchStartIdx !== -1 && branchEndIdx !== -1) {
  content = content.slice(0, branchStartIdx + branchStartStr.length) + '\n' + branchesStr + '\n' + content.slice(branchEndIdx);
}


fs.writeFileSync(file, content);
console.log('Done modifying mock.ts');
