export const CARD_HELP = {
  includedRequests:
    "Legacy request quota for older personal plans. Current Cursor plans bill against separate First-party models and API pools instead.",
  onDemand:
    "Usage billed beyond your included pools when usage-based pricing is enabled. Spend is charged to your payment method; on team accounts an admin may set a hard limit.",
  includedPool:
    "Share of your included usage pools for the billing cycle. First-party models covers Cursor-built models (Auto, Composer, Cursor Grok); API covers models you choose from other providers. Total is the combined pool consumption.",
  poolDepletion:
    "Estimated date each pool reaches 100% based on average daily consumption since the billing cycle started. If usage stays at the same rate, this is when the pool would run out before reset.",
  poolPace:
    "Indicative daily budget to spread pool usage evenly until billing reset. Residual shows how much you could still use today; a negative value means you exceeded today's budget. The daily budget renews at midnight UTC; the countdown shows hours and minutes until then.",
  billingCycle:
    "Days remaining in your current billing cycle and how much of the cycle has elapsed. Pool quotas and on-demand limits reset on the date shown.",
  grokBotWeekly:
    "Weekly included Grok usage shared across Grok, Grok Bot, and Grok models in Cursor (The X Subscription). Resets every week and is separate from monthly First-party / API pools. Third-party models in Cursor are not included. Details: https://cursor.com/help/the-x-subscription/overview",
} as const;

export type CardHelpKey = keyof typeof CARD_HELP;
