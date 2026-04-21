#!/usr/bin/env node
/**
 * dashboard.mjs — Real-time adoption metrics dashboard
 *
 * Serves a single-page web dashboard that streams live metrics via SSE.
 * Zero external dependencies — uses only Node built-ins + sibling modules.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node scripts/dashboard.mjs
 *   GITHUB_TOKEN=ghp_xxx node scripts/dashboard.mjs --port 8080
 *   GITHUB_TOKEN=ghp_xxx node scripts/dashboard.mjs --interval 120   # refresh every 120s
 */

import http from 'node:http';
import { fetchGitHubMetrics, fetchNpmMetrics, fetchCIMetrics } from './adoption-metrics.mjs';
import { GITHUB_TOKEN } from './_metrics-env.mjs';

// ── Config ─────────────────────────────────────────────────────────
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '3777', 10);
const INTERVAL_SEC = parseInt(
  process.argv.find((_, i, a) => a[i - 1] === '--interval') || '60',
  10
);

// ── State ──────────────────────────────────────────────────────────
let latestMetrics = null;
let fetchError = null;
let lastFetchTime = null;
const sseClients = new Set();

// ── Metrics fetcher ────────────────────────────────────────────────
async function refreshMetrics() {
  try {
    const [github, npm, ci] = await Promise.all([
      fetchGitHubMetrics(),
      fetchNpmMetrics(),
      fetchCIMetrics(),
    ]);
    latestMetrics = {
      date: new Date().toISOString(),
      github,
      npm,
      ci,
    };
    fetchError = null;
    lastFetchTime = Date.now();

    // Push to all SSE clients
    const payload = `data: ${JSON.stringify(latestMetrics)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  } catch (err) {
    fetchError = err.message;
    const errPayload = `data: ${JSON.stringify({ error: err.message })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(errPayload);
      } catch {
        sseClients.delete(res);
      }
    }
  }
}

