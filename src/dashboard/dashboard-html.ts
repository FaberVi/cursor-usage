import { randomBytes } from "crypto";
import type * as vscode from "vscode";

export function makeDashboardNonce(): string {
  return randomBytes(16).toString("base64url");
}

export type DashboardAssetUris = {
  cssUri: vscode.Uri;
  jsUri: vscode.Uri;
  chartUri: vscode.Uri;
};

function renderRangeSelector(id: string, scope: "chart" | "breakdown"): string {
  return `<div class="range-selector" id="${id}" data-range-selector data-range-scope="${scope}" role="tablist">
      <button data-range="1d" type="button" data-i18n="range.1d">Today</button>
      <button data-range="7d" type="button" data-i18n="range.7d">Last 7 days</button>
      <button data-range="30d" type="button" data-i18n="range.30d">Last 30 days</button>
      <button data-range="billingCycle" type="button" data-i18n="range.billingCycle">Current Billing Cycle</button>
    </div>`;
}

export function renderDashboardHtml(
  webview: vscode.Webview,
  assets: DashboardAssetUris,
  nonce: string,
): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursor Usage</title>
  <link rel="stylesheet" href="${assets.cssUri}">
</head>
<body>
  <header class="dashboard-header">
    <h1>Cursor Usage</h1>
    <div class="header-actions">
      <span id="last-updated" class="muted"></span>
      <select id="currency-select" class="header-select" aria-label="Currency">
        <option value="usd">USD ($)</option>
        <option value="eur">EUR (€)</option>
      </select>
      <select id="lang-select" class="header-select" aria-label="Language">
        <option value="en">EN</option>
        <option value="it">IT</option>
      </select>
      <button id="refresh-btn" type="button" data-i18n="refresh">Refresh</button>
    </div>
  </header>

  <section class="plan-banner hidden" id="plan-banner" aria-live="polite"></section>

  <section class="summary-cards" id="summary-cards"></section>

  <section class="controls">
    ${renderRangeSelector("range-selector", "chart")}
  </section>

  <div id="error-banner" class="error-banner hidden"></div>
  <div id="warning-banner" class="warning-banner hidden"></div>

  <nav class="dashboard-tabs" role="tablist" aria-label="Dashboard views">
    <button type="button" class="dashboard-tab active" data-main-tab="usage" role="tab" aria-selected="true" aria-controls="tab-panel-usage" data-i18n="mainTab.usage">Usage</button>
    <button type="button" class="dashboard-tab" data-main-tab="pools" role="tab" aria-selected="false" aria-controls="tab-panel-pools" id="main-tab-pools" data-i18n="mainTab.pools">Pools</button>
    <button type="button" class="dashboard-tab" data-main-tab="pricing" role="tab" aria-selected="false" aria-controls="tab-panel-pricing" data-i18n="mainTab.pricing">Pricing</button>
    <button type="button" class="dashboard-tab" data-main-tab="activity" role="tab" aria-selected="false" aria-controls="tab-panel-activity" data-i18n="mainTab.activity">Activity</button>
  </nav>

  ${renderUsageTabPanel()}
  ${renderPoolsTabPanel()}
  ${renderPricingTabPanel()}
  ${renderActivityTabPanel()}
  ${renderEventDetailOverlay()}

  <script nonce="${nonce}" src="${assets.chartUri}"></script>
  <script nonce="${nonce}" src="${assets.jsUri}"></script>
