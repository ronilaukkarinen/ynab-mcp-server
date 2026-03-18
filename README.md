<div align="center">

# YNAB MCP server

<img width="95" alt="MCP" src="https://github.com/user-attachments/assets/abed1a04-d69b-4ab4-a490-d606064df72d" />
<img style="justify-content:center;text-align: center;width: 210px; height: auto;" width="3840" height="969" alt="image" src="https://github.com/user-attachments/assets/ec10528b-300b-4491-965b-a11ea4a1a2c5" />

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=for-the-badge) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white) ![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)

</div>

---

MCP server for [YNAB (You Need A Budget)](https://ynab.com) API. Connects Claude Code (or any MCP client) to your YNAB account for reading budgets, managing transactions, and tracking spending.

Built because existing YNAB MCP servers fetch entire transaction histories (8MB+) and time out on real-world budgets with years of data. This server uses proper date filtering and returns only what you need.

---

## Features

- Budget summary with daily allowance calculation
- List and filter transactions by date, category, payee, or account
- Create, update, and delete transactions via natural language
- Move money between categories
- View scheduled/recurring transactions
- Proper date filtering — no full history dumps

## Tools

| Tool | Description |
|------|-------------|
| `ynab_list_budgets` | List all budgets with IDs |
| `ynab_budget_summary` | Daily allowance, available by category, overspent categories |
| `ynab_list_accounts` | All accounts with balances |
| `ynab_list_categories` | Category groups with current month balances |
| `ynab_get_month` | Budget details for a specific month |
| `ynab_list_transactions` | Transactions filtered by date (defaults to current month, max 200) |
| `ynab_create_transaction` | Create expense or income |
| `ynab_update_transaction` | Update existing transaction |
| `ynab_delete_transaction` | Delete a transaction |
| `ynab_set_category_budget` | Set budgeted amount for a category (move money) |
| `ynab_list_payees` | List all payees |
| `ynab_list_scheduled` | Scheduled/recurring transactions |

## Setup

### 1. Get a YNAB Personal Access Token

Go to [YNAB Developer Settings](https://app.ynab.com/settings/developer) and create a Personal Access Token.

### 2. Configure

```bash
cp .env.example .env
```

Add your `YNAB_API_TOKEN` to `.env`.

### 3. Install and run

```bash
bun install
```

### 4. Add to Claude Code

```bash
claude mcp add ynab --transport stdio -- bun /path/to/ynab-mcp-server/server.ts
```

Or add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "ynab": {
      "command": "bun",
      "args": ["/path/to/ynab-mcp-server/server.ts"],
      "env": {
        "YNAB_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

### 5. Verify

In Claude Code, run `/mcp` and check that `ynab` shows as connected.

## Usage examples

- "What's my daily spending allowance?"
- "How much did I spend on groceries this month?"
- "Add 15 euros expense at Lidl for groceries"
- "Move 50 euros from Buffer to Groceries"
- "Show my scheduled transactions"
- "What categories are overspent?"

## Requirements

- [Bun](https://bun.sh) runtime
- YNAB account with API access