// ── HTML Dashboard ─────────────────────────────────────────────────
function dashboardHTML() {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sapience AI - OpenClaw Middleware Suite — Adoption Dashboard</title>
<style>
  :root {
    --bg: #06090f; --surface: rgba(22,27,34,.65); --surface-solid: #161b22;
    --border: rgba(48,54,61,.6); --border-hover: rgba(88,166,255,.4);
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --orange: #d29922; --red: #f85149;
    --purple: #bc8cff; --pink: #f778ba; --cyan: #39d2c0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.6;
    min-height: 100vh; overflow-x: hidden;
  }

  /* Animated mesh gradient background */
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1;
    background:
      radial-gradient(ellipse 80% 50% at 20% 40%, rgba(88,166,255,.08) 0%, transparent 60%),
      radial-gradient(ellipse 60% 40% at 80% 20%, rgba(188,140,255,.06) 0%, transparent 50%),
      radial-gradient(ellipse 50% 60% at 60% 80%, rgba(57,210,192,.05) 0%, transparent 50%),
      var(--bg);
    animation: meshShift 20s ease-in-out infinite alternate;
  }
  @keyframes meshShift {
    0% { filter: hue-rotate(0deg); }
    100% { filter: hue-rotate(30deg); }
  }

  /* Header */
  header {
    background: rgba(13,17,23,.85); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
    padding: 16px 32px; display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 10;
  }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .logo {
    width: 32px; height: 32px; border-radius: 8px;
    background: linear-gradient(135deg, var(--accent), var(--purple));
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 16px rgba(88,166,255,.3);
  }
  .logo svg { width: 18px; height: 18px; fill: white; }
  header h1 { font-size: 17px; font-weight: 600; letter-spacing: -.2px; }
  header h1 .brand {
    background: linear-gradient(135deg, var(--accent), var(--purple));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .status {
    display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted);
    background: rgba(255,255,255,.04); padding: 6px 14px; border-radius: 20px;
    border: 1px solid var(--border);
  }
  .status-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--green); box-shadow: 0 0 8px rgba(63,185,80,.6);
    animation: pulse 2s infinite;
  }
  .status-dot.error { background: var(--red); box-shadow: 0 0 8px rgba(248,81,73,.6); }
  .status-dot.loading { background: var(--orange); box-shadow: 0 0 8px rgba(210,153,34,.6); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

  main { max-width: 1360px; margin: 0 auto; padding: 28px 32px; }

  /* Grids */
  .grid {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  }
  .grid-wide {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  }

  /* Cards — glassmorphism */
  .card {
    background: var(--surface); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px;
    transition: all .3s cubic-bezier(.4,0,.2,1);
    position: relative; overflow: hidden;
  }
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,.08), transparent);
  }
  .card:hover {
    border-color: var(--border-hover);
    transform: translateY(-2px);
    box-shadow: 0 8px 32px rgba(0,0,0,.3), 0 0 0 1px rgba(88,166,255,.1);
  }

  /* KPI cards with icons */
  .kpi-card { display: flex; align-items: flex-start; gap: 14px; }
  .kpi-icon {
    width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
  }
  .kpi-icon.stars { background: rgba(210,153,34,.12); }
  .kpi-icon.forks { background: rgba(88,166,255,.12); }
  .kpi-icon.watchers { background: rgba(188,140,255,.12); }
  .kpi-icon.contribs { background: rgba(63,185,80,.12); }
  .kpi-icon.npm-w { background: rgba(248,81,73,.12); }
  .kpi-icon.npm-m { background: rgba(247,120,186,.12); }
  .kpi-icon.npm-t { background: rgba(57,210,192,.12); }
  .kpi-icon.wow { background: rgba(63,185,80,.12); }
  .kpi-icon.ci-runs { background: rgba(88,166,255,.12); }
  .kpi-icon.ci-pass { background: rgba(63,185,80,.12); }
  .kpi-icon.ci-fail { background: rgba(248,81,73,.12); }
  .kpi-icon.ci-dur { background: rgba(210,153,34,.12); }
  .kpi-body { flex: 1; min-width: 0; }

  /* CI status badges */
  .ci-badge {
    display: inline-block; padding: 2px 8px; border-radius: 12px;
    font-size: 11px; font-weight: 600; letter-spacing: .3px;
  }
  .ci-badge.success { background: rgba(63,185,80,.15); color: var(--green); }
  .ci-badge.failure { background: rgba(248,81,73,.15); color: var(--red); }
  .ci-badge.cancelled { background: rgba(139,148,158,.15); color: var(--muted); }
  .ci-badge.skipped { background: rgba(139,148,158,.1); color: var(--muted); }

  /* Success rate ring */
  .rate-ring {
    width: 52px; height: 52px; border-radius: 50%; position: relative;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .rate-ring svg { position: absolute; inset: 0; transform: rotate(-90deg); }
  .rate-ring .rate-text { font-size: 13px; font-weight: 700; z-index: 1; }

  /* Stacked bar for workflow breakdown */
  .stacked-bar {
    display: flex; height: 8px; border-radius: 4px; overflow: hidden;
    background: rgba(48,54,61,.5); margin-top: 6px;
  }
  .stacked-bar .seg { transition: width .6s ease; min-width: 1px; }
  .stacked-bar .seg.pass { background: var(--green); }
  .stacked-bar .seg.fail { background: var(--red); }

  .card-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: .6px;
    color: var(--muted); margin-bottom: 4px; font-weight: 500;
  }
  .card-value {
    font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums;
    letter-spacing: -.5px;
  }
  .card-sub { font-size: 11px; color: var(--muted); margin-top: 3px; }

  /* Sections */
  .section { margin-top: 36px; }
  .section-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px;
    color: var(--muted); margin-bottom: 14px;
    display: flex; align-items: center; gap: 10px;
  }
  .section-title::after {
    content: ''; flex: 1; height: 1px;
    background: linear-gradient(90deg, var(--border), transparent);
  }

  /* Bar chart */
  .bar-chart {
    display: flex; align-items: flex-end; gap: 3px; height: 120px;
    margin-top: 14px; padding: 0 2px;
  }
  .bar-chart .bar {
    flex: 1; border-radius: 3px 3px 0 0;
    min-width: 5px; transition: all .4s cubic-bezier(.4,0,.2,1); position: relative;
    cursor: pointer;
  }
  .bar-chart .bar:hover { z-index: 1; filter: brightness(1.3); transform: scaleY(1.03); transform-origin: bottom; }
  .bar-chart .bar .tooltip {
    display: none; position: absolute; bottom: calc(100% + 10px); left: 50%;
    transform: translateX(-50%);
    background: var(--surface-solid); color: var(--text);
    font-size: 12px; padding: 8px 12px; border-radius: 8px; white-space: nowrap;
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
    pointer-events: none;
  }
  .bar-chart .bar .tooltip::after {
    content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: var(--border);
  }
  .bar-chart .bar .tooltip .tt-date { color: var(--muted); font-size: 10px; display: block; margin-bottom: 2px; }
  .bar-chart .bar .tooltip .tt-val { font-weight: 700; font-size: 15px; }
  .bar-chart .bar:hover .tooltip { display: block; }

  /* Table */
  .data-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  .data-table th {
    text-align: left; color: var(--muted); font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: .4px;
    padding: 8px 10px; border-bottom: 1px solid var(--border);
  }
  .data-table td { padding: 8px 10px; border-bottom: 1px solid rgba(48,54,61,.3); }
  .data-table tr:last-child td { border-bottom: none; }
  .data-table tr { transition: background .15s; }
  .data-table tbody tr:hover { background: rgba(88,166,255,.04); }

  /* Ratio meters */
  .meter {
    height: 5px; background: rgba(48,54,61,.5); border-radius: 3px;
    margin-top: 10px; overflow: hidden;
  }
  .meter-fill {
    height: 100%; border-radius: 3px;
    transition: width .8s cubic-bezier(.4,0,.2,1);
    box-shadow: 0 0 8px rgba(88,166,255,.3);
  }

  .error-banner {
    background: rgba(248,81,73,.08); border: 1px solid rgba(248,81,73,.3); border-radius: 10px;
    padding: 12px 18px; color: var(--red); font-size: 13px; margin-bottom: 16px;
    backdrop-filter: blur(8px);
  }

  .loading-skeleton {
    background: linear-gradient(90deg, rgba(48,54,61,.3) 25%, rgba(48,54,61,.6) 50%, rgba(48,54,61,.3) 75%);
    background-size: 200% 100%; animation: shimmer 1.8s ease-in-out infinite;
    border-radius: 6px; height: 26px; width: 80px;
  }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  /* Entrance animation */
  .card { animation: fadeSlideIn .5s ease both; }
  .grid .card:nth-child(1) { animation-delay: .02s; }
  .grid .card:nth-child(2) { animation-delay: .06s; }
  .grid .card:nth-child(3) { animation-delay: .10s; }
  .grid .card:nth-child(4) { animation-delay: .14s; }
  .grid .card:nth-child(5) { animation-delay: .18s; }
  .grid .card:nth-child(6) { animation-delay: .22s; }
  .grid .card:nth-child(7) { animation-delay: .26s; }
  .grid .card:nth-child(8) { animation-delay: .30s; }
  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  footer {
    text-align: center; padding: 28px; color: var(--muted); font-size: 11px;
    letter-spacing: .3px;
  }
  footer span { color: var(--accent); }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted); }
