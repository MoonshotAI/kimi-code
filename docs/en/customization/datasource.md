# Official Plugins

Kimi Datasource is the official Kimi Code data plugin. It lets you query financial market data, macroeconomic indicators, corporate registration records, and academic literature in natural language — no manual API calls or data account registration required.

**Prerequisite**: You must complete OAuth login with a Kimi Code account via `/login`. The plugin relies on local credentials to access data services.

## Installation

1. Run `/plugin` inside Kimi Code CLI
2. Select **Marketplace** from the menu that appears
3. Find **Kimi Datasource** and choose to install it
4. After installation completes, run `/new` to start a new session — the plugin is ready to use

## Data Capabilities

The plugin covers the following data categories. The Agent selects the appropriate one automatically based on your question — no manual specification needed:

**A-share / Hong Kong stock market data and financials**

Real-time prices, percentage changes, trading volume, turnover rate; technical indicators (MACD, KDJ, RSI, BOLL, MA, etc.); historical financial data (revenue, net profit, ROE, debt-to-asset ratio, etc.); watchlist management and position profit/loss calculation.

> A-share stock codes require a market suffix, e.g., `600519.SH` (Shanghai Stock Exchange), `002594.SZ` (Shenzhen Stock Exchange), `0700.HK` (Hong Kong).

**Global market data**

Real-time and historical price data for US stocks, ETFs, and major global indices.

**Macroeconomic data**

World Bank open data: GDP, CPI, trade volume, employment rate, and other macroeconomic indicators by country, with support for cross-country and cross-year comparisons.

**Corporate registration information**

Business registration, major shareholders, recent funding rounds, litigation disputes, and credit violation records for mainland Chinese companies. Suitable for background research before signing contracts.

**Academic literature**

Search recent papers by keyword, returning titles, authors, and core conclusions, with cross-database query support.

## Usage Examples

Simply describe what you need — no need to specify which data source to use.

**Query real-time market data**

```
Did BYD close up or down today, and what were the turnover rate and trading volume?
```

**Technical indicator analysis**

```
Show me the MACD and KDJ for CATL — what are the current bullish/bearish signals?
```

**Financial comparison**

```
Pull the debt-to-asset ratio, net profit margin, and ROE for CATL and BYD for 2024,
make a comparison table, and determine which company has a more stable financial structure.
```

**Macroeconomic research**

```
Pull the GDP growth rate and CPI data for China, the US, and Japan over the past 10 years,
make an annual comparison table, and mark the impact of key policy events.
```

**Academic paper writing**

```
Help me outline a literature review on Transformer architectures in NLP,
focusing on research developments since 2022. Reference highly cited papers
and note the core contribution of each.
```

## Notes

- Data queries are billed per call and consume Kimi Code account credits
- The plugin provides read-only queries; no write or trading functionality is available
- AI-generated output is for reference only and does not constitute any commercial decision advice

## Next steps

- [Plugins](./plugins.md) — Full installation and development documentation for the plugin system
- [MCP](./mcp.md) — Kimi Datasource runs on the MCP protocol; learn about the underlying mechanism
