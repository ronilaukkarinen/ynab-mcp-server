import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DIR = import.meta.dirname;
const ENV_PATH = resolve(DIR, ".env");
const YNAB_BASE = "https://api.ynab.com/v1";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // Load from .env file
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  // Environment variables override .env file
  if (process.env.YNAB_API_TOKEN) env.YNAB_API_TOKEN = process.env.YNAB_API_TOKEN;
  return env;
}

const env = loadEnv();
const TOKEN = env.YNAB_API_TOKEN;

if (!TOKEN) {
  throw new Error("Missing YNAB_API_TOKEN. Set it in .env or as environment variable.");
}

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${YNAB_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YNAB API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// Helper: get current month as YYYY-MM-DD (first of month)
function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

// Helper: get today as YYYY-MM-DD
function today(): string {
  return new Date().toISOString().split("T")[0];
}

// Helper: remaining days in current month
function remainingDays(): number {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(1, lastDay - now.getDate() + 1);
}

const server = new McpServer({
  name: "ynab-mcp-server",
  version: "1.0.0",
});

// ── List budgets ──

server.tool(
  "ynab_list_budgets",
  "List all YNAB budgets with their IDs and names",
  {},
  async () => {
    const data = (await api("/budgets")) as any;
    const budgets = data.data.budgets.map((b: any) => ({
      id: b.id,
      name: b.name,
      last_modified: b.last_modified_on,
    }));
    return { content: [{ type: "text", text: JSON.stringify(budgets, null, 2) }] };
  }
);

// ── Budget summary (daily allowance, categories) ──

server.tool(
  "ynab_budget_summary",
  "Get budget summary: daily allowance, available by category, overspent categories. Use budget_id='last-used' for the default budget.",
  { budget_id: z.string().describe("Budget ID or 'last-used' for default") },
  async ({ budget_id }) => {
    const data = (await api(`/budgets/${budget_id}/months/current`)) as any;
    const month = data.data.month;
    const categories = month.categories || [];
    const skip = new Set(["inflow: ready to assign", "uncategorized", "split"]);
    const days = remainingDays();

    const spending: any[] = [];
    const overspent: string[] = [];

    for (const cat of categories) {
      if (cat.hidden || cat.deleted) continue;
      const name = cat.name;
      if (skip.has(name.toLowerCase())) continue;
      const balance = cat.balance / 1000;
      const activity = Math.abs(cat.activity / 1000);

      if (balance < 0) overspent.push(`${name}: ${balance.toFixed(2)}`);
      if (balance > 0) spending.push({ name, balance, activity });
    }

    const totalAvailable = spending.reduce((s, c) => s + c.balance, 0);
    const dailyAllowance = totalAvailable / days;

    const result = {
      daily_allowance: `${dailyAllowance.toFixed(2)}`,
      total_available: `${totalAvailable.toFixed(2)}`,
      remaining_days: days,
      overspent: overspent.length ? overspent : "none",
      categories: spending
        .sort((a, b) => b.balance - a.balance)
        .map((c) => ({ name: c.name, available: c.balance.toFixed(2), spent_this_month: c.activity.toFixed(2) })),
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── List accounts ──

server.tool(
  "ynab_list_accounts",
  "List all accounts in a budget",
  { budget_id: z.string().describe("Budget ID or 'last-used'") },
  async ({ budget_id }) => {
    const data = (await api(`/budgets/${budget_id}/accounts`)) as any;
    const accounts = data.data.accounts
      .filter((a: any) => !a.closed)
      .map((a: any) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        balance: (a.balance / 1000).toFixed(2),
        on_budget: a.on_budget,
      }));
    return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
  }
);

// ── List categories ──

server.tool(
  "ynab_list_categories",
  "List all category groups and categories with current month balances",
  { budget_id: z.string().describe("Budget ID or 'last-used'") },
  async ({ budget_id }) => {
    const data = (await api(`/budgets/${budget_id}/categories`)) as any;
    const groups = data.data.category_groups
      .filter((g: any) => !g.hidden && !g.deleted)
      .map((g: any) => ({
        name: g.name,
        categories: g.categories
          .filter((c: any) => !c.hidden && !c.deleted)
          .map((c: any) => ({
            id: c.id,
            name: c.name,
            budgeted: (c.budgeted / 1000).toFixed(2),
            activity: (c.activity / 1000).toFixed(2),
            balance: (c.balance / 1000).toFixed(2),
          })),
      }));
    return { content: [{ type: "text", text: JSON.stringify(groups, null, 2) }] };
  }
);

// ── Get month details ──

server.tool(
  "ynab_get_month",
  "Get budget details for a specific month (budgeted, activity, categories)",
  {
    budget_id: z.string().describe("Budget ID or 'last-used'"),
    month: z.string().describe("Month in YYYY-MM-DD format (first of month), e.g. '2026-03-01'"),
  },
  async ({ budget_id, month }) => {
    const data = (await api(`/budgets/${budget_id}/months/${month}`)) as any;
    const m = data.data.month;
    const result = {
      month: m.month,
      budgeted: (m.budgeted / 1000).toFixed(2),
      activity: (m.activity / 1000).toFixed(2),
      to_be_budgeted: (m.to_be_budgeted / 1000).toFixed(2),
      categories: m.categories
        .filter((c: any) => !c.hidden && !c.deleted)
        .map((c: any) => ({
          name: c.name,
          budgeted: (c.budgeted / 1000).toFixed(2),
          activity: (c.activity / 1000).toFixed(2),
          balance: (c.balance / 1000).toFixed(2),
        })),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── List transactions (date-filtered, max 200) ──

server.tool(
  "ynab_list_transactions",
  "List transactions filtered by date. Returns max 200 most recent. Use since_date to limit scope.",
  {
    budget_id: z.string().describe("Budget ID or 'last-used'"),
    since_date: z.string().optional().describe("Only return transactions on or after this date (YYYY-MM-DD). Defaults to first of current month."),
    category_id: z.string().optional().describe("Filter by category ID"),
    payee_id: z.string().optional().describe("Filter by payee ID"),
    account_id: z.string().optional().describe("Filter by account ID"),
  },
  async ({ budget_id, since_date, category_id, payee_id, account_id }) => {
    const sinceParam = since_date || currentMonth();
    let path: string;

    if (category_id) {
      path = `/budgets/${budget_id}/categories/${category_id}/transactions?since_date=${sinceParam}`;
    } else if (payee_id) {
      path = `/budgets/${budget_id}/payees/${payee_id}/transactions?since_date=${sinceParam}`;
    } else if (account_id) {
      path = `/budgets/${budget_id}/accounts/${account_id}/transactions?since_date=${sinceParam}`;
    } else {
      path = `/budgets/${budget_id}/transactions?since_date=${sinceParam}`;
    }

    const data = (await api(path)) as any;
    const transactions = data.data.transactions
      .slice(-200)
      .map((t: any) => ({
        id: t.id,
        date: t.date,
        amount: (t.amount / 1000).toFixed(2),
        payee_name: t.payee_name,
        category_name: t.category_name,
        memo: t.memo,
        cleared: t.cleared,
        approved: t.approved,
      }));
    return { content: [{ type: "text", text: JSON.stringify(transactions, null, 2) }] };
  }
);

// ── Create transaction ──

server.tool(
  "ynab_create_transaction",
  "Create a new transaction (expense or income). Amount is in currency units (e.g. 15.50 for fifteen euros fifty cents). Positive = inflow, negative = outflow/expense.",
  {
    budget_id: z.string().describe("Budget ID or 'last-used'"),
    account_id: z.string().describe("Account ID to post the transaction to"),
    amount: z.number().describe("Amount in currency units. Negative for expenses (e.g. -15.50), positive for income."),
    payee_name: z.string().describe("Payee/store name (e.g. 'Lidl', 'K-Market')"),
    category_id: z.string().optional().describe("Category ID. If omitted, transaction is uncategorized."),
    date: z.string().optional().describe("Transaction date (YYYY-MM-DD). Defaults to today."),
    memo: z.string().optional().describe("Optional memo/note"),
  },
  async ({ budget_id, account_id, amount, payee_name, category_id, date, memo }) => {
    const transaction: any = {
      account_id,
      date: date || today(),
      amount: Math.round(amount * 1000), // Convert to milliunits
      payee_name,
      cleared: "cleared",
      approved: true,
    };
    if (category_id) transaction.category_id = category_id;
    if (memo) transaction.memo = memo;

    const data = (await api(`/budgets/${budget_id}/transactions`, {
      method: "POST",
      body: JSON.stringify({ transaction }),
    })) as any;

    const tx = data.data.transaction;
    return {
      content: [{
        type: "text",
        text: `Transaction created: ${(tx.amount / 1000).toFixed(2)} at ${tx.payee_name} (${tx.category_name || "uncategorized"}) on ${tx.date}`,
      }],
    };
  }
);

// ── Update transaction ──

server.tool(
  "ynab_update_transaction",
  "Update an existing transaction. Only provide fields you want to change.",
  {
    budget_id: z.string().describe("Budget ID or 'last-used'"),
    transaction_id: z.string().describe("Transaction ID to update"),
    amount: z.number().optional().describe("New amount in currency units"),
    payee_name: z.string().optional().describe("New payee name"),
    category_id: z.string().optional().describe("New category ID"),
    date: z.string().optional().describe("New date (YYYY-MM-DD)"),
    memo: z.string().optional().describe("New memo"),
    approved: z.boolean().optional().describe("Approve the transaction"),
  },
  async ({ budget_id, transaction_id, amount, payee_name, category_id, date, memo, approved }) => {
    const transaction: any = {};
    if (amount !== undefined) transaction.amount = Math.round(amount * 1000);
    if (payee_name) transaction.payee_name = payee_name;
    if (category_id) transaction.category_id = category_id;
    if (date) transaction.date = date;
    if (memo !== undefined) transaction.memo = memo;
    if (approved !== undefined) transaction.approved = approved;

    const data = (await api(`/budgets/${budget_id}/transactions/${transaction_id}`, {
      method: "PUT",
      body: JSON.stringify({ transaction }),
    })) as any;

    const tx = data.data.transaction;
    return {
      content: [{
        type: "text",
        text: `Transaction updated: ${(tx.amount / 1000).toFixed(2)} at ${tx.payee_name} (${tx.category_name || "uncategorized"}) on ${tx.date}`,
      }],
    };
  }
);

// ── Delete transaction ──

server.tool(
  "ynab_delete_transaction",
  "Delete a transaction by ID",
  {
    budget_id: z.string().describe("Budget ID or 'last-used'"),
    transaction_id: z.string().describe("Transaction ID to delete"),
  },
  async ({ budget_id, transaction_id }) => {
    await api(`/budgets/${budget_id}/transactions/${transaction_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Transaction ${transaction_id} deleted.` }] };
  }
);

// ── Update category budget ──

server.tool(
  "ynab_set_category_budget",
  "Set the budgeted amount for a category in a specific month. Use to move money between categories.",
  {
    budget_id: z.string().describe("Budget ID or 'last-used'"),
    month: z.string().describe("Month (YYYY-MM-DD, first of month)"),
    category_id: z.string().describe("Category ID"),
    budgeted: z.number().describe("New budgeted amount in currency units (e.g. 200.00)"),
  },
  async ({ budget_id, month, category_id, budgeted }) => {
    const data = (await api(`/budgets/${budget_id}/months/${month}/categories/${category_id}`, {
      method: "PATCH",
      body: JSON.stringify({ category: { budgeted: Math.round(budgeted * 1000) } }),
    })) as any;

    const cat = data.data.category;
    return {
      content: [{
        type: "text",
        text: `Category "${cat.name}" budget set to ${(cat.budgeted / 1000).toFixed(2)} for ${month}. Balance: ${(cat.balance / 1000).toFixed(2)}`,
      }],
    };
  }
);

// ── List payees ──

server.tool(
  "ynab_list_payees",
  "List all payees in a budget. Useful for finding payee IDs.",
  { budget_id: z.string().describe("Budget ID or 'last-used'") },
  async ({ budget_id }) => {
    const data = (await api(`/budgets/${budget_id}/payees`)) as any;
    const payees = data.data.payees
      .filter((p: any) => !p.deleted)
      .map((p: any) => ({ id: p.id, name: p.name }));
    return { content: [{ type: "text", text: JSON.stringify(payees, null, 2) }] };
  }
);

// ── Scheduled transactions ──

server.tool(
  "ynab_list_scheduled",
  "List all scheduled/recurring transactions",
  { budget_id: z.string().describe("Budget ID or 'last-used'") },
  async ({ budget_id }) => {
    const data = (await api(`/budgets/${budget_id}/scheduled_transactions`)) as any;
    const txns = data.data.scheduled_transactions.map((t: any) => ({
      id: t.id,
      date_next: t.date_next,
      frequency: t.frequency,
      amount: (t.amount / 1000).toFixed(2),
      payee_name: t.payee_name,
      category_name: t.category_name,
      memo: t.memo,
    }));
    return { content: [{ type: "text", text: JSON.stringify(txns, null, 2) }] };
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