</style>
</head>
<body>
<header>
  <div class="header-left">
    <div class="logo">
      <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
    </div>
    <h1><span class="brand">Sapience AI - OpenClaw Middleware Suite</span> &mdash; Adoption Dashboard</h1>
  </div>
  <div class="status">
    <div class="status-dot loading" id="statusDot"></div>
    <span id="statusText">Connecting...</span>
  </div>
</header>

<main>
  <div id="error"></div>

  <!-- KPI Cards -->
  <div class="grid" id="kpiGrid">
    <div class="card">
      <div class="kpi-card">
        <div class="kpi-icon stars">&#11088;</div>
        <div class="kpi-body"><div class="card-label">Stars</div><div class="card-value loading-skeleton" id="stars"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="kpi-card">
        <div class="kpi-icon forks">&#128268;</div>
        <div class="kpi-body"><div class="card-label">Forks</div><div class="card-value loading-skeleton" id="forks"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="kpi-card">
        <div class="kpi-icon watchers">&#128065;</div>
        <div class="kpi-body"><div class="card-label">Watchers</div><div class="card-value loading-skeleton" id="watchers"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="kpi-card">
        <div class="kpi-icon contribs">&#128101;</div>
        <div class="kpi-body"><div class="card-label">Contributors</div><div class="card-value loading-skeleton" id="contributors"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="kpi-card">
        <div class="kpi-icon npm-w">&#128230;</div>
        <div class="kpi-body"><div class="card-label">npm Weekly</div><div class="card-value loading-skeleton" id="npmWeekly"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="kpi-card">
        <div class="kpi-icon npm-m">&#128197;</div>
        <div class="kpi-body"><div class="card-label">npm Monthly</div><div class="card-value loading-skeleton" id="npmMonthly"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="kpi-card">
        <div class="kpi-icon npm-t">&#127919;</div>
        <div class="kpi-body"><div class="card-label">npm Total</div><div class="card-value loading-skeleton" id="npmTotal"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="kpi-card">
        <div class="kpi-icon wow">&#128200;</div>
        <div class="kpi-body"><div class="card-label">Week-over-Week</div><div class="card-value loading-skeleton" id="npmWow"></div></div>
      </div>
    </div>
  </div>

  <!-- Traffic & Issues row -->
  <div class="section">
    <div class="section-title">Traffic &amp; Engagement</div>
    <div class="grid">
      <div class="card">
        <div class="card-label">Views (14d)</div>
        <div class="card-value" id="views">-</div>
        <div class="card-sub" id="viewsSub"></div>
      </div>
      <div class="card">
        <div class="card-label">Clones (14d)</div>
        <div class="card-value" id="clones">-</div>
        <div class="card-sub" id="clonesSub"></div>
      </div>
      <div class="card">
        <div class="card-label">Open Issues</div>
        <div class="card-value" id="issuesOpen">-</div>
        <div class="card-sub" id="issuesSub"></div>
      </div>
      <div class="card">
        <div class="card-label">Open PRs</div>
        <div class="card-value" id="prsOpen">-</div>
        <div class="card-sub" id="prsSub"></div>
      </div>
    </div>
  </div>

  <!-- Ratios -->
  <div class="section">
    <div class="section-title">Velocity Signals</div>
    <div class="grid">
      <div class="card">
        <div class="card-label">Fork-to-Star Ratio</div>
        <div class="card-value" id="forkStarRatio">-</div>
        <div class="meter"><div class="meter-fill" id="forkStarMeter" style="width:0;background:linear-gradient(90deg,var(--accent),var(--purple))"></div></div>
      </div>
      <div class="card">
        <div class="card-label">Clone-to-View Ratio</div>
        <div class="card-value" id="cloneViewRatio">-</div>
        <div class="meter"><div class="meter-fill" id="cloneViewMeter" style="width:0;background:linear-gradient(90deg,var(--green),var(--cyan))"></div></div>
      </div>
      <div class="card">
        <div class="card-label">Avg First Response</div>
        <div class="card-value" id="avgResponse">-</div>
        <div class="card-sub">hours (sampled from recent issues)</div>
      </div>
      <div class="card">
        <div class="card-label">Avg Comments/Issue</div>
        <div class="card-value" id="avgComments">-</div>
      </div>
    </div>
  </div>

  <!-- Charts row -->
  <div class="section">
    <div class="section-title">Download &amp; Traffic Trends</div>
    <div class="grid-wide">
      <div class="card">
        <div class="card-label">npm Downloads (30d)</div>
        <div class="bar-chart" id="npmChart"></div>
      </div>
      <div class="card" id="trafficChartCard">
        <div class="card-label">Daily Views (14d)</div>
        <div class="bar-chart" id="trafficChart"></div>
      </div>
    </div>
  </div>

  <!-- Tables row -->
  <div class="section">
    <div class="section-title">Details</div>
    <div class="grid-wide">
      <div class="card">
        <div class="card-label">Top Referrers</div>
        <table class="data-table">
          <thead><tr><th>Source</th><th>Views</th><th>Unique</th></tr></thead>
          <tbody id="referrersTable"></tbody>
        </table>
      </div>
    </div>
    <div style="margin-top:14px;">
      <div class="card">
        <div class="card-label">Popular Paths</div>
        <table class="data-table" style="table-layout:auto;">
          <thead><tr><th>Path</th><th style="width:80px;text-align:right;">Views</th><th style="width:80px;text-align:right;">Unique</th></tr></thead>
          <tbody id="pathsTable"></tbody>
        </table>
      </div>
    </div>
    <div class="grid-wide" style="margin-top:14px;">
      <div class="card">
        <div class="card-label">Top Contributors</div>
        <table class="data-table">
          <thead><tr><th>Login</th><th>Commits</th></tr></thead>
          <tbody id="contributorsTable"></tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-label">Releases</div>
        <table class="data-table">
          <thead><tr><th>Tag</th><th>Date</th><th>Downloads</th></tr></thead>
          <tbody id="releasesTable"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- CI / GitHub Actions -->
  <div class="section">
    <div class="section-title">GitHub Actions CI</div>
    <div class="grid">
      <div class="card">
        <div class="kpi-card">
          <div class="kpi-icon ci-runs">&#9881;</div>
          <div class="kpi-body"><div class="card-label">Total Runs</div><div class="card-value loading-skeleton" id="ciTotalRuns"></div></div>
        </div>
      </div>
      <div class="card">
        <div class="kpi-card">
          <div class="rate-ring" id="ciRateRing">
            <svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="22" fill="none" stroke="rgba(48,54,61,.5)" stroke-width="4"/><circle id="ciRateCircle" cx="26" cy="26" r="22" fill="none" stroke="var(--green)" stroke-width="4" stroke-dasharray="138.2" stroke-dashoffset="138.2" stroke-linecap="round"/></svg>
            <span class="rate-text" id="ciSuccessRate">-</span>
          </div>
          <div class="kpi-body"><div class="card-label">Success Rate</div><div class="card-sub" id="ciRateSub"></div></div>
        </div>
      </div>
      <div class="card">
        <div class="kpi-card">
          <div class="kpi-icon ci-pass">&#10003;</div>
          <div class="kpi-body"><div class="card-label">Passed</div><div class="card-value loading-skeleton" id="ciPassCount"></div></div>
        </div>
      </div>
      <div class="card">
        <div class="kpi-card">
          <div class="kpi-icon ci-fail">&#10007;</div>
          <div class="kpi-body"><div class="card-label">Failed</div><div class="card-value loading-skeleton" id="ciFailCount"></div></div>
        </div>
      </div>
      <div class="card">
        <div class="kpi-card">
          <div class="kpi-icon ci-dur">&#9202;</div>
          <div class="kpi-body"><div class="card-label">Avg Duration</div><div class="card-value loading-skeleton" id="ciAvgDuration"></div></div>
        </div>
      </div>
    </div>
  </div>

  <!-- CI Charts & Tables -->
  <div class="section">
    <div class="section-title">CI Trends &amp; Breakdown</div>
    <div class="grid-wide">
      <div class="card">
        <div class="card-label">Daily CI Runs (14d)</div>
        <div class="bar-chart" id="ciDailyChart"></div>
      </div>
      <div class="card">
        <div class="card-label">Workflow Breakdown</div>
        <table class="data-table">
          <thead><tr><th>Workflow</th><th>Runs</th><th>Pass Rate</th><th style="width:120px;"></th></tr></thead>
          <tbody id="ciWorkflowTable"></tbody>
        </table>
      </div>
    </div>
    <div style="margin-top:14px;">
      <div class="card">
        <div class="card-label">Recent Runs</div>
        <table class="data-table">
          <thead><tr><th>Workflow</th><th>Branch</th><th>Status</th><th>Duration</th><th>Date</th></tr></thead>
          <tbody id="ciRecentTable"></tbody>
        </table>
      </div>
    </div>
  </div>
