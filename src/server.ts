import express, { type Request, type Response, type NextFunction } from 'express';
import * as dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';

dotenv.config();

const PORT = process.env.PORT ?? '3000';
const API_KEY = process.env.MCP_API_KEY;

if (!API_KEY) {
  console.warn('WARNING: MCP_API_KEY is not set. The server is open to anyone.');
}

const app = express();
app.use(express.json());

function auth(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) return next();
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Each request gets a fresh stateless transport + server instance.
// This is the correct pattern for stateless MCP over HTTP.
function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'claude-finances', version: '1.0.0' });
  registerTools(server);
  return server;
}

app.post('/mcp', auth, async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', auth, async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

// Clients may send DELETE for session cleanup; acknowledge it.
app.delete('/mcp', auth, (_req: Request, res: Response) => {
  res.status(200).end();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`claude-finances MCP server listening on port ${PORT}`);
});
