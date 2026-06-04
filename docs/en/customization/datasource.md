# Kimi Datasource

Kimi Datasource is the official Kimi Code data plugin. It lets you query financial market data, macroeconomic indicators, corporate registration records, and academic literature in natural language — no manual API calls or data account registration required.

**Prerequisite**: You must complete OAuth login with a Kimi Code account via `/login`. The plugin relies on local credentials to access data services.

## Installation

1. Run `/plugins` inside Kimi Code CLI
2. Select **Marketplace** from the menu that appears
3. Find **Kimi Datasource** and choose to install it
4. After installation completes, run `/new` to start a new session — the plugin is ready to use

## Financial Data

### Stock & Global Market Quotes

| Feature | Description | Markets |
|---|---|---|
| Real-time quotes | Current price, change %, intraday data | A-shares, HK, US |
| Historical prices | Historical closing prices and price-change ranges | A-shares, HK, US, and major global markets |
| Technical indicators | MACD, KDJ, RSI, BOLL, MA — with bullish/bearish signals | A-shares only |
| Financial statements | Balance sheets, year-over-year financial data | A-shares, HK, US, and major global markets |
| Company fundamentals | Business overview, shareholder information | A-shares, HK, US, and major global markets |
| Stock screening | Filter by sector, market cap, price change, financial metrics, and more | A-shares, HK, US |
| Market indices | CSI 300, SSE, S&P 500, Nasdaq, Nikkei, and more | A-shares, major global markets |
| Watchlist management | Track holdings, calculate P&L based on cost basis | A-shares, HK, US |

### Macroeconomic Data

Powered by the **World Bank** Open Data API — **189 member countries, 50+ years** of historical time series covering GDP, trade, population, poverty, education, climate, and dozens of other indicators. Great for cross-country comparisons, policy research, and data-driven analysis.

| Feature | Description |
|---|---|
| Core macro indicators | GDP, CPI, trade volume, unemployment, external debt, etc. |
| Long-run historical data | Up to 50+ years of data per country |
| Cross-country comparison | Compare any indicator across multiple countries |
| Thematic datasets | Poverty rates, education enrollment, CO₂ emissions, energy mix, demographics, and more |

::: details Historical price query

```text
What was Apple's (AAPL) highest and lowest closing price in Q4 2025?
```

:::

::: details Financial statement analysis

```text
What are the key figures in Microsoft's 2024 annual balance sheet — total assets, liabilities, and equity?
```

:::

::: details Company fundamentals

```text
What are NVIDIA's main business segments and who are its largest institutional shareholders?
```

:::

::: details Stock screening

```text
In the US semiconductor sector, find stocks with market cap above $500B and list their names and current market caps.
```

:::

::: details Global market overview

```text
How are the S&P 500, Nasdaq, and Nikkei 225 performing today? Any notable sector moves?
```

:::

::: details Macroeconomic comparison

```text
Compare GDP growth rates and GDP per capita trends for China, India, and Vietnam over the past 20 years.
```

:::

::: details Thematic data research

```text
Show CO₂ emissions trends for major economies over the past decade, alongside their renewable energy share.
```

:::

## Corporate Data

Covers business registration, equity structure, and legal risk information for mainland Chinese companies — helping you quickly get first-hand data when signing contracts, conducting due diligence, or vetting partners.

| Feature | Description |
|---|---|
| Business registration | Registered capital, founding date, legal representative, business scope, headcount |
| Equity structure | Shareholder contribution ratios, external investments, ultimate beneficial owner |
| Legal risk | Litigation disputes, credit blacklist, administrative penalties, operating anomalies |
| Related entities | Associated companies, shared legal representatives, suspected affiliates |

> Mainland China companies only.

::: details Corporate due diligence

```text
Look up BYD Co., Ltd.'s business registration, major shareholders, and external investments.
```

:::

::: details Partner risk check

```text
Check whether XX Technology Co., Ltd. has any litigation disputes, credit violations, or administrative penalties.
```

:::

::: details Equity chain lookup

```text
Who is the ultimate beneficial owner of this company, and what are its associated entities?
```

:::

## Academic Data

Access millions of papers across physics, mathematics, computer science, quantitative finance, economics, and more — spanning both peer-reviewed journals and preprint repositories. Whether you're writing a literature review, tracking a research frontier, or looking for the most cited work in a field, just describe what you need.

| Feature | Description |
|---|---|
| Paper search | Search by keyword, author, topic, or field across a large academic corpus |
| Citation lookup | Find the most cited and influential papers in any domain |
| Preprint access | Access the latest research before formal publication |
| Cross-discipline | Physics, math, CS, economics, quantitative finance, climate science, and more |

::: details Literature search

```text
Find key academic papers on financial fraud detection from the past five years, focusing on abnormal accruals and earnings manipulation models.
```

:::

::: details Research frontier

```text
What are the most important recent papers on LLM reasoning capabilities? Summarize the main findings.
```

:::

::: details Preprint lookup

```text
What are the latest preprints at the intersection of quantitative finance and machine learning?
```

:::

::: details Citation analysis

```text
What are the most influential papers on reinforcement learning from human feedback? Who are the key authors?
```

:::

::: details Academic paper writing

```text
Help me outline a literature review on Transformer architectures in NLP,
focusing on research developments since 2022. Reference highly cited papers
and note the core contribution of each.
```

:::

## Notes

- Data queries are billed per call and consume Kimi Code account credits
- The plugin provides read-only queries; no write or trading functionality is available
- Technical indicators and real-time prices are only available during active trading hours. After market close, ask about closing data instead (e.g. "How did X close today?")
- AI-generated output is for reference only and does not constitute investment or business advice

## Next steps

- [Plugins](./plugins.md) — Full installation and development documentation for the plugin system
- [MCP](./mcp.md) — Kimi Datasource runs on the MCP protocol; learn about the underlying mechanism
