#!/usr/bin/env node
/**
 * adoption-metrics.mjs
 *
 * Fetches aggregate developer-adoption signals for the Sapience AI Suite
 * open-source package — zero telemetry from developer environments.
 *
 * Data sources:
 *   - GitHub API   : stars, forks, traffic, referrers, popular paths,
 *                    contributors, issues/PRs, releases, discussions
 *   - npm registry : weekly / monthly / total downloads, 30-day trend
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node scripts/adoption-metrics.mjs
 *   node scripts/adoption-metrics.mjs --json          # machine-readable
 *   node scripts/adoption-metrics.mjs --csv           # CSV row (append to scorecard)
 *
 * Designed to run in CI on a weekly cron or locally for scorecard updates.
 */

import https from 'node:https';
import { GITHUB_TOKEN } from './_metrics-env.mjs';

// ── Config ─────────────────────────────────────────────────────────
const GITHUB_OWNER = 'Sapience-AI-Discovery-Team';
const GITHUB_REPO = 'Openclaw-Middleware-Suite';
const NPM_PACKAGE = 'sapience-ai-suite';
const OUTPUT_FORMAT = process.argv.includes('--json')
  ? 'json'
  : process.argv.includes('--csv')
    ? 'csv'
    : 'table';

const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

// ── HTTP helpers ───────────────────────────────────────────────────
function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'adoption-metrics/2.0', ...headers } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetch(res.headers.location, headers).then(resolve, reject);
        }
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}: ${body.slice(0, 200)}`));
          } else {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 200)}`));
            }
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Fetch a GitHub API URL, return null on failure instead of throwing. */
async function ghFetch(path, headers) {
  try {
    return await fetch(`${API_BASE}${path}`, headers);
  } catch {
    return null;
  }
}

