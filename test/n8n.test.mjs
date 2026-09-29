import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stablora, context } from './helpers.mjs';

const require = createRequire(import.meta.url);
// The end-to-end tests run a real Stablora from the Stablora monorepo (plugins/n8n-nodes-stablora → ../../app).
const live = existsSync(resolve(import.meta.dirname, '../../../app/lib/platform.mjs')) || 'needs the Stablora app (monorepo checkout)';
const e2e = live === true ? {} : { skip: live };
const { Stablora } = require('../dist/nodes/Stablora/Stablora.node.js');
const { StabloraTrigger } = require('../dist/nodes/Stablora/StabloraTrigger.node.js');
const { StabloraApi } = require('../dist/credentials/StabloraApi.credentials.js');
const { verifySignature, modeMatches, positiveDecimal } = require('../dist/nodes/Stablora/shared.js');

test('package manifest points at existing node and credential files', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.keywords.includes('n8n-community-node-package'));
  for (const file of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) assert.ok(require(`../${file}`));
  const cred = new StabloraApi();
  assert.equal(cred.name, 'stabloraApi'); assert.equal(cred.properties.find(p => p.name === 'apiKey').typeOptions.password, true);
  for (const Node of [Stablora, StabloraTrigger]) {
    const d = new Node().description;
    assert.deepEqual(d.icon, { light: 'file:stablora.svg', dark: 'file:stablora.dark.svg' }); assert.equal(d.credentials[0].name, 'stabloraApi');
    const names = new Set(); for (const p of d.properties) names.add(`${p.name}:${JSON.stringify(p.displayOptions || {})}`);
    assert.equal(names.size, d.properties.length, 'no duplicate property definitions');
  }
});

test('helpers: decimals, key modes and signature checks', () => {
  assert.equal(positiveDecimal('19.99', 'x'), '19.99');
  for (const bad of ['0', '-1', '1e3', '19,99', '', 'abc', '0.00']) assert.throws(() => positiveDecimal(bad, 'Amount'));
  assert.ok(modeMatches('live', 'qk_live_x')); assert.ok(!modeMatches('testnet', 'qk_live_x')); assert.ok(modeMatches('sandbox', 'qk_test_x')); assert.ok(!modeMatches('live', 'qk_test_x'));
  assert.throws(() => verifySignature('{}', 't=1,v1=' + 'a'.repeat(64), 'whsec_x', 1), /Invalid/);
  assert.throws(() => verifySignature('{}', 't=1,v1=' + 'a'.repeat(64), 'whsec_x', 1000), /tolerance/);
  assert.throws(() => verifySignature('{}', 'nonsense', 'whsec_x'), /malformed/);
});

test('actions: checkout session (any coin), payment lookup, customer wallet, against a real Stablora', e2e, async t => {
  const { p, m, base } = await stablora(t);
  const key = p.createKey(m.id, 'n8n', ['read', 'payments']).key;
  const credentials = { apiKey: key, baseUrl: base };
  const run = async params => (await new Stablora().execute.call(context({ credentials, params })))[0][0].json;
  const session = await run({ resource: 'checkoutSession', operation: 'create', reference: 'order-1', amount: '25.00', description: 'Order 1', successUrl: 'https://shop.example.com/thanks', options: {} });
  assert.match(session.id, /^cs_/); assert.match(session.url, /\/checkout\/cs_/);
  assert.equal((await run({ resource: 'checkoutSession', operation: 'create', reference: 'order-1', amount: '25.00', description: 'Order 1', options: {} })).id, session.id, 'same reference, same checkout');
  await assert.rejects(run({ resource: 'checkoutSession', operation: 'create', reference: 'order-2', amount: '25,00', options: {} }), /positive decimal/);
  const pay = p.createPayment(m.id, { reference: 'direct-1', network: 'dogecoin', asset: 'DOGE', amount: '5' });
  const got = await run({ resource: 'payment', operation: 'get', paymentId: pay.id });
  assert.equal(got.id, pay.id); assert.equal(got.status, 'pending');
  const wallet = await run({ resource: 'wallet', operation: 'assign', externalId: 'player-7', name: 'Player 7', network: 'dogecoin' });
  assert.equal(wallet.customer.externalId ?? wallet.customer.external_id, 'player-7'); assert.ok(wallet.wallet.address);
  const balances = await run({ resource: 'balance', operation: 'get' });
  assert.ok(balances);
});

