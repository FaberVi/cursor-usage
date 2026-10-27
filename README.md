# Cursor Usage (Community)

Community-maintained fork of [cursor-metrics](https://github.com/wrick17/cursor-metrics). See Cursor usage in your status bar: included requests, Auto/API pool usage, and on-demand spend, live while you work. Click the status bar item to open a full dashboard inside your editor.

**Current release:** `1.0.6` — Pricing catalog sync (DeepSeek V4.1 Flash 1017, Opus 5/5.5 Fast rates, GPT-5.6 long-context notes; `lastUpdated` 2026-10-27). Requires **Cursor / VS Code 1.128+**.

![Cursor Usage extension tooltip](media/extensions-tooltip.png)

![Cursor Usage dashboard — Utilizzo](media/extensions-dashboard-usage.png)

![Cursor Usage dashboard — Pool](media/extensions-dashboard-pools.png)

![Cursor Usage dashboard — Prezzi](media/extensions-dashboard-pricing.png)

![Cursor Usage dashboard — Attività](media/extensions-dashboard-activity.png)

## What you get

### Status bar

- Compact display depends on your plan:
  - **Team / Enterprise (pool-based):** for example `61% Auto, 100% API, $12.50`
  - **Legacy personal (request-based):** for example `42/500, $0.00`
- On pool-based plans, Auto and API show how much of each included pool has been consumed (First-party vs third-party models).
- Detailed hover tooltip with progress bars, included pool breakdown (Auto/API), **daily budget** (allowance and residual for Auto/API today), reset countdown, and per-model usage.
- Loading indicator while fresh usage data is being fetched.
- Smart refresh behavior tied to editor activity and window focus.
- Optional minimal mode to show only the active metric.

### Dashboard

- **Summary cards** for on-demand spend and included pools (Auto / API / total). Legacy request-quota card appears only on older personal plans without pool data.
- **Included pool** (single card on pool-based plans):
  - Live Auto/API bars with **target usage** (even spread until reset) vs actual consumption and total pool %.
  - **Projected 100%** — estimated depletion date at the current average rate since cycle start.
  - **Daily budget** — allowance bar, residual or overspend vs even spread, and midnight UTC reset countdown.
- **Weekly Grok pool** summary card when your plan exposes it (shared Grok allowance; separate from monthly Auto/API pools).
- **Pool Usage section** (when pool data is available):
  - Cumulative Auto/API % line chart for the billing cycle.
  - **Daily balance** chart — positive bars = budget left that day; negative = overspend vs even spread.
- **Your Usage** — stacked per-day bar chart (spend, tokens, or requests) with range tabs and usage filters.
  - Chart tooltip lists per-model values for the hovered day, **pool share / quota points** (when included usage is shown), daily pool % footer, and a **total row for tokens** (plus summed spend) when the chart metric is tokens.
- **Usage by Model** — sortable breakdown table with chart-matched colors.
- **Events** — paginated, sortable event log with token breakdown modal and CSV export.
- **Language selector** (`EN` / `IT`) and **currency selector** (`USD` / `EUR`) in the header next to Refresh; choices are persisted.
- **Sticky main tabs:** **Usage**, **Pools**, **Pricing**, and **Activity** (events / conversations).
- **Pricing tab** with official per-component model rates, variant modes, token cost calculator, actual vs theoretical spend comparison, and pin/reorder for favorite models.
- Collapsible sections with persisted open/closed state.

Screenshots above use Italian (IT) and EUR; regenerate with `bun run screenshots` after `bun install`.

## Commands

- `Cursor Usage (Community): Open Dashboard` — open the in-editor dashboard.
- `Cursor Usage (Community): Show Details` — show a quick usage summary message.
- `Cursor Usage (Community): Refresh` — force a refresh immediately.
- `Cursor Usage (Community): Refresh Pricing Catalog` — fetch official model rates from Cursor docs and merge them into the local catalog.

## Settings

- `cursorUsage.pollInterval` (default: `5`) — minimum refresh cooldown in minutes (`1`, `5`, `10`, `30`, `60`).
- `cursorUsage.minimalMode` (default: `false`) — when included usage is exhausted (pool total on Team/Enterprise, or legacy request quota on older personal plans), show only on-demand spend in the status bar instead of the full summary.
- `cursorUsage.usageDuration` (default: `billingCycle`) — tooltip model-usage range: `1d`, `7d`, `30d`, or `billingCycle`.
- `cursorUsage.modelBreakdownSortBy` (default: `tokens`) — sort column for usage-by-model tables: `model`, `requests`, `tokens`, `spend`.
- `cursorUsage.modelBreakdownSortOrder` (default: `desc`) — `asc` or `desc`.
- `cursorUsage.excludeZeroTokenModels` (default: `false`) — hide model rows with zero tokens in the tooltip breakdown.
- `cursorUsage.quotaAwareEventDisplay` (default: `true`) — in the dashboard, show included usage as requests and on-demand usage as spend instead of raw charged cents on every row.

## Pool pacing (how to read it)

All pool pacing views are **indicative** — they assume an even spread of the 100% pool budget across the billing cycle:

| View | What it shows |
|------|----------------|
| **Daily budget** | Daily allowance and how much is still available today (or by how much you overshot it). Shown in the status bar tooltip and dashboard pool card. |
| **Target usage** | Where cumulative Auto/API usage *should* be today to reach reset without early depletion (dashboard pool card). |
| **Daily balance chart** | Per-day headroom (+) or overspend (−) relative to that even spread. |
| **Projected 100%** | When each pool would hit 100% if the average daily rate since cycle start continues. |
| **Chart tooltip pool %** | Auto and API pool percentage consumed on that specific day (footer). With metric **tokens**, the tooltip also shows a **Total** row summing tokens and spend for all models that day. |

Daily pool percentages are derived from included usage events (first-party catalog models such as Auto/`default`, Composer 2.5, and Cursor Grok → First-party pool; other models → API pool) and calibrated against the live totals from Cursor's usage API. **Grok Bot** rows (`grok-bot-default`, `grok-bot-automation`, `grok-bot-cua`) use a separate weekly allowance and are excluded from monthly pool pacing in this extension.

When your plan includes a weekly Grok allowance, the dashboard shows a **Weekly Grok pool** card from `POST /api/dashboard/get-sand-usage-status` (same meter as the Cursor spending UI). The status bar tooltip includes the weekly percentage when available (Italian UI: *quota settimanale consumata*).

## The X Subscription

[The X Subscription](https://cursor.com/help/the-x-subscription/overview) bundles Grok, Grok Bot, Cursor, and X Premium benefits in one plan (optional migration for existing Cursor / SuperGrok / X Premium customers via [cursor.com/unify](https://cursor.com/unify)). **X Premium alone does not include Cursor** until you switch to The X Subscription.

What this extension reflects today:

- **Monthly Auto / API pools** — still from Cursor `usage-summary` (billing-cycle pacing, charts, status bar).
- **Weekly Grok pool** — from `get-sand-usage-status` when Cursor exposes it; copy in the dashboard describes the shared weekly allowance described in Cursor’s help (Grok apps, Grok Bot, Grok models in Cursor). This extension does **not** read X billing, prepaid balance on grok.com, or third-party model credits.
- **Plan banner** — when Cursor reports an X Subscription–style `membershipType` slug (e.g. hypothetical `x_premium`), the dashboard shows **The X Subscription** labeling and a link to Cursor help. Slugs are best-effort until verified with `bun scripts/probe-cursor-api.ts` on a migrated account.

Third-party models (Claude, GPT, etc.) in Cursor are **not** part of the included weekly Grok pool on The X Subscription; they bill at API list prices through prepaid/top-up credits per [Cursor help](https://cursor.com/help/the-x-subscription/overview).

## Privacy and behavior

- No manual API key setup required.
- Uses your existing signed-in Cursor session locally.
- Fetches on activity (editing/focus) instead of constant polling.
- Manual **Refresh** updates usage quickly, then syncs older dashboard events in the background when needed.
- Caches auth and API responses to avoid redundant requests.

## Quality

- Tests: `bun test --isolate` (VS Code API preloaded via `bunfig.toml`).
- CI on push/PR: install, test, production build, and verify `media/dashboard/dashboard.js` matches sources.

## Development

### Prerequisites

- [Bun](https://bun.sh/) 1.x
- [Cursor](https://cursor.com/) or [VS Code](https://code.visualstudio.com/) **1.128+** (`engines.vscode` in `package.json`; matches current Cursor builds, e.g. 3.21 on VS Code API 1.128)
- For packaging and publishing: network access (Chart.js download, `@vscode/vsce`, `ovsx` via `bunx`)

### Clone and install

```bash
git clone https://github.com/FaberVi/cursor-usage.git
cd cursor-usage
bun install
```

### Local development

```bash
bun run watch      # rebuild extension + dashboard on file changes
bun run build      # one-off production build
bun test --isolate  # run tests
```

Press **F5** in VS Code/Cursor with the **Run Cursor Usage Extension** launch config to debug in an Extension Development Host.

The production build:

1. Downloads Chart.js into `media/dashboard/chart.umd.js`
2. Bundles `src/extension.ts` → `dist/extension.js`
3. Bundles the dashboard entry → `media/dashboard/dashboard.js`

### Build a VSIX locally

The extension is published under two package IDs on different marketplaces:

| Marketplace | Package ID | VSIX filename | Script |
|-------------|------------|---------------|--------|
| [Open VSX](https://open-vsx.org/) | `cursor-usage` | `build/cursor-usage-<version>.vsix` | `bun run package` |
| [Visual Studio Marketplace](https://marketplace.visualstudio.com/) | `cursor-usage-auto` | `build/cursor-usage-auto-<version>.vsix` | `bun run package:vsm` |

The VS Marketplace build stages a copy of the extension with `name: cursor-usage-auto` (see `scripts/prepare-vsm-package.mjs`) so it can coexist with the original upstream listing.

Create the Open VSX artifact:

```bash
bun run package
```

Create the Visual Studio Marketplace artifact:

```bash
bun run package:vsm
```

Install a VSIX locally for smoke testing:

```bash
# Cursor
cursor --install-extension build/cursor-usage-<version>.vsix

# VS Code
code --install-extension build/cursor-usage-<version>.vsix
```

Replace `<version>` with the value in `package.json` (e.g. `1.0.5`).

### Publish to marketplaces

Publisher: **[fabervi](https://marketplace.visualstudio.com/publishers/fabervi)**

#### Before each release

1. Bump `version` in `package.json`
2. Add a dated entry to `CHANGELOG.md`
3. Run `bun test --isolate`
4. Build both VSIX files and smoke-test at least one of them locally
5. Set the publish tokens (see below)

#### Open VSX

1. Create an account on [open-vsx.org](https://open-vsx.org/)
2. Generate a personal access token
3. Set `OPEN_VSX_TOKEN` in your environment

**PowerShell (Windows):**

```powershell
$env:OPEN_VSX_TOKEN = "your-open-vsx-token"
bun run package
bun run publish:ovsx
```

**bash (macOS / Linux / Git Bash):**

```bash
export OPEN_VSX_TOKEN="your-open-vsx-token"
bun run package
bun run publish:ovsx
```

#### Visual Studio Marketplace

1. Create or use the [fabervi](https://marketplace.visualstudio.com/publishers/fabervi) publisher on the Visual Studio Marketplace
2. Create an Azure DevOps [Personal Access Token](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) with **Marketplace > Manage** scope
3. Set `VSCE_PAT` in your environment

**PowerShell (Windows):**

```powershell
$env:VSCE_PAT = "your-vsce-pat"
bun run publish:vsm
```

**bash:**

```bash
export VSCE_PAT="your-vsce-pat"
bun run publish:vsm
```

`publish:vsm` runs `package:vsm` first, then uploads `build/cursor-usage-auto-<version>.vsix`.

#### Full release (both stores)

With both tokens set:

```bash
bun run release
```

This runs, in order: `package` → `publish:ovsx` → `publish:vsm` (package + publish for VS Marketplace).

#### Manual publish (alternative)

If you prefer not to use the npm scripts:

```bash
bunx @vscode/vsce publish --packagePath build/cursor-usage-auto-<version>.vsix -p "$VSCE_PAT"
bunx ovsx publish build/cursor-usage-<version>.vsix -p "$OPEN_VSX_TOKEN"
```

## Authors & maintainers

- **Created by** [wrick17](https://github.com/wrick17) — original extension and [cursor-metrics](https://github.com/wrick17/cursor-metrics) repository.
- **Maintained by** [Vincenzo Fabiano (FaberVi)](https://github.com/FaberVi) — community fork ([cursor-usage](https://github.com/FaberVi/cursor-usage)), pool analytics, Grok Bot weekly meter, dashboard i18n, pacing projections, and ongoing improvements. Published on the VS Marketplace as [fabervi](https://marketplace.visualstudio.com/publishers/fabervi).

## License

MIT