</main>


<script>
const $ = id => document.getElementById(id);
const fmt = n => n == null ? '-' : Number(n).toLocaleString();

function renderMetrics(d) {
  if (d.error) {
    $('error').innerHTML = '<div class="error-banner">Fetch error: ' + escHtml(d.error) + '</div>';
    return;
  }
  $('error').innerHTML = '';
  const g = d.github, n = d.npm;

  // KPI cards — animate counting
  animateValue('stars', g.stars);
  animateValue('forks', g.forks);
  animateValue('watchers', g.watchers);
  animateValue('contributors', g.contributors?.count);
  animateValue('npmWeekly', n.lastWeek);
  animateValue('npmMonthly', n.lastMonth);
  animateValue('npmTotal', n.total);

  // WoW
  const wow = n.weekOverWeekPct;
  if (wow != null) {
    const arrow = wow > 0 ? '+' : '';
    setText('npmWow', arrow + wow + '%');
    $('npmWow').style.color = wow > 0 ? 'var(--green)' : wow < 0 ? 'var(--red)' : 'var(--text)';
  } else {
    setText('npmWow', '-');
  }

  // Traffic
  animateValue('views', g.traffic?.views?.total);
  $('viewsSub').textContent = (g.traffic?.views?.unique ?? 0) + ' unique visitors';
  animateValue('clones', g.traffic?.clones?.total);
  $('clonesSub').textContent = (g.traffic?.clones?.unique ?? 0) + ' unique cloners';

  // Issues & PRs
  animateValue('issuesOpen', g.issues?.open);
  $('issuesSub').textContent = (g.issues?.closedThisWeek ?? 0) + ' closed this week';
  animateValue('prsOpen', g.pullRequests?.open);
  $('prsSub').textContent = (g.pullRequests?.mergedThisWeek ?? 0) + ' merged this week';

  // Ratios
  const fsr = g.computed?.forkToStarPct;
  setText('forkStarRatio', fsr != null ? fsr + '%' : '-');
  $('forkStarMeter').style.width = Math.min(fsr || 0, 100) + '%';

  const cvr = g.computed?.cloneToViewPct;
  setText('cloneViewRatio', cvr != null ? cvr + '%' : '-');
  $('cloneViewMeter').style.width = Math.min(cvr || 0, 100) + '%';

  setText('avgResponse', g.issues?.avgFirstResponseHrs != null ? g.issues.avgFirstResponseHrs + 'h' : '-');
  setText('avgComments', g.issues?.avgCommentsPerIssue ?? '-');

  // ── CI / GitHub Actions ─────────────────────────────────────────
  const ci = d.ci;
  if (ci) {
    animateValue('ciTotalRuns', ci.totalRuns);
    animateValue('ciPassCount', ci.successCount);
    animateValue('ciFailCount', ci.failureCount);

    // Success rate ring
    const rate = ci.successRate;
    if (rate != null) {
      $('ciSuccessRate').textContent = rate + '%';
      $('ciSuccessRate').style.color = rate >= 90 ? 'var(--green)' : rate >= 70 ? 'var(--orange)' : 'var(--red)';
      const circum = 2 * Math.PI * 22; // ~138.2
      $('ciRateCircle').style.strokeDashoffset = circum - (circum * rate / 100);
      $('ciRateCircle').style.stroke = rate >= 90 ? 'var(--green)' : rate >= 70 ? 'var(--orange)' : 'var(--red)';
      $('ciRateSub').textContent = ci.successCount + ' passed / ' + ci.failureCount + ' failed';
    }

    // Avg duration
    if (ci.avgDurationSec != null) {
      const mins = Math.floor(ci.avgDurationSec / 60);
      const secs = ci.avgDurationSec % 60;
      setText('ciAvgDuration', mins + 'm ' + secs + 's');
    } else {
      setText('ciAvgDuration', '-');
    }

    // Daily CI chart
    renderBarChart('ciDailyChart', ci.dailyRuns || [], 'total', 'date', '--green', '--accent');

    // Workflow breakdown table
    renderTable('ciWorkflowTable', ci.workflows || [], function(w) {
      const rate = w.total > 0 ? ((w.success / w.total) * 100).toFixed(0) : 0;
      const passPct = w.total > 0 ? ((w.success / w.total) * 100).toFixed(1) : 0;
      const failPct = w.total > 0 ? ((w.failure / w.total) * 100).toFixed(1) : 0;
      const rateColor = rate >= 90 ? 'var(--green)' : rate >= 70 ? 'var(--orange)' : 'var(--red)';
      return '<td>' + escHtml(w.name) + '</td>' +
        '<td>' + w.total + '</td>' +
        '<td style="color:' + rateColor + ';font-weight:600;">' + rate + '%</td>' +
        '<td><div class="stacked-bar"><div class="seg pass" style="width:' + passPct + '%"></div><div class="seg fail" style="width:' + failPct + '%"></div></div></td>';
    });

    // Recent runs table
    renderTable('ciRecentTable', ci.recentRuns || [], function(r) {
      const badge = '<span class="ci-badge ' + (r.conclusion || 'skipped') + '">' + escHtml(r.conclusion || 'unknown') + '</span>';
      let dur = '-';
      if (r.durationSec != null) {
        const m = Math.floor(r.durationSec / 60);
        const s = r.durationSec % 60;
        dur = m + 'm ' + s + 's';
      }
      return '<td>' + escHtml(r.name) + '</td>' +
        '<td style="color:var(--accent);font-size:12px;">' + escHtml(r.branch || '-') + '</td>' +
        '<td>' + badge + '</td>' +
        '<td style="font-variant-numeric:tabular-nums;">' + dur + '</td>' +
        '<td style="color:var(--muted);">' + escHtml(r.date || '-') + '</td>';
    });
  }

  // Charts with gradient colors
  renderBarChart('npmChart', n.dailyTrend || [], 'downloads', 'date', '--accent', '--cyan');
  renderBarChart('trafficChart', g.traffic?.viewsDaily || [], 'total', 'date', '--purple', '--pink');

  // Tables
  renderTable('referrersTable', g.referrers || [], r =>
    '<td>' + escHtml(r.source) + '</td><td>' + fmt(r.views) + '</td><td>' + fmt(r.unique) + '</td>');
  renderTable('pathsTable', g.popularPaths || [], p => {
    let clean = p.path.replace(/^\\/[^\\/]+\\/[^\\/]+/, '') || '/';
    return '<td style="font-family:\\'Cascadia Code\\',\\'Fira Code\\',monospace;font-size:12px;color:var(--accent);">' + escHtml(clean) + '</td>' +
      '<td style="text-align:right;">' + fmt(p.views) + '</td>' +
      '<td style="text-align:right;">' + fmt(p.unique) + '</td>';
  });
  renderTable('contributorsTable', (g.contributors?.top || []), c =>
    '<td><span style="color:var(--accent)">' + escHtml(c.login) + '</span></td><td>' + fmt(c.contributions) + '</td>');
  renderTable('releasesTable', (g.releases || []).slice(0, 5), r =>
    '<td><span style="color:var(--green)">' + escHtml(r.tag) + '</span>' +
    (r.prerelease ? ' <span style="color:var(--orange);font-size:10px;background:rgba(210,153,34,.12);padding:1px 6px;border-radius:8px;">pre</span>' : '') +
    '</td><td style="color:var(--muted)">' + (r.date || '-') + '</td><td>' + fmt(r.downloads) + '</td>');
}

