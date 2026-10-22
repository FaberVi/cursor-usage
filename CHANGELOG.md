# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.0.5] - 2026-10-22

### Added
- Plan labels for hypothetical The X Subscription membership slugs (`x_plus`, `x_premium`, …) with `billingProgram: x_subscription` and dashboard plan-banner link to Cursor help.
- **Grok Bot** activity tab and a breakdown chip to show or hide `grok-bot*` models in usage-by-model.
- Dashboard error and warning banners with an **info** control for technical `detail` (not only generic copy).

### Changed
- Refresh loading stays aligned between the dashboard spinner and the status bar for the full `updateUsage` cycle, including background event-history sync.
- Weekly Grok card, pricing pool copy, and card help describe the **shared weekly Grok pool** (The X Subscription) vs monthly First-party / API pools; status bar tooltip title renamed; third-party models noted as excluded from that pool.
- README: new **The X Subscription** section (limits of this extension, unify link).
- Bundled pricing catalog synced from [Cursor models & pricing](https://cursor.com/docs/models-and-pricing) (`lastUpdated` `2026-10-22`): Grok 4.7 500k, Gemini 3.5 Flash Lite, Gemini 4 Argon, Muse Wonder, and third-party rate updates (e.g. Claude Opus 5.5, GPT-5.4 family).
- Pricing docs sync reads the **Cursor models** table under Included usage and recognizes **Third-party models** plan columns.
- Day-level pool share in the breakdown uses the full billing-cycle bucket as the denominator.
- Runtime dependency: `sql.js` **1.15.1** (packaged in the VSIX).

### Fixed
- Usage refresh and event-store sync no longer leave a false partial-sync warning after a background history catch-up completes.

## [1.0.4] - 2026-10-12

### Added
- Pricing catalog entries for Claude Haiku 5.5, Claude Sonnet 5.5, GLM 5.3, and GLM 5.3 Flash (`lastUpdated` `2026-10-12`).

### Changed
- Claude Sonnet 5 is hidden by default. Claude Opus 5.5 notes include the higher US-only endpoint rates.
- Chart tooltip “% of pool” for one day is that model’s included spend that day divided by the billing-cycle total of its bucket (First-party or API). Quota points are unchanged.
- Dev dependencies: `@types/node` 26.6.5, Playwright 1.64, Puppeteer 25.13.

### Fixed
- A short or empty usage-events page is no longer treated as a complete sync when `totalUsageEventsCount` says more events remain. The 120-day archive is not replaced by a shorter snapshot unless that total is fully covered, so a later refresh does not shrink a day’s stored tokens.
- The partial event-sync warning no longer stays on after the quick page-capped fetch. One background history sync runs when that fetch is short; the warning remains only if the longer sync still hits the page cap.

## [1.0.0] - 2026-09-04

First stable community release after three corrective audit waves: resilient API fetch, team-aware usage routing, page-wise conversation DB reads, dashboard i18n/UX hardening, and CI.

### Added
- GitHub Actions CI: `bun test --isolate`, production build, and committed `dashboard.js` freshness check (Bun 1.4.0).
- `matchesTeamMember` helper (`email`, `authId`, `userId`) and tests for team usage fetch paths.
- Page-wise btree reader for conversation titles/messages (prefix scan, WAL, overflow payloads).
- `isSafeConversationId` validation and CSP/nonce dashboard security tests.
- Shared `startOfUtcDay` (`src/utc-day.ts`); `test/usage-fetch-core.spec.ts` and extended conversation btree tests.

### Changed
- Grok 4.5 Fast output rate is **$18**/M (official docs); bundled catalog `lastUpdated` is `2026-09-03`.
- Pricing overlay from docs still updates rates/notes only — **aliases and Fast variants stay bundled** (Grok 4.5 Fast `$18` is the source of truth until a later parser change).
- Bundled catalog also picks up Claude Fable 5.1, Gemini 3.7/3.8 Flash, Claude Sonnet 5 rate cuts (promo variant removed), GPT-5.6 Sol, and Claude Opus 4.7 Fast output `$10`.
- Usage chart offers spend / tokens / requests (the 0.8.0 note that the chart always shows tokens is outdated).
- Fetch paths tolerate non-JSON error bodies; incomplete setup is not cached; non-force refreshes queue instead of dropping; concurrent force refreshes coalesce to one replay.
- Setup without Stripe is not cached as a personal plan; conversation titles/messages read Cursor `state.vscdb` page-wise instead of loading the whole file.
- Team usage matches members by `authId`, skips the usage-summary fast-path for team members, and copies pool % from summary while included requests come from `get-team-spend`.
- Dashboard: residual i18n (reset countdown, pool pace, `Auto` label), `usageFilter` refreshes conversations, kind/pool CSS allowlists, shared `formatRateUsd`, pinned-model cap (50 ids).
- Event-store persistence via temp file + atomic rename; pricing docs fetch uses the same 15s timeout as other API calls.

### Removed
- Dead `cursor-state-db.ts` sql.js reader (superseded by btree KV reader for conversations).

## [0.8.1] - 2026-08-13

### Added
- **Cursor Grok 4.6** (and Fast) in the first-party pricing catalog and pool classification.

### Changed
- Composer 2.5 Fast and Grok 4.5 Fast use official **customRates** ($3/$15 and $4/$12 per 1M) instead of same-rate-more-tokens.
- Pricing catalog sync parses the **Cursor Models** docs table (in addition to Other Models).
- GPT-5.6 Luna / Terra rates and Gemini 3.5 Flash `hidden` flag aligned with [cursor.com/docs/models-and-pricing](https://cursor.com/docs/models-and-pricing).

## [0.8.0] - 2026-07-20

### Changed
- Pool label **Auto** → **First-party models** (IT: *Modelli first-party*) across status bar, tooltip, dashboard, and help text — aligned with Cursor billing wording.
- Grok catalog display name → **Cursor Grok 4.5**.
- Dashboard usage chart always shows daily **tokens**; the usage filter (All / Included / On-Demand) moved to **Usage by model** and applies to chart, breakdown, and pricing usage columns.
- Pricing tab layout: full-width dashboard body, model names and badges kept on one line.

### Fixed
- Hide on-demand credit in status bar, tooltip, and dashboard when on-demand usage is disabled (no more `0,00 €/0,00 €` with state `limited`).
- First-party pool series and breakdown: classify Auto / Composer / Cursor Grok via pricing catalog `pool: "firstParty"` instead of only `model === "default"`.
- Billing-cycle cutoff: month overflow and local-timezone edge cases at end of month (`getBillingCycleCutoff` / `shiftUtcMonth`).
- Recommended pool usage target now uses a wall-clock denominator so it reaches 100% at reset.
- Dashboard daily budget bar normalizes `used/allowance` correctly.
- Pool usage series: uniform fallback shape when live pool % is > 0 but spend events are empty.
- Screenshot preview / tooltip HTML for html-validate (void elements, no inline styles, overlay focusability).
- **Request counts** for token-metered events: charts and tables count one call per event instead of surfacing API `requestsCosts` or polluted archive values.
- **Theoretical cost** for effort/thinking model slugs (e.g. `-fast`, `-thinking-high`) via expanded pricing alias resolution.
- Event archive deduplication after request normalization (fingerprint no longer depends on derived `requests` field; one-time store migration).

## [0.7.1] - 2026-07-14

### Added
- **Daily budget reset countdown** in the dashboard pool card and status-bar tooltip — shows time until the daily allowance renews at midnight UTC (with local reset time).
- **Pin models** in the Pricing tab: star/unstar models to keep them at the top of the catalog; pin order and selection persist across dashboard sessions via extension global state.
- **Drag-and-drop reorder** for pinned pricing models (⋮⋮ handle on pinned rows).
- Screenshot generation scripts (`scripts/build-screenshot-previews.mjs`, `scripts/capture-screenshots.mjs`) and `bun run screenshots` for README/marketplace assets.

### Changed
- README screenshots updated to reflect the current dashboard (Usage, Pools, Pricing, Activity tabs) and status-bar tooltip.
- Italian pricing catalog labels and variant notes via `pricing-catalog-i18n.js`.

### Fixed
- Spacing above the expanded “Modes & pricing impact” panel in the Pricing tab.

## [0.7.0] - 2026-07-13

### Added
- Dashboard **Pricing** tab with official per-component model rates sourced from `model-pricing.json`, including First-party vs API pool badges and provider filters.
- Model pricing catalog with variant modes (thinking, fast, max context), alias resolution, and per-model token cost calculator.
- Actual vs theoretical spend comparison and delta per model for the active dashboard range.
- Deep link from event detail and model breakdown into the matching pricing catalog row.
- Sticky dashboard main tabs: **Usage**, **Pools**, **Pricing**, and **Activity** (events / conversations).
- `src/model-pricing.ts` for catalog loading, variant-aware rate resolution, component cost estimation, and usage aggregation.
- `src/dashboard/dashboard-html.ts` to generate dashboard markup from the extension host.
- Cross-platform packaging and publish scripts (`scripts/package-extension.mjs`, `scripts/publish-extension.mjs`) using Bun instead of shell-only `vsce`/`ovsx` invocations.
- Split dashboard i18n into `en.js` / `it.js` locale bundles plus `pricing-catalog-i18n.js` for Italian variant labels and notes.
- Tests for model pricing catalog validation, alias/variant resolution, and theoretical cost estimation.

### Changed
- Decomposed monolithic `extension.ts`, `on-demand.ts`, `cursor-usage-fetch.ts`, and dashboard modules into smaller host and webview files for maintainability.
- Split dashboard CSS into layout, summary, events, and pricing stylesheets; refactored summary and tables into focused JS modules.
- Expanded README with Bun prerequisites, local VSIX build steps, and Open VSX / Visual Studio Marketplace publish workflow (including Windows PowerShell examples).
- Simplified `package.json` release scripts to delegate build, package, and publish to the new Bun scripts.

### Fixed
- Complete Italian localization for the pricing section UI, variant descriptions, and token component labels.
- Vertical spacing of the expanded “Modes & pricing impact” panel under each model row.

## [0.6.0] - 2026-07-08

### Changed
- Community fork rebranded as **Cursor Usage (Community)** for publication under publisher `fabervi`.
- Status bar, tooltip, and dashboard no longer show the legacy `used/limit` request counter when Cursor exposes pool usage (First-party Auto + API pools), matching current Cursor billing for Team, Enterprise, and modern personal plans.
- `minimalMode` now treats total pool exhaustion as the trigger on pool-based plans.
- Help text updated to describe the two-pool billing model instead of deprecated premium-request quotas.
- On-demand usage now uses `GetCurrentPeriodUsage` for accurate pooled/individual limits (integrated from cozminv fork).
- Stacked chart bars no longer use rounded corners on intermediate segments.

### Added
- `shouldShowPremiumRequestsQuota()` and `isIncludedQuotaExhausted()` helpers in `src/usage-display.ts`.
- Tests for pool-based vs legacy personal display rules.
- On-demand module (`src/on-demand.ts`) with team pool breakdown, spend-limit API parsing, and segmented progress bars.
- Dashboard UI preferences persistence (`range`, `usageFilter`, `metric`) across sessions.
- Totals row in Usage by Model table (dashboard and tooltip).

## [0.5.19] - 2026-07-08

### Changed
- Status bar, tooltip, and dashboard no longer show the legacy `used/limit` request counter when Cursor exposes pool usage (First-party Auto + API pools), matching current Cursor billing for Team, Enterprise, and modern personal plans.
- `minimalMode` now treats total pool exhaustion as the trigger on pool-based plans.
- Help text updated to describe the two-pool billing model instead of deprecated premium-request quotas.

### Added
- `shouldShowPremiumRequestsQuota()` and `isIncludedQuotaExhausted()` helpers in `src/usage-display.ts`.
- Tests for pool-based vs legacy personal display rules.

## [0.5.18] - 2026-05-07

### Added
- Local SQLite archive for usage events (120-day lookback) with incremental sync from the Cursor API.
- Dashboard **Conversations** tab with optional title preview and message detail loaded from the Cursor state database.
- Italian/English language selector and USD/EUR currency display across dashboard, status bar, and tooltip.
- `cursorUsage.quotaAwareEventDisplay` to control whether dashboard events show included usage as requests and on-demand usage as spend.

### Changed
- Refactored Cursor API layer and dashboard frontend into smaller modules.
- Conversation aggregation and spend totals now share one implementation between host and webview.
- Dashboard webview receives usage events filtered to the active range/filter to reduce payload size.

### Fixed
- Dashboard events, chart spend, model breakdown spend, and CSV export now treat included premium-request usage as request quota usage by default instead of on-demand spend.
- Conversation message loading and DB reads surface errors instead of hanging on failure.
- Event deduplication fingerprint now covers full billing metadata to avoid silently dropping distinct events.

## [0.5.15] - 2026-05-07

### Added
- Dashboard sections (Your Usage, Usage by Model, Events) are now collapsible. Section state is persisted across reloads.
- Dark mode support for the dashboard's filter dropdowns (Usage, Metric, sort selectors) so they match the rest of the themed UI in dark VS Code themes.

### Changed
- Replaced the unicode collapse glyphs with a 16×16 SVG chevron that uses `currentColor` and rotates 90° when a section is collapsed. Toggle hitbox enlarged from 14×14 to 20×20 for easier clicking.

## [0.5.12] - 2026-05-07

### Fixed
- Read Cursor auth tokens directly from `state.vscdb` without requiring a `sqlite3` CLI on PATH, native SQLite bindings, or platform-specific binaries.
- Support Cursor databases using WAL mode so freshly written auth values are visible.
- Avoid loading multi-GB Cursor databases into memory by traversing the SQLite table B-tree and reading only the auth rows needed.
- Harden dashboard CSV export against spreadsheet formula injection.
- Escape model names in trusted tooltip HTML and restrict trusted Markdown commands to known extension commands.
- Add request timeouts and a pagination cap for Cursor API fetches so refreshes cannot hang indefinitely.

## [0.5.11] - 2026-04-29

### Fixed
- Dashboard chart axis labels, gridlines, and legend text are now visible in light themes. VS Code webviews don't honor `prefers-color-scheme`, so light tokens are now applied via the `body.vscode-light` / `body.vscode-high-contrast-light` selectors that VS Code sets on the webview body.
- Chart tooltip uses themed surface, border, and foreground tokens instead of hardcoded dark colors so it remains readable in light themes.

## [0.5.10] - 2026-04-29

### Changed
- README now includes a screenshot of the in-editor dashboard alongside the existing tooltip screenshot, and lists the new `Cursor Usage: Open Dashboard` command.

## [0.5.7] - 2026-04-29

### Added
- Dashboard now has a `Usage by Model` section between the chart and the events table, with sortable Model / Requests / Tokens / Spend columns. Each row reuses the chart's color tinting so it visually maps to the chart series.
- Chart tooltip is now a real HTML table with a header row, a colored model dot, and a per-row Spend column when viewing Tokens or Requests.

### Changed
- Constrained dashboard content to a 1000px max width for readability on wide monitors.
- Centered the chart legend.
- When the `Current Billing Cycle` range is selected, the chart's x-axis now extends through the last day of the cycle so the full span is visible even before later days have data.
- Y-axis tick labels drop the trailing `.0` (`60M` instead of `60.0M`).
- Events table rows are tinted with the model color and gain a 3px left accent border, replacing the previous inline dot.
- Refined the `MAX` badge to match Cursor's gradient text treatment (purple → pink → peach).

## [0.5.2] - 2026-04-29

### Added
- Dashboard events table now shows a per-event Spend column (sortable, in USD).
- Chart tooltip now appends each model's spend on that day alongside the selected metric value when viewing Tokens or Requests.

## [0.5.1] - 2026-04-29

### Fixed
- VS Marketplace package now includes the `media/` directory so the dashboard webview's CSS, JavaScript, and bundled Chart.js load correctly. Previous 0.5.0 build shipped only `dist/` and `test/`, leaving the dashboard unstyled and non-interactive on VSCode.

## [0.5.0] - 2026-04-29

### Added
- New `cursor-usage.openDashboard` command opens a full Cursor Usage dashboard in a VSCode editor tab.
- Dashboard renders Included-Request and On-Demand summary cards, a stacked bar chart of per-day usage, and a sortable Events table with Export CSV.
- Range tabs (Last 24 hours / Last 7 days / Last 30 days / Current Billing Cycle) match the `cursorUsage.usageDuration` setting labels.
- Chart filters for Usage (All / Included / On-Demand) and Metric (Spend / Tokens / Requests); per-event spend now derives from `chargedCents` so Spend works for solo and team accounts.
- Events table shows `MAX` mode badges and a colored model dot that matches the chart palette.

### Changed
- Status-bar click now opens the new dashboard instead of the inline message dialog.
- Tooltip "Open Dashboard" link and the no-data warning's "Open Dashboard" action now route to the new in-VSCode dashboard.
- Dashboard polling reuses the existing `cursorUsage.pollInterval` cadence; the dashboard auto-updates whenever the host fetches new data.
- Usage events now parse `requestsCosts` (fractional) and string timestamps from the Cursor API; popup table rounds requests to integers.
- Theme refresh: shadcn-style dark surface, soft pastel chart palette, rounded top corners on the topmost stack segment.

## [0.4.11] - 2026-04-23

### Added
- Added `cursorUsage.excludeZeroTokenModels` to hide usage-by-model rows where token usage is zero.

### Changed
- Updated tooltip rendering to apply zero-token model filtering when the setting is enabled.
- Added tests covering filter behavior and configuration exposure.

## [0.4.10] - 2026-04-23

### Added
- Added `cursorUsage.modelBreakdownSortBy` to choose the usage-by-model table sort column (`Model`, `Requests`, `Tokens`, `Spend`).
- Added `cursorUsage.modelBreakdownSortOrder` to choose ascending or descending table order.

### Changed
- Updated usage-by-model aggregation to apply configured column/direction sorting, defaulting to `Tokens` descending.
- Added test coverage for new sort settings and ordering behavior.

## [0.4.9] - 2026-04-21

### Changed
- Simplified and decluttered the README for extension marketplace readability.
- Added a screenshot preview near the top of the README so the extension page shows the UI tooltip.
- Removed publishing and release-process documentation from the README.

## [0.4.8] - 2026-04-20

### Changed
- Added separate Open VSX and Visual Studio Marketplace packaging flows, including a Marketplace-specific package id of `cursor-usage-auto`.
- Documented the `wrick17` publisher setup, token requirements, and release commands for both marketplaces.
- Excluded generated build assets and helper scripts from packaged VSIX artifacts and local Bun test discovery.

## [0.4.7] - 2026-04-20

### Changed
- Moved usage-duration selection back into `cursorUsage.usageDuration` in Settings and made `Current Billing Cycle` the default.
- Restored the tooltip `Change` action and routed it to the `cursorUsage.usageDuration` setting.
- Added a friendly `Current Billing Cycle` label in the settings dropdown while still falling back to `30d` when billing reset metadata is unavailable.

## [0.4.6] - 2026-04-20

### Changed
- Backfilled changelog entries for every release from `0.1.0` through `0.4.5`.
- Added the missing `0.4.4` changelog entry based on git history.

## [0.4.5] - 2026-04-20

### Added
- Added a `Current Billing Cycle` range option in the tooltip range picker when reset metadata is available.
- Added duration option helpers and tests covering picker visibility and fallback behavior.

### Changed
- Switched range selection from settings navigation to an in-tooltip QuickPick command.
- Persisted selected range in extension global state while still seeding from the legacy `cursorUsage.usageDuration` setting.
- Updated usage aggregation to support billing-cycle cutoffs derived from `resetsAt`.
- Expanded usage event and daily spend fetch windows from 30 to 31 days to cover longer billing cycles.
- Updated README to describe the new picker flow and legacy-setting migration behavior.

## [0.4.4] - 2026-04-20

### Added
- Added a per-model spend breakdown to the tooltip.

## [0.4.3] - 2026-04-15

### Added
- Added limited on-demand spend cap details to the tooltip.

## [0.4.2] - 2026-03-26

### Changed
- Polished the usage tooltip layout.

## [0.4.1] - 2026-03-16

### Changed
- Aligned dashboard usage mapping with tooltip totals and unlimited spend display.
- Routed packaged VSIX artifacts to the `build/` directory for packaging and release workflows.

## [0.4.0] - 2026-02-26

### Added
- Added a per-model usage breakdown in the tooltip.
- Added a `cursorUsage.usageDuration` setting to control the usage breakdown time range.

### Changed
- Reworked the tooltip into a side-by-side layout for usage details.

## [0.3.3] - 2026-02-26

### Changed
- Made progress bars theme-aware for light and dark modes.

## [0.3.2] - 2026-02-25

### Added
- Added an extension icon.

## [0.3.1] - 2026-02-25

### Changed
- Updated README to reflect the current feature set, settings, and smart polling behavior.

## [0.3.0] - 2026-02-25

### Added
- Added SVG progress bars in the tooltip.
- Added a loading spinner and reset countdown state.

### Changed
- Introduced smart polling behavior for usage refreshes.

## [0.2.1] - 2026-02-25

### Changed
- Reduced API calls by caching setup data and reading the account email from the local database.

## [0.2.0] - 2026-02-25

### Added
- Added `cursorUsage.pollInterval` configuration for refresh cadence.
- Added `cursorUsage.minimalMode` configuration for a simplified status bar display.

### Changed
- Refined the status bar to adapt to the new polling and minimal-display preferences.

## [0.1.1] - 2026-02-25

### Added
- Added dashboard and manual refresh actions to the extension tooltip.

### Changed
- Updated package metadata with the new publisher, license, and repository details.
- Reworked the release script to package the extension and publish using the current version from `package.json`.
- Revised README installation and usage guidance.

## [0.1.0] - 2026-02-25

### Added
- Initial release of the extension.
- Added the renamed `cursor-usage` project structure and extension scaffolding.

### Changed
- Refactored the project layout, build pipeline, and ignore files for extension development.
- Updated scripts and execution permissions to support the renamed project.