/** Fetch all pages from a paginated GitHub endpoint (up to maxPages). */
async function ghFetchAll(path, headers, maxPages = 5) {
  const results = [];
  let page = 1;
  while (page <= maxPages) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await ghFetch(`${path}${sep}per_page=100&page=${page}`, headers);
    if (!data || !Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ── GitHub metrics ─────────────────────────────────────────────────
async function fetchGitHubMetrics() {
  const headers = {};
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }

  // Core repo info
  let repo;
  try {
    repo = await fetch(`${API_BASE}`, headers);
  } catch (err) {
    console.error(
      `Warning: GitHub repo fetch failed (${err.message}). Is GITHUB_TOKEN set for private repos?`
    );
    return {
      stars: 0,
      forks: 0,
      watchers: 0,
      openIssues: 0,
      traffic: {},
      referrers: [],
      popularPaths: [],
      contributors: 0,
      issues: {},
      pullRequests: {},
      releases: [],
      error: err.message,
    };
  }

  // Parallel fetch all supplementary data
  const [
    trafficViews,
    trafficClones,
    referrers,
    popularPaths,
    contributors,
    openIssues,
    closedIssues,
    openPRs,
    mergedPRs,
    closedPRs,
    releases,
  ] = await Promise.all([
    // Traffic (requires push access)
    ghFetch('/traffic/views', headers),
    ghFetch('/traffic/clones', headers),
    ghFetch('/traffic/referrers', headers),
    ghFetch('/traffic/popular/paths', headers),
    // Contributors
    ghFetchAll('/contributors', headers, 3),
    // Issues (open + recently closed)
    ghFetchAll('/issues?state=open&sort=created&direction=desc', headers, 2),
    ghFetchAll('/issues?state=closed&sort=updated&direction=desc', headers, 2),
    // Pull requests
    ghFetchAll('/pulls?state=open&sort=created&direction=desc', headers, 1),
    ghFetchAll('/pulls?state=closed&sort=updated&direction=desc', headers, 2),
    ghFetchAll('/pulls?state=closed&sort=updated&direction=desc', headers, 1), // for closed-not-merged
    // Releases
    ghFetchAll('/releases', headers, 1),
  ]);

  // ── Traffic ────────────────────────────────────────────────────
  const traffic = {};
  if (trafficViews) {
    traffic.views = { total: trafficViews.count, unique: trafficViews.uniques };
    traffic.viewsDaily = (trafficViews.views || []).map((v) => ({
      date: v.timestamp?.slice(0, 10),
      total: v.count,
      unique: v.uniques,
    }));
  }
  if (trafficClones) {
    traffic.clones = { total: trafficClones.count, unique: trafficClones.uniques };
  }

  // ── Referrers (top traffic sources) ────────────────────────────
  const topReferrers = (referrers || []).slice(0, 10).map((r) => ({
    source: r.referrer,
    views: r.count,
    unique: r.uniques,
  }));

  // ── Popular paths ──────────────────────────────────────────────
  const topPaths = (popularPaths || []).slice(0, 10).map((p) => ({
    path: p.path,
    views: p.count,
    unique: p.uniques,
  }));

  // ── Contributors ───────────────────────────────────────────────
  const contributorCount = contributors.length;
  const topContributors = contributors.slice(0, 5).map((c) => ({
    login: c.login,
    contributions: c.contributions,
  }));

  // ── Issues ─────────────────────────────────────────────────────
  // Filter out PRs from issues endpoint (GitHub returns PRs in /issues)
  const pureOpenIssues = openIssues.filter((i) => !i.pull_request);
  const pureClosedIssues = closedIssues.filter((i) => !i.pull_request);

  // Issues closed in the last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const closedThisWeek = pureClosedIssues.filter((i) => i.closed_at >= weekAgo);

  // Average time to first response (last 20 open issues with comments)
  let avgFirstResponseHrs = null;
  const issuesWithComments = pureOpenIssues
    .concat(pureClosedIssues)
    .filter((i) => i.comments > 0)
    .slice(0, 20);
  if (issuesWithComments.length > 0) {
    let totalHrs = 0;
    let counted = 0;
    for (const issue of issuesWithComments.slice(0, 10)) {
      try {
        const comments = await ghFetch(`/issues/${issue.number}/comments?per_page=1`, headers);
        if (comments && comments.length > 0) {
          const created = new Date(issue.created_at).getTime();
          const firstComment = new Date(comments[0].created_at).getTime();
          totalHrs += (firstComment - created) / (1000 * 60 * 60);
          counted++;
        }
      } catch {
        /* skip */
      }
    }
    if (counted > 0) avgFirstResponseHrs = Math.round(totalHrs / counted);
  }

  // Total comments across recent issues (engagement)
  const recentIssues = pureOpenIssues.concat(pureClosedIssues).slice(0, 50);
  const totalComments = recentIssues.reduce((sum, i) => sum + (i.comments || 0), 0);
  const avgCommentsPerIssue =
    recentIssues.length > 0 ? +(totalComments / recentIssues.length).toFixed(1) : 0;

  const issueStats = {
    open: pureOpenIssues.length,
    closedThisWeek: closedThisWeek.length,
    avgFirstResponseHrs,
    avgCommentsPerIssue,
  };

  // ── Pull Requests ──────────────────────────────────────────────
  const mergedThisWeek = mergedPRs.filter((pr) => pr.merged_at && pr.merged_at >= weekAgo);
  const prStats = {
    open: openPRs.length,
    mergedThisWeek: mergedThisWeek.length,
    closedThisWeek: closedPRs.filter((pr) => pr.closed_at >= weekAgo).length,
  };

  // ── Releases ───────────────────────────────────────────────────
  const releaseStats = releases.map((r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    date: r.published_at?.slice(0, 10),
    downloads: (r.assets || []).reduce((sum, a) => sum + (a.download_count || 0), 0),
    prerelease: r.prerelease,
  }));

  // ── Computed velocity signals ──────────────────────────────────
  const cloneToViewRatio = traffic.views?.total
    ? +(((traffic.clones?.total || 0) / traffic.views.total) * 100).toFixed(1)
    : null;
  const forkToStarRatio =
    repo.stargazers_count > 0
      ? +((repo.forks_count / repo.stargazers_count) * 100).toFixed(1)
      : null;

  return {
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.subscribers_count,
    openIssues: repo.open_issues_count,
    createdAt: repo.created_at?.slice(0, 10),
    traffic,
    referrers: topReferrers,
    popularPaths: topPaths,
    contributors: { count: contributorCount, top: topContributors },
    issues: issueStats,
    pullRequests: prStats,
    releases: releaseStats,
    computed: {
      cloneToViewPct: cloneToViewRatio,
      forkToStarPct: forkToStarRatio,
    },
  };
}