function setText(id, val) {
  const el = $(id);
  el.className = 'card-value';
  el.textContent = val;
}

/** Animated counting effect */
function animateValue(id, target) {
  const el = $(id);
  el.className = 'card-value';
  target = target ?? 0;
  const current = parseInt(el.textContent.replace(/,/g, ''), 10) || 0;
  if (current === target) { el.textContent = fmt(target); return; }
  const duration = 600;
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = fmt(Math.round(current + (target - current) * ease));
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderBarChart(containerId, data, valKey, labelKey, colorVar1, colorVar2) {
  const el = $(containerId);
  if (!data.length) { el.innerHTML = '<span style="color:var(--muted);font-size:12px">No data</span>'; return; }
  const max = Math.max(...data.map(d => d[valKey]), 1);
  el.innerHTML = data.map((d, i) => {
    const pct = (d[valKey] / max * 100).toFixed(1);
    const label = d[labelKey] || '';
    let display = label;
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(label)) {
      const dt = new Date(label + 'T00:00:00');
      display = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    // Gradient from colorVar1 to colorVar2 across bars
    const ratio = data.length > 1 ? i / (data.length - 1) : 0;
    const opacity = (.5 + ratio * .5).toFixed(2);
    const bg = 'color-mix(in srgb, var(' + colorVar1 + ') ' + Math.round((1 - ratio) * 100) + '%, var(' + colorVar2 + '))';
    return '<div class="bar" style="height:' + pct + '%;background:' + bg + ';animation:barGrow .6s ease both;animation-delay:' + (i * 15) + 'ms">' +
      '<div class="tooltip"><span class="tt-date">' + escHtml(display) + '</span>' +
      '<span class="tt-val" style="color:var(' + colorVar1 + ')">' + fmt(d[valKey]) + '</span></div></div>';
  }).join('');
}

function renderTable(id, rows, renderRow) {
  const el = $(id);
  if (!rows.length) { el.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No data</td></tr>'; return; }
  el.innerHTML = rows.map(r => '<tr>' + renderRow(r) + '</tr>').join('');
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ── SSE connection ─────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    $('statusDot').className = 'status-dot';
    $('statusText').textContent = 'Live';
  };
  es.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      renderMetrics(d);
      const t = new Date(d.date || Date.now()).toLocaleTimeString();
      $('statusText').textContent = 'Updated ' + t;
    } catch {}
  };
  es.onerror = () => {
    $('statusDot').className = 'status-dot error';
    $('statusText').textContent = 'Disconnected \u2014 retrying...';
    es.close();
    setTimeout(connect, 3000);
  };
}
connect();
</script>
</body>
</html>`;
}

// ── HTTP Server ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/stream') {
    // SSE endpoint
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':ok\n\n');

    // Send current data immediately if available
    if (latestMetrics) {
      res.write(`data: ${JSON.stringify(latestMetrics)}\n\n`);
    }

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.url === '/api/metrics') {
    // JSON snapshot
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestMetrics || { error: 'Loading...' }));
    return;
  }

  // Serve dashboard
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(dashboardHTML());
});

// ── Start ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  Sapience AI - OpenClaw Middleware Suite — Adoption Dashboard`);
  console.log(`  ───────────────────────────────────────`);
  console.log(`  Dashboard : http://localhost:${PORT}`);
  console.log(`  JSON API  : http://localhost:${PORT}/api/metrics`);
  console.log(`  SSE stream: http://localhost:${PORT}/api/stream`);
  console.log(`  Refresh   : every ${INTERVAL_SEC}s`);
  console.log(`  Token     : ${GITHUB_TOKEN ? 'set' : 'NOT SET (rate-limited)'}\n`);
});

// Initial fetch + interval
refreshMetrics();
setInterval(refreshMetrics, INTERVAL_SEC * 1000);