</body>
</html>`;
}

function renderUsageTabPanel(): string {
  return `<div id="tab-panel-usage" class="dashboard-tab-panel" data-main-tab-panel="usage" role="tabpanel" aria-labelledby="main-tab-usage">
  <section class="chart-section" data-section="usage">
    <div class="chart-header">
      <div class="section-title-block">
        <h2 data-i18n="section.usage.title">Your Usage</h2>
        <p class="muted" data-i18n="section.usage.desc">Per-day token usage over the selected range</p>
      </div>
      <div class="chart-header-aside breakdown-header-aside">
        <div class="breakdown-filters">
          <label><span data-i18n="filter.metric.label">Metric:</span>
            <select id="chart-metric-filter">
              <option value="tokens" data-i18n="metric.tokens">Tokens</option>
              <option value="spend" data-i18n="metric.spend">Spend</option>
              <option value="requests" data-i18n="metric.requests">Requests</option>
            </select>
          </label>
        </div>
        <span class="muted small" id="chart-range-label"></span>
      </div>
    </div>
    <div id="section-body-usage" class="section-body">
      <div class="chart-wrapper">
        <canvas id="usage-chart"></canvas>
      </div>
      <p id="chart-note" class="muted small"></p>
    </div>
  </section>

  <section class="model-breakdown-section" data-section="breakdown">
    <div class="events-header breakdown-header">
      <div class="section-title-block">
        <h2 data-i18n="section.breakdown.title">Usage by Model</h2>
      </div>
    </div>
    <div class="breakdown-toolbar">
      ${renderRangeSelector("breakdown-range-selector", "breakdown")}
      <button type="button" id="breakdown-grok-bot-toggle" class="breakdown-grok-toggle" aria-pressed="true" data-i18n="breakdown.grokBotToggle">Grok Bot</button>
    </div>
    <div class="breakdown-filter-row">
      <div class="breakdown-filters">
        <label><span data-i18n="filter.usage.label">Usage:</span>
          <select id="usage-filter">
            <option value="all" data-i18n="filter.all">All</option>
            <option value="included" data-i18n="filter.included">Included</option>
            <option value="ondemand" data-i18n="filter.ondemand">On-Demand</option>
          </select>
        </label>
      </div>
      <span class="muted small" id="breakdown-range-label"></span>
    </div>
    <div id="section-body-breakdown" class="section-body">
      <div class="table-scroll">
        <table id="breakdown-table">
          <thead>
            <tr>
              <th data-sort="model" class="sortable" data-i18n="col.model">Model</th>
              <th data-sort="requests" class="sortable num" data-i18n="col.requests">Requests</th>
              <th data-sort="totalTokens" class="sortable num" data-i18n="col.tokens">Tokens</th>
              <th data-sort="spendCents" class="sortable num" data-i18n="col.spend">Spend</th>
              <th data-sort="reportedCostCents" class="sortable num" data-i18n="col.theoretical">Token cost</th>
              <th data-sort="poolSharePercent" class="sortable num" data-i18n="col.poolShare" title="% of pool">% of pool</th>
              <th data-sort="quotaPointsPercent" class="sortable num" data-i18n="col.poolQuota" title="Quota points">Quota points</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot></tfoot>
        </table>
      </div>
      <p id="breakdown-pool-note" class="muted small hidden"></p>
    </div>
  </section>
  </div>`;
}

function renderPoolsTabPanel(): string {
  return `<div id="tab-panel-pools" class="dashboard-tab-panel hidden" data-main-tab-panel="pools" role="tabpanel">
  <section class="chart-section" data-section="pool">
    <div class="chart-header">
      <div class="section-title-block">
        <h2 data-i18n="section.pool.title">Pool Usage</h2>
        <p class="muted" data-i18n="section.pool.desc">Daily First-party models and API pool consumption for the billing cycle</p>
      </div>
    </div>
    <div id="section-body-pool" class="section-body">
      <div class="chart-wrapper">
        <canvas id="pool-chart"></canvas>
      </div>
      <div class="pool-pace-header">
        <h3 data-i18n="pool.pace.title">Daily balance</h3>
        <p class="muted" data-i18n="pool.pace.desc">Positive bars = budget left that day; negative = overspend vs even spread until reset</p>
      </div>
      <div class="chart-wrapper chart-wrapper-compact">
        <canvas id="pool-pace-chart"></canvas>
      </div>
      <p id="pool-chart-note" class="muted small"></p>
    </div>
  </section>
  </div>`;
}

function renderPricingTabPanel(): string {
  return `<div id="tab-panel-pricing" class="dashboard-tab-panel hidden" data-main-tab-panel="pricing" role="tabpanel">
  <section class="pricing-section" data-section="pricing">
    <div class="events-header">
      <div class="section-title-block">
        <h2 data-i18n="section.pricing.title">Model Pricing</h2>
        <p class="muted small" data-i18n="section.pricing.desc">Official per-component rates and usage comparison</p>
      </div>
      <div class="pricing-header-meta">
        <span id="pricing-updated" class="muted small"></span>
        <span id="pricing-sync-badge" class="pricing-sync-badge hidden"></span>
        <button type="button" id="pricing-refresh-btn" class="pricing-refresh-btn" data-i18n="pricingRefreshFromCursor">Refresh from Cursor</button>
        <a id="pricing-source" class="pricing-source-link" href="https://cursor.com/docs/models-and-pricing" target="_blank" rel="noopener noreferrer" data-i18n="pricingSource">Official source</a>
        <span id="pricing-sync-status" class="muted small pricing-sync-status" role="status" aria-live="polite"></span>
        <span class="muted small" id="pricing-range-label"></span>
      </div>
    </div>
    <div id="section-body-pricing" class="section-body">
      <div id="pricing-runtime-alert" class="pricing-runtime-alert hidden" role="alert" aria-live="polite"></div>
      <div class="pricing-pool-banner">
        <div class="pricing-pool-card">
          <strong data-i18n="pricingPoolFirstParty">First-party models</strong>
          <p class="muted small" data-i18n="pricingPoolFirstPartyDesc">Auto, Composer 2.5, Cursor Grok — generous included usage</p>
        </div>
        <div class="pricing-pool-card">
          <strong data-i18n="pricingPoolApi">API pool</strong>
          <p class="muted small" data-i18n="pricingPoolApiDesc">Specific models billed at API rates from included or on-demand usage</p>
        </div>
        <div class="pricing-pool-card">
          <strong data-i18n="pricingPoolGrokBot">Grok Bot (weekly)</strong>
          <p class="muted small" data-i18n="pricingPoolGrokBotDesc">Separate weekly allowance; not counted against monthly Cursor Models / API pools</p>
        </div>
      </div>
      <p class="pricing-modes-note muted small" data-i18n="pricingModesNote">Reasoning/thinking usually keeps the same $/M rates but uses more tokens. Fast and Max Mode can change per-token rates — see the Modes table under each model.</p>
      <div class="pricing-toolbar">
        <input id="pricing-search" type="search" class="pricing-search" data-i18n-placeholder="pricingSearchPlaceholder" placeholder="Search models…">
        <label class="pricing-filter-label">
          <span data-i18n="pricingFilterProvider">Provider</span>
          <select id="pricing-provider-filter"></select>
        </label>
        <label class="pricing-filter-label">
          <span data-i18n="pricingFilterPool">Pool</span>
          <select id="pricing-pool-filter">
            <option value="all" data-i18n="pricingFilterAllPools">All pools</option>
            <option value="firstParty" data-i18n="pricingPoolFirstParty">First-party models</option>
            <option value="grokBot" data-i18n="pricingPoolGrokBot">Grok Bot (weekly)</option>
            <option value="api" data-i18n="pricingPoolApi">API</option>
          </select>
        </label>
        <label class="pricing-filter-label pricing-used-toggle">
          <input id="pricing-used-only" type="checkbox">
          <span data-i18n="pricingFilterUsedOnly">Only models I use</span>
        </label>
      </div>
      <div class="pricing-legend muted small">
        <span><span class="token-dot token-dot-input"></span> <span data-i18n="pricingInput">Input</span></span>
        <span><span class="token-dot token-dot-cache-write"></span> <span data-i18n="pricingCacheWrite">Cache write</span></span>
        <span><span class="token-dot token-dot-cache-read"></span> <span data-i18n="pricingCacheRead">Cache read</span></span>
        <span><span class="token-dot token-dot-output"></span> <span data-i18n="pricingOutput">Output</span></span>
      </div>
      <div class="table-scroll">
        <table id="pricing-table">
          <thead>
            <tr>
              <th data-sort="displayName" class="sortable" data-i18n="col.model">Model</th>
              <th data-sort="provider" class="sortable" data-i18n="pricingColProvider">Provider</th>
              <th data-sort="pool" class="sortable" data-i18n="pricingFilterPool">Pool</th>
              <th data-sort="rate.input" class="sortable num" data-i18n="pricingInput">Input</th>
              <th data-sort="rate.cacheWrite" class="sortable num" data-i18n="pricingCacheWrite">Cache W</th>
              <th data-sort="rate.cacheRead" class="sortable num" data-i18n="pricingCacheRead">Cache R</th>
              <th data-sort="rate.output" class="sortable num" data-i18n="pricingOutput">Output</th>
              <th data-sort="usageTokens" class="sortable num" data-i18n="col.tokens">Tokens</th>
              <th data-sort="usageSpend" class="sortable num" data-i18n="pricingColActual">Actual</th>
              <th class="num" data-i18n="pricingColTheoretical">Theoretical</th>
              <th class="num" data-i18n="pricingColDelta">Delta</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </section>
  </div>`;
}

function renderActivityTabPanel(): string {
  return `<div id="tab-panel-activity" class="dashboard-tab-panel hidden" data-main-tab-panel="activity" role="tabpanel">
  <section class="events-section" data-section="events">
    <div class="events-header">
      <div class="section-title-block">
        <h2 id="activity-section-title">Events</h2>
      </div>
      <div class="events-toolbar">
        <div class="activity-tabs" role="tablist" aria-label="Activity view">
          <button type="button" class="activity-tab active" data-activity-tab="events" role="tab" aria-selected="true" data-i18n="tab.events">Events</button>
          <button type="button" class="activity-tab" data-activity-tab="grokBot" role="tab" aria-selected="false" data-i18n="tab.grokBot">Grok Bot</button>
          <button type="button" class="activity-tab" data-activity-tab="conversations" role="tab" aria-selected="false" data-i18n="tab.conversations">Conversations</button>
        </div>
        <div class="events-toolbar-actions">
          <button id="conversation-preview-btn" type="button" class="preview-toggle hidden" aria-pressed="false" data-i18n="preview.titles">Fetch Titles (Preview)</button>
          <span id="preview-status" class="preview-status muted small hidden" aria-live="polite"></span>
          <button id="export-csv" type="button" data-i18n="export.csv">Export CSV</button>
        </div>
      </div>
    </div>
    <div id="section-body-events" class="section-body">
      <p id="archive-note" class="muted small hidden"></p>
      <div id="events-panel" class="activity-panel">
        <div class="table-scroll">
          <table id="events-table">
          <thead>
            <tr>
              <th data-sort="timestamp" class="sortable" data-i18n="col.date">Date</th>
              <th data-sort="kind" class="sortable" data-i18n="col.type">Type</th>
              <th data-sort="model" class="sortable" data-i18n="col.model">Model</th>
              <th data-sort="totalTokens" class="sortable num" data-i18n="col.tokens">Tokens</th>
              <th data-sort="requests" class="sortable num" data-i18n="col.requests">Requests</th>
              <th data-sort="spendCents" class="sortable num" data-i18n="col.spend">Spend</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="pagination" id="pagination"></div>
      </div>
      <div id="grok-events-panel" class="activity-panel hidden">
        <div class="table-scroll">
          <table id="grok-events-table">
          <thead>
            <tr>
              <th data-sort="timestamp" class="sortable" data-i18n="col.date">Date</th>
              <th data-sort="kind" class="sortable" data-i18n="col.type">Type</th>
              <th data-sort="model" class="sortable" data-i18n="col.model">Model</th>
              <th data-sort="totalTokens" class="sortable num" data-i18n="col.tokens">Tokens</th>
              <th data-sort="requests" class="sortable num" data-i18n="col.requests">Requests</th>
              <th data-sort="spendCents" class="sortable num" data-i18n="col.spend">Spend</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="pagination" id="grok-pagination"></div>
      </div>
      <div id="conversations-panel" class="activity-panel hidden">
        <div class="table-scroll">
          <table id="conversations-table">
            <thead>
              <tr>
                <th data-sort="label" class="sortable" data-i18n="col.conversation">Conversation</th>
                <th data-sort="lastTimestamp" class="sortable" data-i18n="col.lastActive">Last active</th>
                <th data-sort="models" class="sortable" data-i18n="col.models">Models</th>
                <th data-sort="eventCount" class="sortable num" data-i18n="col.calls">Calls</th>
                <th data-sort="totalTokens" class="sortable num" data-i18n="col.tokens">Tokens</th>
                <th data-sort="requests" class="sortable num" data-i18n="col.requests">Requests</th>
                <th data-sort="spendCents" class="sortable num" data-i18n="col.spend">Spend</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="pagination" id="conversations-pagination"></div>
      </div>
    </div>
  </section>
  </div>`;
}

function renderEventDetailOverlay(): string {
  return `<div id="event-detail-overlay" class="event-detail-overlay hidden">
    <div class="event-detail-panel" role="dialog" aria-modal="true" aria-labelledby="event-detail-title">
      <div class="event-detail-header">
        <div>
          <h2 id="event-detail-title" data-i18n="event.details">Event details</h2>
          <p id="event-detail-subtitle" class="muted small"></p>
        </div>
        <button id="event-detail-close" type="button" tabindex="-1" aria-label="Close event details" data-i18n-aria="closeEventDetails">×</button>
      </div>
      <div id="event-detail-body" class="event-detail-body"></div>
    </div>
  </div>`;
}
