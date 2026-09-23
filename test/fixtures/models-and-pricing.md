# Models & Pricing

## Cursor Models

The Cursor Models pool includes Cursor Grok 4.7, Grok 4.6, Grok 4.5, and Composer 2.5.

| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| ----------------------------------------------------------- | -------- | ----- | ----------- | ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| Grok 4.7 | Cursor | $2 | - | $0.5 | $6 | Jointly trained by Cursor and SpaceXAI |
| Grok 4.6 | Cursor | $2 | - | $0.5 | $6 | Jointly trained by Cursor and SpaceXAI |
| Grok 4.6 (Fast) | Cursor | $4 | - | $1 | $12 | Jointly trained by Cursor and SpaceXAI |
| Grok 4.5 | Cursor | $2 | - | $0.5 | $6 | Jointly trained by Cursor and SpaceXAI |
| [Composer 2.5](https://cursor.com/blog/composer-2-5) | Cursor | $0.5 | - | $0.2 | $2.5 | - |

### Model pricing

All prices are per million tokens:

| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --------------------------------------------------------------------------------------------- | --------- | ----- | ----------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude Opus 5](https://www.anthropic.com/claude/opus) | Anthropic | $5 | $6.25 | $0.5 | $25 | Requires Max Mode on legacy request-based plans |
| [Claude Fable 5.1](https://www.anthropic.com/claude) | Anthropic | $10 | $12.5 | $0.25 | $50 | Requires data retention approval |
| [Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs) | Google | $1.5 | - | $0.15 | $7.5 | - |
| [Gemini 3.7 Flash](https://ai.google.dev/gemini-api/docs) | Google | $0.75 | - | $0.075 | $3.5 | Hidden by default |
| [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs) | Google | $0.75 | - | $0.075 | $3.5 | - |
| [Kimi K3](https://www.moonshot.ai) | Moonshot | $3 | - | $0.3 | $15 | Hidden by default |
| [Future Model X](https://example.com) | Example | $9 | - | $0.9 | $45 | Hidden by default |

## Plans

| Plan | Price | Cursor Models | Other Models |
| --- | --- | --- | --- |
| Start (India only) | ₹649/mo, tax inclusive | Included | Not included |
| Pro | $20/mo | Included | Included |
| Pro Plus | $60/mo | Included | Included |

## Cursor Token Rate

On Teams and Enterprise plans, third-party model requests include a Cursor Token Rate of $0.25 per million tokens.