// ── npm download metrics ───────────────────────────────────────────
async function fetchNpmMetrics() {
  const results = { lastWeek: 0, lastMonth: 0, total: 0, dailyTrend: [] };

  try {
    const weekly = await fetch(`https://api.npmjs.org/downloads/point/last-week/${NPM_PACKAGE}`);
    results.lastWeek = weekly.downloads ?? 0;
  } catch {
    /* package may not be published yet */
  }

  try {
    const monthly = await fetch(`https://api.npmjs.org/downloads/point/last-month/${NPM_PACKAGE}`);
    results.lastMonth = monthly.downloads ?? 0;
  } catch {
    /* package may not be published yet */
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const total = await fetch(
      `https://api.npmjs.org/downloads/point/2015-01-01:${today}/${NPM_PACKAGE}`
    );
    results.total = total.downloads ?? 0;
  } catch {
    /* package may not be published yet */
  }

  // 30-day daily download trend
  try {
    const today = new Date().toISOString().slice(0, 10);
    const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const range = await fetch(
      `https://api.npmjs.org/downloads/range/${thirtyAgo}:${today}/${NPM_PACKAGE}`
    );
    results.dailyTrend = (range.downloads || []).map((d) => ({
      date: d.day,
      downloads: d.downloads,
    }));
  } catch {
    /* package may not be published yet */
  }

  // Week-over-week growth
  if (results.dailyTrend.length >= 14) {
    const thisWeek = results.dailyTrend.slice(-7).reduce((s, d) => s + d.downloads, 0);
    const lastWeek = results.dailyTrend.slice(-14, -7).reduce((s, d) => s + d.downloads, 0);
    results.weekOverWeekPct =
      lastWeek > 0 ? +(((thisWeek - lastWeek) / lastWeek) * 100).toFixed(1) : null;
  }

  return results;
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const date = new Date().toISOString().slice(0, 10);

  if (!GITHUB_TOKEN) {
    console.error(
      'Warning: GITHUB_TOKEN not set — GitHub API rate limit is 60 req/hr for unauthenticated requests.\n'
    );
  }

  const [github, npm, ci] = await Promise.all([
    fetchGitHubMetrics(),
    fetchNpmMetrics(),
    fetchCIMetrics(),
  ]);

  const report = { date, github, npm, ci };

  // ── JSON output ────────────────────────────────────────────────
  if (OUTPUT_FORMAT === 'json') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── CSV output ─────────────────────────────────────────────────
  if (OUTPUT_FORMAT === 'csv') {
    const header = [
      'date',
      'stars',
      'forks',
      'watchers',
      'contributors',
      'issues_open',
      'issues_closed_week',
      'avg_first_response_hrs',
      'prs_open',
      'prs_merged_week',
      'npm_weekly',
      'npm_monthly',
      'npm_total',
      'npm_wow_pct',
      'views_total',
      'views_unique',
      'clones_total',
      'clones_unique',
      'clone_to_view_pct',
      'fork_to_star_pct',
      'top_referrer',
      'release_downloads',
    ].join(',');

    const totalReleaseDownloads = (github.releases || []).reduce((s, r) => s + r.downloads, 0);
    const topReferrer = github.referrers?.[0]?.source || '';

    const row = [
      date,
      github.stars,
      github.forks,
      github.watchers,
      github.contributors?.count ?? 0,
      github.issues?.open ?? 0,
      github.issues?.closedThisWeek ?? 0,
      github.issues?.avgFirstResponseHrs ?? '',
      github.pullRequests?.open ?? 0,
      github.pullRequests?.mergedThisWeek ?? 0,
      npm.lastWeek,
      npm.lastMonth,
      npm.total,
      npm.weekOverWeekPct ?? '',
      github.traffic?.views?.total ?? '',
      github.traffic?.views?.unique ?? '',
      github.traffic?.clones?.total ?? '',
      github.traffic?.clones?.unique ?? '',
      github.computed?.cloneToViewPct ?? '',
      github.computed?.forkToStarPct ?? '',
      topReferrer,
      totalReleaseDownloads,
    ].join(',');

    console.log(header);
    console.log(row);
    return;
  }

  // ── Table (default) ────────────────────────────────────────────
  const line = '  ──────────────────────────────────────────────';
  const pad = (label, width = 26) => label.padEnd(width);

  console.log(`\n  Sapience AI Suite — Adoption Metrics (${date})\n`);

  // GitHub overview
  console.log('  GITHUB OVERVIEW');
  console.log(line);
  console.log(`  ${pad('Stars')}${github.stars}`);
  console.log(`  ${pad('Forks')}${github.forks}`);
  console.log(`  ${pad('Watchers')}${github.watchers}`);
  console.log(`  ${pad('Contributors')}${github.contributors?.count ?? 0}`);
  if (github.computed?.forkToStarPct !== null && github.computed?.forkToStarPct !== undefined) {
    console.log(`  ${pad('Fork-to-Star ratio')}${github.computed.forkToStarPct}%`);
  }

  // Traffic
  if (github.traffic?.views) {
    console.log(`\n  TRAFFIC (14 days)`);
    console.log(line);
    console.log(
      `  ${pad('Views')}${github.traffic.views.total} total / ${github.traffic.views.unique} unique`
    );
    console.log(
      `  ${pad('Clones')}${github.traffic.clones?.total ?? 0} total / ${github.traffic.clones?.unique ?? 0} unique`
    );
    if (github.computed?.cloneToViewPct !== null) {
      console.log(`  ${pad('Clone-to-View ratio')}${github.computed.cloneToViewPct}%`);
    }
  }

  // Referrers
  if (github.referrers?.length > 0) {
    console.log(`\n  TOP REFERRERS`);
    console.log(line);
    for (const r of github.referrers) {
      console.log(`  ${pad(r.source)}${r.views} views / ${r.unique} unique`);
    }
  }

  // Popular paths
  if (github.popularPaths?.length > 0) {
    console.log(`\n  POPULAR PATHS`);
    console.log(line);
    for (const p of github.popularPaths) {
      // Shorten long repo paths for display
      let short = p.path.replace(`/${GITHUB_OWNER}/${GITHUB_REPO}`, '') || '/';
      if (short.length > 38) short = short.slice(0, 35) + '...';
      console.log(`  ${pad(short, 40)}${p.views} views`);
    }
  }

  // Issues
  console.log(`\n  ISSUES`);
  console.log(line);
  console.log(`  ${pad('Open')}${github.issues?.open ?? 0}`);
  console.log(`  ${pad('Closed this week')}${github.issues?.closedThisWeek ?? 0}`);
  if (
    github.issues?.avgFirstResponseHrs !== null &&
    github.issues?.avgFirstResponseHrs !== undefined
  ) {
    console.log(`  ${pad('Avg first response')}${github.issues.avgFirstResponseHrs}h`);
  }
  console.log(`  ${pad('Avg comments/issue')}${github.issues?.avgCommentsPerIssue ?? 0}`);

  // Pull requests
  console.log(`\n  PULL REQUESTS`);
  console.log(line);
  console.log(`  ${pad('Open')}${github.pullRequests?.open ?? 0}`);
  console.log(`  ${pad('Merged this week')}${github.pullRequests?.mergedThisWeek ?? 0}`);

  // Releases
  if (github.releases?.length > 0) {
    console.log(`\n  RELEASES`);
    console.log(line);
    for (const r of github.releases.slice(0, 5)) {
      const dl = r.downloads > 0 ? ` (${r.downloads} downloads)` : '';
      const pre = r.prerelease ? ' [pre-release]' : '';
      console.log(`  ${pad(r.tag + pre)}${r.date}${dl}`);
    }
  }

  // Top contributors
  if (github.contributors?.top?.length > 0) {
    console.log(`\n  TOP CONTRIBUTORS`);
    console.log(line);
    for (const c of github.contributors.top) {
      console.log(`  ${pad(c.login)}${c.contributions} commits`);
    }
  }

  // CI / GitHub Actions
  if (ci) {
    console.log(`\n  GITHUB ACTIONS CI`);
    console.log(line);
    console.log(`  ${pad('Total runs (recent)')}${ci.totalRuns}`);
    console.log(`  ${pad('Success')}${ci.successCount}`);
    console.log(`  ${pad('Failure')}${ci.failureCount}`);
    console.log(`  ${pad('Cancelled')}${ci.cancelledCount}`);
    if (ci.successRate != null) {
      console.log(`  ${pad('Success rate')}${ci.successRate}%`);
    }
    if (ci.avgDurationSec != null) {
      const mins = Math.floor(ci.avgDurationSec / 60);
      const secs = ci.avgDurationSec % 60;
      console.log(`  ${pad('Avg duration')}${mins}m ${secs}s`);
    }
    if (ci.workflows?.length > 0) {
      console.log(`\n  WORKFLOW BREAKDOWN`);
      console.log(line);
      for (const w of ci.workflows.slice(0, 8)) {
        const rate = w.total > 0 ? ((w.success / w.total) * 100).toFixed(0) : 0;
        console.log(`  ${pad(w.name, 32)}${w.total} runs (${rate}% pass)`);
      }
    }
  }

  // npm
  console.log(`\n  NPM DOWNLOADS`);
  console.log(line);
  console.log(`  ${pad('Weekly')}${npm.lastWeek.toLocaleString()}`);
  console.log(`  ${pad('Monthly')}${npm.lastMonth.toLocaleString()}`);
  console.log(`  ${pad('Total')}${npm.total.toLocaleString()}`);
  if (npm.weekOverWeekPct !== null && npm.weekOverWeekPct !== undefined) {
    const arrow = npm.weekOverWeekPct > 0 ? '+' : '';
    console.log(`  ${pad('Week-over-week')}${arrow}${npm.weekOverWeekPct}%`);
  }

  // 30-day sparkline (simple ASCII bar)
  if (npm.dailyTrend?.length > 0) {
    const max = Math.max(...npm.dailyTrend.map((d) => d.downloads), 1);
    const bars = npm.dailyTrend
      .map((d) => {
        const height = Math.round((d.downloads / max) * 8);
        return [
          '_',
          '\u2581',
          '\u2582',
          '\u2583',
          '\u2584',
          '\u2585',
          '\u2586',
          '\u2587',
          '\u2588',
        ][height];
      })
      .join('');
    console.log(`  ${pad('30-day trend')}${bars}`);
  }

  console.log('');
}