test('trigger: activation registers an endpoint; signed, deduplicated, confirmed deliveries start the workflow', e2e, async t => {
  const { p, m, base, webhooks } = await stablora(t);
  const key = p.createKey(m.id, 'n8n', ['read', 'payments']).key, credentials = { apiKey: key, baseUrl: base };
  const staticData = {}, trigger = new StabloraTrigger(), runs = [];
  let lastResponse;
  // The n8n webhook listener: hands the exact bytes to StabloraTrigger.webhook().
  const n8n = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks);
    const ctx = context({ credentials, params: { events: ['payment.completed'], confirm: true }, staticData, request: { headers: req.headers, rawBody, body: JSON.parse(rawBody) } });
    const result = await trigger.webhook.call(ctx);
    if (result.workflowData) runs.push(result.workflowData[0][0].json);
    lastResponse = result.noWebhookResponse ? ctx.response : { statusCode: 200, body: result.webhookResponse ?? { ok: true } };
    res.writeHead(lastResponse.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(lastResponse.body));
  });
  await new Promise(r => n8n.listen(0, '127.0.0.1', r)); t.after(() => n8n.close());
  const hookUrl = `http://127.0.0.1:${n8n.address().port}/webhook/abc/webhook`;
  const prev = process.env.WEBHOOK_ALLOWED_ORIGINS; process.env.WEBHOOK_ALLOWED_ORIGINS = new URL(hookUrl).origin; t.after(() => { process.env.WEBHOOK_ALLOWED_ORIGINS = prev ?? ''; });
  const hook = context({ credentials, params: { events: ['payment.completed'] }, staticData, webhookUrl: hookUrl });

  assert.equal(await trigger.webhookMethods.default.checkExists.call(hook), false);
  assert.equal(await trigger.webhookMethods.default.create.call(hook), true);
  assert.match(staticData.endpointId, /^we_/); assert.match(staticData.secret, /^whsec_/);
  assert.equal(await trigger.webhookMethods.default.checkExists.call(hook), true);

  // A real payment completes on the (sandbox) platform → payment.completed → n8n.
  const pay = p.createPayment(m.id, { reference: 'order-9', network: 'dogecoin', asset: 'DOGE', amount: '10' });
  p.recordTestDeposit(m.id, { paymentId: pay.id, amount: '10', transactionHash: 'sim_n8n_1' });
  await webhooks.dispatchWebhooks(p);
  assert.equal(runs.length, 1, 'workflow started once');
  assert.equal(runs[0].event, 'payment.completed'); assert.equal(runs[0].payment.id, pay.id); assert.equal(runs[0].payment.status, 'completed', 'status read back from the API');
  const delivery = p.get("SELECT d.event_id FROM webhook_deliveries d WHERE d.endpoint_id=? AND d.status='delivered'", staticData.endpointId);
  // Stablora redelivers the same event (e.g. a manual replay): no second run.
  p.run("UPDATE webhook_deliveries SET status='pending',next_attempt_at=? WHERE event_id=?", new Date(0).toISOString(), delivery.event_id);
  await webhooks.dispatchWebhooks(p);
  assert.equal(runs.length, 1, 'duplicate delivery ignored'); assert.deepEqual(lastResponse.body, { duplicate: true });
  // Forged request: wrong signature is refused before anything runs.
  const raw = JSON.stringify({ id: 'evt_forged', type: 'payment.completed', mode: 'sandbox', data: { paymentId: pay.id } });
  const forged = await fetch(hookUrl, { method: 'POST', body: raw, headers: { 'Stablora-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`, 'Stablora-Event-Id': 'evt_forged' } });
  assert.equal(forged.status, 401); assert.equal(runs.length, 1);

  assert.equal(await trigger.webhookMethods.default.delete.call(hook), true);
  assert.equal(staticData.endpointId, undefined);
  assert.equal(p.get('SELECT COUNT(*) n FROM webhook_endpoints WHERE merchant_id=? AND disabled_at IS NULL', m.id).n, 0, 'deactivation removes the endpoint');
});
