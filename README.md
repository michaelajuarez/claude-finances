# claude-finances

A remote MCP server that gives Claude live access to your bank accounts, credit cards, and investments via [Plaid](https://plaid.com). Deploy it on any Linux server and connect it to [claude.ai](https://claude.ai) to ask questions about your finances from any device.

## How it works

1. You run a one-time setup on your local machine (Mac/Windows/Linux) to connect your bank accounts via Plaid Link
2. You deploy the MCP server to a VPS
3. You add the server as a custom integration in claude.ai

Once connected, you can ask Claude things like:
- *"What did I spend on food last month?"*
- *"Show me my net worth"*
- *"How much have I spent at Amazon this year?"*
- *"Give me an overview of March 2025"*
- *"What are my current investment holdings?"*

## Prerequisites

- Node.js 20+
- A [Plaid developer account](https://dashboard.plaid.com) (free Development tier supports up to 100 linked accounts)
- A Linux VPS with a domain name and HTTPS (claude.ai requires HTTPS)
- A claude.ai account (Pro plan required for custom integrations)

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/claude-finances.git
cd claude-finances
npm install
```

### 2. Get Plaid credentials

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com)
2. Create an app
3. Go to **Team Settings → Keys** and copy your `client_id` and `secret`
4. Start with the **Sandbox** environment to test, then switch to **Development** for real accounts

### 3. Link your bank accounts

Run the setup script on your local machine (this opens a browser for Plaid's OAuth flow):

```bash
npm run setup
```

- A browser window opens automatically
- Click **Connect an Account** and follow the Plaid Link flow
- Repeat for each bank/brokerage you want to connect
- When done, press **Ctrl+C**

The script prints all the environment variables you need for the next step:

```
─── VPS environment variables ───────────────────────────────
PLAID_CLIENT_ID=abc123
PLAID_SECRET=xyz789
PLAID_ENV=development
PLAID_TOKENS='[{"item_id":"...","access_token":"...","institution_name":"Chase"}]'
MCP_API_KEY=<generate with: openssl rand -hex 32>
─────────────────────────────────────────────────────────────
```

### 4. Deploy to your VPS

**On the server:**

```bash
git clone https://github.com/YOUR_USERNAME/claude-finances.git
cd claude-finances
npm install
npm run build
```

Set the environment variables from the previous step. Using systemd (recommended):

```ini
# /etc/systemd/system/claude-finances.service
[Unit]
Description=Claude Finances MCP Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/claude-finances
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=PLAID_CLIENT_ID=your_client_id
Environment=PLAID_SECRET=your_secret
Environment=PLAID_ENV=development
Environment=MCP_API_KEY=your_api_key
Environment=PLAID_TOKENS=[{"item_id":"...","access_token":"...","institution_name":"..."}]

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now claude-finances
```

**Nginx reverse proxy with HTTPS** (required — claude.ai only connects to HTTPS endpoints):

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location /mcp {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }

    location /health {
        proxy_pass http://localhost:3000;
    }
}
```

> Use [Certbot](https://certbot.eff.org/) to get a free Let's Encrypt certificate.

### 5. Connect to claude.ai

1. Open [claude.ai](https://claude.ai) → **Settings** → **Integrations**
2. Click **Add custom integration**
3. Set the URL to `https://your-domain.com/mcp`
4. Add the header: `Authorization: Bearer your_api_key`
5. Save

Claude now has access to your financial tools in any conversation.

## Available tools

| Tool | Description |
|---|---|
| `list_accounts` | All linked accounts with current balances |
| `get_transactions` | Transactions for a date range |
| `search_transactions` | Search by merchant name or description |
| `get_spending_summary` | Spending by category for a date range |
| `get_monthly_overview` | Income vs spending for a specific month |
| `get_net_worth` | Total assets minus liabilities |
| `get_investment_holdings` | Portfolio holdings with current values |

## Adding more accounts later

Run `npm run setup` again on your local machine, connect the new account, then update `PLAID_TOKENS` on your server with the new value printed on Ctrl+C.

## Security notes

- `MCP_API_KEY` protects your endpoint — treat it like a password and keep it out of your shell history
- Your transaction data is never stored on the server; every tool call fetches live from Plaid
- Plaid access tokens in `PLAID_TOKENS` grant read-only access to your accounts by default
- Keep your server and Node.js up to date
