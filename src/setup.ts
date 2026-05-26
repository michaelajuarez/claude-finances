/**
 * One-time setup: opens Plaid Link in a browser to connect bank accounts.
 * Run with: npm run setup
 */
import express from 'express';
import * as dotenv from 'dotenv';
import * as path from 'path';
import openBrowser from 'open';
import { CountryCode, Products } from 'plaid';
import { getPlaidClient, saveToken, loadTokens, CONFIG_DIR } from './plaid-client.js';
import * as fs from 'fs';

const CONFIG_FILE = path.join(CONFIG_DIR, '.env');

// ─── Ensure config exists ──────────────────────────────────────────────────

if (!fs.existsSync(CONFIG_FILE)) {
  console.log(`\nNo config found. Creating one at ${CONFIG_FILE}\n`);
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf-8');
  fs.writeFileSync(CONFIG_FILE, example, { mode: 0o600 });
  console.log('Please fill in your Plaid credentials:');
  console.log(`  ${CONFIG_FILE}\n`);
  console.log('Then run `npm run setup` again.\n');
  process.exit(0);
}

dotenv.config({ path: CONFIG_FILE });

if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  console.error('Missing PLAID_CLIENT_ID or PLAID_SECRET in', CONFIG_FILE);
  process.exit(1);
}

const plaid = getPlaidClient();
const PORT = 8765;
const app = express();
app.use(express.json());

// ─── Serve Link page ───────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  const existing = loadTokens();
  const linked = existing.map(t => `<li>${t.institution_name}</li>`).join('');
  const linkedSection = existing.length > 0
    ? `<p>Already linked: <ul>${linked}</ul></p>`
    : '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Claude Finances Setup</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
    h1 { font-size: 1.5rem; }
    button { background: #1a73e8; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #1557b0; }
    #status { margin-top: 20px; color: #333; }
    .success { color: #188038; font-weight: bold; }
    .error { color: #c5221f; }
  </style>
</head>
<body>
  <h1>Claude Finances Setup</h1>
  <p>Connect your bank accounts to use financial tools in Claude.</p>
  ${linkedSection}
  <button id="btn">Connect an Account</button>
  <div id="status"></div>

  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      status.textContent = 'Initializing...';

      const { link_token } = await fetch('/link-token').then(r => r.json());

      const handler = Plaid.create({
        token: link_token,
        onSuccess: async (public_token, metadata) => {
          status.textContent = 'Saving access token...';
          const res = await fetch('/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_token, institution: metadata.institution }),
          });
          const data = await res.json();
          if (data.ok) {
            status.innerHTML = '<span class="success">✓ ' + data.institution + ' connected! You can connect another account or close this tab.</span>';
          } else {
            status.innerHTML = '<span class="error">Error: ' + data.error + '</span>';
          }
          btn.disabled = false;
        },
        onExit: (err) => {
          if (err) status.innerHTML = '<span class="error">' + err.display_message + '</span>';
          else status.textContent = '';
          btn.disabled = false;
        },
      });

      handler.open();
    });
  </script>
</body>
</html>`);
});

// ─── Create link token ─────────────────────────────────────────────────────

app.get('/link-token', async (_req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: 'local-user' },
      client_name: 'Claude Finances',
      products: [Products.Transactions, Products.Investments],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err: unknown) {
    const e = err as { response?: { data?: unknown }; message?: string };
    console.error('link token error:', e.response?.data ?? e.message);
    res.status(500).json({ error: 'Failed to create link token. Check your Plaid credentials.' });
  }
});

// ─── Exchange public token ─────────────────────────────────────────────────

app.post('/exchange', async (req, res) => {
  const { public_token, institution } = req.body as {
    public_token: string;
    institution: { institution_id: string; name: string };
  };

  try {
    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchange.data;

    saveToken({ item_id, access_token, institution_name: institution.name });

    console.log(`\n✓ Linked: ${institution.name} (item_id: ${item_id})`);
    res.json({ ok: true, institution: institution.name });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error('exchange error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Start and open browser ────────────────────────────────────────────────

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nSetup server running at ${url}`);
  console.log('Opening browser...\n');
  openBrowser(url).catch(() => {
    console.log(`Could not auto-open browser. Please open: ${url}`);
  });
  console.log('Press Ctrl+C when done linking accounts.\n');

  process.on('SIGINT', () => {
    const tokens = loadTokens();
    if (tokens.length > 0) {
      console.log('\n\n─── VPS environment variables ───────────────────────────────');
      console.log('Set these on your server (e.g. in /etc/environment or your process manager):\n');
      console.log(`PLAID_CLIENT_ID=${process.env.PLAID_CLIENT_ID}`);
      console.log(`PLAID_SECRET=${process.env.PLAID_SECRET}`);
      console.log(`PLAID_ENV=${process.env.PLAID_ENV ?? 'development'}`);
      console.log(`PLAID_TOKENS='${JSON.stringify(tokens)}'`);
      console.log(`MCP_API_KEY=<generate with: openssl rand -hex 32>`);
      console.log('─────────────────────────────────────────────────────────────\n');
    }
    process.exit(0);
  });
});
