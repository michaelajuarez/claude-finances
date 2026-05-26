import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA ?? os.homedir(), 'claude-finances')
  : path.join(os.homedir(), '.config', 'claude-finances');
const TOKEN_FILE = path.join(CONFIG_DIR, 'tokens.json');

export interface StoredItem {
  item_id: string;
  access_token: string;
  institution_name: string;
}

export function getPlaidClient(): PlaidApi {
  const env = (process.env.PLAID_ENV ?? 'sandbox') as keyof typeof PlaidEnvironments;
  const config = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
        'PLAID-SECRET': process.env.PLAID_SECRET!,
      },
    },
  });
  return new PlaidApi(config);
}

export function loadTokens(): StoredItem[] {
  // Cloud deployment: tokens come from environment variable
  if (process.env.PLAID_TOKENS) {
    try {
      return JSON.parse(process.env.PLAID_TOKENS) as StoredItem[];
    } catch {
      return [];
    }
  }
  // Local: tokens stored in file
  if (!fs.existsSync(TOKEN_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) as StoredItem[];
  } catch {
    return [];
  }
}

export function saveToken(item: StoredItem): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const existing = loadTokens();
  const idx = existing.findIndex(t => t.item_id === item.item_id);
  if (idx >= 0) {
    existing[idx] = item;
  } else {
    existing.push(item);
  }
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
}

export function removeToken(itemId: string): void {
  const existing = loadTokens().filter(t => t.item_id !== itemId);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
}
