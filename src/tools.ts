import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AccountBase, Transaction, Holding, Security } from 'plaid';
import { getPlaidClient, loadTokens } from './plaid-client.js';

const plaid = getPlaidClient();

function requireTokens() {
  const items = loadTokens();
  if (items.length === 0) {
    throw new Error('No bank accounts linked. Run `npm run setup` to connect your accounts.');
  }
  return items;
}

async function fetchAllAccounts(): Promise<{ account: AccountBase; institution: string }[]> {
  const items = requireTokens();
  const results: { account: AccountBase; institution: string }[] = [];
  for (const item of items) {
    const res = await plaid.accountsGet({ access_token: item.access_token });
    for (const acct of res.data.accounts) {
      results.push({ account: acct, institution: item.institution_name });
    }
  }
  return results;
}

async function fetchTransactions(startDate: string, endDate: string, accountIds?: string[]): Promise<Transaction[]> {
  const items = requireTokens();
  const all: Transaction[] = [];
  for (const item of items) {
    try {
      let offset = 0;
      while (true) {
        const res = await plaid.transactionsGet({
          access_token: item.access_token,
          start_date: startDate,
          end_date: endDate,
          options: { count: 500, offset, account_ids: accountIds },
        });
        all.push(...res.data.transactions);
        if (all.length >= res.data.total_transactions || res.data.transactions.length === 0) break;
        offset += res.data.transactions.length;
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error_code?: string } } };
      if (e?.response?.data?.error_code === 'PRODUCT_NOT_READY') {
        process.stderr.write(`Transactions not ready yet for ${item.institution_name} — try again in a few minutes\n`);
      } else {
        throw err;
      }
    }
  }
  return all.sort((a, b) => b.date.localeCompare(a.date));
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(amount));
}

function primaryCategory(tx: Transaction): string {
  return tx.personal_finance_category?.primary ?? tx.category?.[0] ?? 'Uncategorized';
}