// ── GitHub Actions CI metrics ─────────────────────────────────────
async function fetchCIMetrics() {
  const headers = {};
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }

  const results = {
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    cancelledCount: 0,
    successRate: null,
    avgDurationSec: null,
    workflows: [],
    recentRuns: [],
    dailyRuns: [],
  };

  try {
    // Fetch workflows
    const workflowsData = await ghFetch('/actions/workflows', headers);
    if (workflowsData?.workflows) {
      results.workflows = workflowsData.workflows.map((w) => ({
        id: w.id,
        name: w.name,
        state: w.state,
        path: w.path,
      }));
    }

    // Fetch recent runs (last 100)
    const runsData = await ghFetch('/actions/runs?per_page=100&status=completed', headers);
    if (!runsData?.workflow_runs) return results;

    const runs = runsData.workflow_runs;
    results.totalRuns = runsData.total_count ?? runs.length;

    let successCount = 0;
    let failureCount = 0;
    let cancelledCount = 0;
    let totalDuration = 0;
    let durationCount = 0;

    // Per-workflow stats
    const workflowStats = {};

    // Daily aggregation (last 14 days)
    const dailyMap = {};

    for (const run of runs) {
      const conclusion = run.conclusion;
      if (conclusion === 'success') successCount++;
      else if (conclusion === 'failure') failureCount++;
      else if (conclusion === 'cancelled') cancelledCount++;

      // Duration
      if (run.created_at && run.updated_at) {
        const dur =
          (new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()) / 1000;
        if (dur > 0 && dur < 86400) {
          totalDuration += dur;
          durationCount++;
        }
      }

      // Per-workflow
      const wName = run.name || 'Unknown';
      if (!workflowStats[wName]) {
        workflowStats[wName] = { name: wName, total: 0, success: 0, failure: 0 };
      }
      workflowStats[wName].total++;
      if (conclusion === 'success') workflowStats[wName].success++;
      if (conclusion === 'failure') workflowStats[wName].failure++;

      // Daily
      const day = run.created_at?.slice(0, 10);
      if (day) {
        if (!dailyMap[day]) dailyMap[day] = { date: day, total: 0, success: 0, failure: 0 };
        dailyMap[day].total++;
        if (conclusion === 'success') dailyMap[day].success++;
        if (conclusion === 'failure') dailyMap[day].failure++;
      }
    }

    results.successCount = successCount;
    results.failureCount = failureCount;
    results.cancelledCount = cancelledCount;
    results.successRate = runs.length > 0 ? +((successCount / runs.length) * 100).toFixed(1) : null;
    results.avgDurationSec = durationCount > 0 ? Math.round(totalDuration / durationCount) : null;

    // Workflow breakdown sorted by total runs
    results.workflows = Object.values(workflowStats).sort((a, b) => b.total - a.total);

    // Daily runs sorted by date
    results.dailyRuns = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // Recent runs (last 10) with details
    results.recentRuns = runs.slice(0, 10).map((r) => {
      const durSec =
        r.created_at && r.updated_at
          ? Math.round((new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 1000)
          : null;
      return {
        name: r.name || 'Unknown',
        branch: r.head_branch,
        conclusion: r.conclusion,
        durationSec: durSec,
        date: r.created_at?.slice(0, 10),
        url: r.html_url,
      };
    });
  } catch {
    /* CI metrics are best-effort */
  }

  return results;
}

// ── Exports (for dashboard / programmatic use) ───────────────────
export { fetchGitHubMetrics, fetchNpmMetrics, fetchCIMetrics };

// Run CLI when executed directly (node scripts/adoption-metrics.mjs)
const isDirectRun =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  main().catch((err) => {
    console.error('Error fetching adoption metrics:', err.message);
    process.exit(1);
  });
}
