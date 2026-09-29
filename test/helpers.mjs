// Minimal n8n function contexts (IExecuteFunctions / IHookFunctions / IWebhookFunctions) backed
// by a real Stablora platform (app/lib) served on a local port.
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const APP = resolve(import.meta.dirname, '../../../app');

export async function stablora(t) {
  const cwd = process.cwd(); process.chdir(APP); // the platform reads lib/schema.sql relative to cwd
  const { Platform } = await import(`${APP}/lib/platform.mjs`);
  const { handle } = await import(`${APP}/lib/http.mjs`);
  const webhooks = await import(`${APP}/lib/webhooks.mjs`);
  const p = new Platform(':memory:'); globalThis.__stabloraPlatform = p;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const response = await handle(new Request(`http://localhost:3000${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); p.db.close(); delete globalThis.__stabloraPlatform; process.chdir(cwd); });
  const m = p.createMerchant({ name: 'Shop', email: `shop${Date.now()}@example.test`, password: 'long-test-password' });
  return { p, m, webhooks, base: `http://127.0.0.1:${server.address().port}/api/v1` };
}

// n8n's httpRequestWithAuthentication: applies the credential's generic auth and throws on non-2xx.
export function context({ credentials, params = {}, staticData = {}, webhookUrl, request, items = [{ json: {} }] }) {
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const ctx = {
    response,
    getCredentials: async () => credentials,
    getNodeParameter: (name, _i, fallback) => (typeof _i !== 'number' && _i !== undefined ? _i : undefined, name in params ? params[name] : fallback),
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => webhookUrl,
    getWorkflow: () => ({ id: 'wf1', name: 'Orders' }),
    getNode: () => ({ id: 'n1', name: 'Stablora', type: 'n8n-nodes-stablora.stablora', typeVersion: 1, position: [0, 0], parameters: {} }),
    getInputData: () => items,
    continueOnFail: () => false,
    getRequestObject: () => request,
    getResponseObject: () => response,
    getHeaderData: () => request.headers,
    helpers: {
      returnJsonArray: rows => rows.map(json => ({ json })),
      async httpRequestWithAuthentication(name, options) {
        const url = new URL(options.url); for (const [k, v] of Object.entries(options.qs || {})) url.searchParams.set(k, v);
        const r = await fetch(url, { method: options.method, headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
        const body = await r.json();
        if (!r.ok) throw Object.assign(new Error(body.error?.message || body.error || `HTTP ${r.status}`), { statusCode: r.status });
        return body;
      },
    },
  };
  return ctx;
}