export function registerTools(server: McpServer): void {

  server.tool('list_accounts', 'List all linked bank accounts with current balances', {}, async () => {
    const accounts = await fetchAllAccounts();
    if (accounts.length === 0) return { content: [{ type: 'text', text: 'No accounts found.' }] };
    const lines = accounts.map(({ account: a, institution }) => {
      const bal = a.balances.current != null ? formatAmount(a.balances.current) : 'N/A';
      const avail = a.balances.available != null ? ` (available: ${formatAmount(a.balances.available)})` : '';
      const limit = a.balances.limit != null ? ` / limit: ${formatAmount(a.balances.limit)}` : '';
      return `• ${institution} — ${a.name} (${a.subtype ?? a.type})\n  Balance: ${bal}${avail}${limit}\n  Account ID: ${a.account_id}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  });

  server.tool(
    'get_transactions',
    'Get transactions for a date range. Amounts are positive for spending/debits, negative for income/credits.',
    {
      start_date: z.string().describe('Start date in YYYY-MM-DD format'),
      end_date: z.string().describe('End date in YYYY-MM-DD format'),
      account_ids: z.array(z.string()).optional().describe('Filter to specific account IDs (from list_accounts)'),
      limit: z.number().int().min(1).max(500).optional().default(100).describe('Max transactions to return'),
    },
    async ({ start_date, end_date, account_ids, limit }) => {
      const txs = await fetchTransactions(start_date, end_date, account_ids);
      const shown = txs.slice(0, limit);
      if (shown.length === 0) {
        return { content: [{ type: 'text', text: `No transactions found between ${start_date} and ${end_date}.` }] };
      }
      const lines = shown.map(tx => {
        const sign = tx.amount > 0 ? '-' : '+';
        return `${tx.date}  ${sign}${formatAmount(tx.amount).padStart(10)}  ${(tx.merchant_name ?? tx.name).padEnd(35)} [${primaryCategory(tx)}]`;
      });
      const header = `Transactions ${start_date} → ${end_date} (${shown.length} of ${txs.length} total)\n${'─'.repeat(80)}`;
      return { content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }] };
    }
  );

  server.tool(
    'search_transactions',
    'Search transactions by merchant name or description',
    {
      query: z.string().describe('Text to search for in merchant name or transaction name'),
      start_date: z.string().optional().describe('Start date YYYY-MM-DD (defaults to 90 days ago)'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD (defaults to today)'),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ query, start_date, end_date, limit }) => {
      const today = new Date();
      const defaultStart = new Date(today);
      defaultStart.setDate(today.getDate() - 90);
      const start = start_date ?? defaultStart.toISOString().split('T')[0];
      const end = end_date ?? today.toISOString().split('T')[0];
      const txs = await fetchTransactions(start, end);
      const q = query.toLowerCase();
      const matches = txs
        .filter(tx => tx.name.toLowerCase().includes(q) || (tx.merchant_name ?? '').toLowerCase().includes(q))
        .slice(0, limit);
      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `No transactions matching "${query}" found.` }] };
      }
      const lines = matches.map(tx => {
        const sign = tx.amount > 0 ? '-' : '+';
        return `${tx.date}  ${sign}${formatAmount(tx.amount).padStart(10)}  ${(tx.merchant_name ?? tx.name).padEnd(35)} [${primaryCategory(tx)}]`;
      });
      return { content: [{ type: 'text', text: `Found ${matches.length} transactions matching "${query}":\n${lines.join('\n')}` }] };
    }
  );

  server.tool(
    'get_spending_summary',
    'Get spending broken down by category for a date range',
    {
      start_date: z.string().describe('Start date YYYY-MM-DD'),
      end_date: z.string().describe('End date YYYY-MM-DD'),
      account_ids: z.array(z.string()).optional(),
    },
    async ({ start_date, end_date, account_ids }) => {
      const txs = await fetchTransactions(start_date, end_date, account_ids);
      const byCategory = new Map<string, number>();
      for (const tx of txs.filter(tx => tx.amount > 0)) {
        const cat = primaryCategory(tx);
        byCategory.set(cat, (byCategory.get(cat) ?? 0) + tx.amount);
      }
      const sorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
      const total = sorted.reduce((sum, [, v]) => sum + v, 0);
      if (sorted.length === 0) {
        return { content: [{ type: 'text', text: `No spending found between ${start_date} and ${end_date}.` }] };
      }
      const lines = sorted.map(([cat, amount]) => {
        const pct = ((amount / total) * 100).toFixed(1);
        return `${cat.padEnd(35)} ${formatAmount(amount).padStart(10)}  ${pct}%`;
      });
      return { content: [{ type: 'text', text: `Spending by Category: ${start_date} → ${end_date}\nTotal: ${formatAmount(total)}\n${'─'.repeat(60)}\n${lines.join('\n')}` }] };
    }
  );

  server.tool(
    'get_monthly_overview',
    'Get income vs spending summary for a specific month',
    {
      year: z.number().int().describe('Year, e.g. 2025'),
      month: z.number().int().min(1).max(12).describe('Month number 1-12'),
    },
    async ({ year, month }) => {
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const end = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
      const txs = await fetchTransactions(start, end);
      const spending = txs.filter(tx => tx.amount > 0);
      const income = txs.filter(tx => tx.amount < 0);
      const totalSpending = spending.reduce((s, tx) => s + tx.amount, 0);
      const totalIncome = income.reduce((s, tx) => s + Math.abs(tx.amount), 0);
      const net = totalIncome - totalSpending;
      const topCategories = new Map<string, number>();
      for (const tx of spending) {
        const cat = primaryCategory(tx);
        topCategories.set(cat, (topCategories.get(cat) ?? 0) + tx.amount);
      }
      const topCatLines = [...topCategories.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([cat, amt]) => `  ${cat.padEnd(33)} ${formatAmount(amt).padStart(10)}`);
      const monthName = new Date(year, month - 1).toLocaleString('en-US', { month: 'long' });
      const summary = [
        `${monthName} ${year} Overview`, '─'.repeat(50),
        `Income:   ${formatAmount(totalIncome).padStart(12)}`,
        `Spending: ${formatAmount(totalSpending).padStart(12)}`,
        `Net:      ${(net >= 0 ? '+' : '') + formatAmount(net).padStart(11)}`,
        '', 'Top Spending Categories:', ...topCatLines,
        '', `Total transactions: ${txs.length}`,
      ].join('\n');
      return { content: [{ type: 'text', text: summary }] };
    }
  );

  server.tool('get_net_worth', 'Calculate current net worth across all linked accounts', {}, async () => {
    const accounts = await fetchAllAccounts();
    let assets = 0;
    let liabilities = 0;
    const lines: string[] = ['Assets', '─'.repeat(50)];
    for (const { account: a, institution } of accounts) {
      const bal = a.balances.current ?? 0;
      if (['depository', 'investment', 'brokerage'].includes(a.type)) {
        assets += bal;
        lines.push(`  ${institution} ${a.name.padEnd(28)} ${formatAmount(bal).padStart(10)}`);
      }
    }
    lines.push(`${'Total Assets'.padEnd(40)} ${formatAmount(assets).padStart(10)}`, '', 'Liabilities', '─'.repeat(50));
    for (const { account: a, institution } of accounts) {
      const bal = a.balances.current ?? 0;
      if (['credit', 'loan'].includes(a.type)) {
        liabilities += bal;
        lines.push(`  ${institution} ${a.name.padEnd(28)} ${formatAmount(bal).padStart(10)}`);
      }
    }
    const netWorth = assets - liabilities;
    lines.push(
      `${'Total Liabilities'.padEnd(40)} ${formatAmount(liabilities).padStart(10)}`,
      '', '─'.repeat(50),
      `${'Net Worth'.padEnd(40)} ${(netWorth >= 0 ? '' : '-') + formatAmount(netWorth).padStart(10)}`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  server.tool('get_investment_holdings', 'Get current investment portfolio holdings with values', {}, async () => {
    const items = requireTokens();
    const allHoldings: Holding[] = [];
    const allSecurities: Security[] = [];
    for (const item of items) {
      try {
        const res = await plaid.investmentsHoldingsGet({ access_token: item.access_token });
        allHoldings.push(...res.data.holdings);
        allSecurities.push(...res.data.securities);
      } catch (err: unknown) {
        const e = err as { response?: { data?: { error_code?: string } } };
        if (e?.response?.data?.error_code !== 'PRODUCTS_NOT_SUPPORTED') throw err;
      }
    }
    if (allHoldings.length === 0) {
      return { content: [{ type: 'text', text: 'No investment holdings found. Make sure investment accounts are linked.' }] };
    }
    const secById = new Map(allSecurities.map(s => [s.security_id, s]));
    const lines = allHoldings
      .sort((a, b) => (b.institution_value ?? 0) - (a.institution_value ?? 0))
      .map(h => {
        const sec = secById.get(h.security_id);
        const name = sec?.name ?? sec?.ticker_symbol ?? 'Unknown';
        const ticker = sec?.ticker_symbol ? `(${sec.ticker_symbol})` : '';
        const value = h.institution_value != null ? formatAmount(h.institution_value) : 'N/A';
        return `${name.padEnd(35)} ${ticker.padEnd(8)} ${h.quantity.toFixed(4).padStart(10)} shares @ ${(h.institution_price != null ? formatAmount(h.institution_price) : 'N/A').padStart(10)} = ${value.padStart(12)}`;
      });
    const totalValue = allHoldings.reduce((s, h) => s + (h.institution_value ?? 0), 0);
    const header = `Investment Holdings\n${'─'.repeat(90)}\n${'Security'.padEnd(35)} ${'Ticker'.padEnd(8)} ${'Quantity'.padStart(10)}        ${'Price'.padStart(10)}    ${'Value'.padStart(12)}`;
    return { content: [{ type: 'text', text: `${header}\n${lines.join('\n')}\n${'─'.repeat(90)}\n${'Total Portfolio Value'.padEnd(78)} ${formatAmount(totalValue).padStart(12)}` }] };
  });
}
