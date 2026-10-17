import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startHarness, type Harness } from './helpers/server.ts';
import { SETTINGS_CATEGORIES } from '../server/settings-pages.ts';
import { startRemoteProxy } from '../electron/remote.mjs';
import { keyFromToken, open, peek } from '../server/relay-crypto.ts';

async function command(h: Harness, token: string, args: string[]) {
  const child = spawn(process.execPath, [new URL('../bin/bloks.mjs', import.meta.url).pathname, ...args], {
    env: { ...process.env, NODE_OPTIONS: '', HOME: h.home, BLOKS_URL: h.url, BLOKS_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (b) => out += b); child.stderr.on('data', (b) => err += b);
  const [code] = await once(child, 'close'); return { code, out, err };
}
async function ownerStream(h: Harness, token = 'fixture-owner') {
  const stop = new AbortController();
  const res = await fetch(h.url + '/api/events', { signal: stop.signal, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader(); const decoder = new TextDecoder(); let text = '';
  for (;;) {
    const next = await reader.read(); assert.ok(!next.done);
    text += decoder.decode(next.value);
    const frames = text.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const control = frames.find((frame) => frame.kind === 'settings-report');
    if (control) {
      assert.equal(frames[0].kind, 'hello', 'private admission must not displace hello');
      assert.equal(frames.filter((frame) => frame.kind === 'settings-report').length, 1);
      return { stop: () => stop.abort(), control };
    }
  }
}

test('S1-S5 actual index routes and real CLI use owner metadata without read-triggered IO or providers', { timeout: 60_000 }, async (t) => {
  const files = mkdtempSync(join(tmpdir(), 'bloks-settings-app-'));
  const tracePath = join(files, 'trace.json');
  let h: Harness | undefined;
  t.after(async () => {
    if (h) await h.stop();
    if (existsSync(tracePath)) t.diagnostic(`fixture trace: ${readFileSync(tracePath, 'utf8')}`);
    rmSync(files, { recursive: true, force: true });
  });
  h = await startHarness({
    NODE_OPTIONS: `--import=${new URL('./helpers/settings-app-preload.mjs', import.meta.url).pathname}`,
    BLOKS_SETTINGS_TEST_TRACE: tracePath,
  });
  const app = h;
  const tokens = JSON.parse(readFileSync(join(app.home, '.bloks/fixture-tokens.json'), 'utf8')) as Record<string, string>;
  const request = (path: string, token?: string, method = 'GET', body?: unknown) => app.fetch(path, {
    method, headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = async (category: string, token = tokens.alpha!, suffix = '') => {
    const response = await request(`/api/agent/settings?category=${category}${suffix}`, token);
    assert.equal(response.status, 200, category); assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };

  await t.test('all 25 categories traverse real authentication and loaded-owner projection', async () => {
    const index = await request('/api/agent/settings', tokens.alpha);
    assert.equal(index.status, 200); const advertised = await index.json();
    assert.equal(advertised.categories.length, SETTINGS_CATEGORIES.length);
    for (const [category] of SETTINGS_CATEGORIES) {
      const page = await read(category);
      assert.equal(page.category, category); assert.ok(Array.isArray(page.rows));
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
      assert.ok(!JSON.stringify(page).includes('fixture-protected-value-123456'), category);
      for (const row of page.rows) assert.notEqual(row.observation.reason, 'owner_observation_unavailable', category);
    }
    const general = await read('workspace.general');
    assert.equal(general.rows[0].observation.fields.find((f: { id: string }) => f.id === 'agents.turnLimit').effective.value, 24);
    const skills = await read('projects.skills');
    assert.ok(JSON.stringify(skills).includes('natural skill-owner reads only'));
  });

  await t.test('members, invalid and expired credentials and raw writes cannot enter inspection or report owners', async () => {
    for (const [token, status] of [['fixture-member', 403], ['invalid', 401], [tokens.expired!, 401], ['', 401]] as const) {
      for (const path of ['/api/agent/settings', '/api/settings/device-session', '/api/settings/device-report']) {
        const response = await request(path, token, path.endsWith('settings') ? 'GET' : 'POST', path.endsWith('settings') ? undefined : { secret: 'REJECTED BODY SENTINEL' });
        assert.equal(response.status, status, `${path} ${status}`);
        assert.ok(!(await response.text()).includes('SENTINEL'));
      }
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await request('/api/agent/settings', tokens.alpha, method, {})).status, 403);
      assert.equal((await request('/api/agent/settings', undefined, method, {})).status, 405);
    }
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await request('/api/config', tokens.alpha, method, method === 'GET' ? undefined : {})).status, 403);
      for (const path of ['/api/settings/device-session', '/api/settings/device-report']) {
        assert.equal((await request(path, tokens.alpha, method, method === 'GET' ? undefined : {})).status, 403);
      }
    }
    const forged = await app.fetch('/api/agent/settings', { headers: { 'x-bloks-relay-device': 'owner-device' } });
    assert.equal(forged.status, 401);
  });

  await t.test('room visibility precedes totals, selection and signed caller/category continuations', async () => {
    const alpha = await read('room'); assert.equal(alpha.total, 25);
    assert.ok(alpha.rows.length > 0 && alpha.rows.length <= 20); assert.ok(alpha.continuation);
    assert.ok(!JSON.stringify(alpha).includes('PRIVATE ROOM SENTINEL'));
    const beta = await read('room', tokens.beta!); assert.equal(beta.total, 1);
    const hidden = beta.rows[0].reference;
    assert.equal((await request(`/api/agent/settings?category=room&id=${hidden}`, tokens.alpha)).status, 404);
    for (const [category, token] of [['room', tokens.beta!], ['agent', tokens.alpha!]]) {
      const response = await request(`/api/agent/settings?category=${category}&cursor=${alpha.continuation}`, token);
      assert.equal(response.status, 400);
    }
    const rows = [...alpha.rows]; let cursor = alpha.continuation;
    for (let count = 0; cursor && count < 4; count++) {
      const next = await read('room', tokens.alpha!, `&cursor=${cursor}`);
      assert.ok(next.rows.length > 0); rows.push(...next.rows); cursor = next.continuation;
    }
    assert.equal(cursor, null, 'byte-bounded pages did not finish');
    assert.equal(rows.length, 25); assert.equal(new Set(rows.map((r: { reference: string }) => r.reference)).size, 25);
    for (let i = 0; i < 25; i++) {
      assert.equal((await request(`/api/bloks/room-${i}`, undefined, 'PATCH', { memberIds: ['beta'] })).status, 200);
    }
    const lost = await read('room', tokens.alpha!, `&cursor=${alpha.continuation}`);
    assert.equal(lost.total, 0); assert.deepEqual(lost.rows, []); assert.equal(lost.continuation, null);
    assert.equal((await request(`/api/agent/settings?category=room&id=${rows[0].reference}`, tokens.alpha)).status, 404);
  });

  await t.test('real CLI help is local and one settings command makes exactly one authenticated GET', async () => {
    const before = JSON.parse(readFileSync(tracePath, 'utf8')).readRequests;
    const help = await command(app, tokens.alpha!, ['help']); assert.equal(help.code, 0, help.err); assert.match(help.out, /settings.*--category/);
    assert.equal(JSON.parse(readFileSync(tracePath, 'utf8')).readRequests, before);
    const result = await command(app, tokens.alpha!, ['settings', '--category', 'workspace.general']);
    assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).category, 'workspace.general');
    assert.equal(JSON.parse(readFileSync(tracePath, 'utf8')).readRequests, before + 1);
  });

  await t.test('real direct SSE sessions report independently, keep authority private and invalidate actual close', async (st) => {
    const a = await ownerStream(app); const b = await ownerStream(app);
    st.after(a.stop); st.after(b.stop);
    assert.notEqual(a.control.windowKey, b.control.windowKey);
    const data = (theme: string, revision: number) => ({ schema: 1, revision, observedAt: 10, values: { 'theme.applied': { status: 'observed', value: theme } } });
    for (const [stream, theme] of [[a, 'dark'], [b, 'light']] as const) {
      assert.equal((await request('/api/settings/device-report', 'fixture-owner', 'POST', { admission: stream.control.admission, sequence: 1, snapshot: data(theme, 1) })).status, 200);
    }
    const observations = await read('device.browser'); const text = JSON.stringify(observations);
    assert.match(text, /dark/); assert.match(text, /light/);
    for (const stream of [a, b]) for (const secret of [stream.control.windowKey, stream.control.admission.capability, stream.control.admission.generation]) assert.ok(!text.includes(secret));
    const oversized = await request('/api/settings/device-report', 'fixture-owner', 'POST', { admission: a.control.admission, sentinel: 'BODY SENTINEL'.repeat(3000) });
    assert.equal(oversized.status, 400); assert.ok(!(await oversized.text()).includes('SENTINEL'));
    assert.equal((await request('/api/settings/device-report', 'fixture-owner', 'POST', { admission: b.control.admission, sequence: 1, snapshot: data('dark', 2) })).status, 409);
    a.stop();
    let closed = false;
    for (let i = 0; i < 30; i++) {
      const page = await read('device.browser');
      closed = JSON.stringify(page).includes('observed-closed');
      if (closed) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(closed, 'actual response close did not invalidate the window');
    assert.equal((await request('/api/settings/device-session', 'fixture-owner', 'POST', { action: 'renew', windowKey: a.control.windowKey })).status, 409);
    const retained = JSON.stringify(await read('device.browser')); assert.match(retained, /dark/); assert.match(retained, /unknown/);
  });

  const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
  assert.deepEqual(trace.readEffects, [], 'inspection reached IO, provider or registry discovery');
  assert.ok(trace.readRequests > 30, 'request-context traps did not observe the real read path');
  assert.equal(trace.modelCalls, 0, 'a model operation was attempted');
  assert.ok(!app.logs().includes('fixture-protected-value-123456'));
  await app.stop(); h = undefined; assert.ok(!existsSync(app.home), 'fixture HOME was not removed');
});

test('D1 real index and RelayLink with actual Electron proxy keep separate remote windows and report authority private', { timeout: 60_000 }, async (t) => {
  // The relay only forwards encrypted payloads. The production RelayLink owns
  // device authentication, anti-replay and trusted request attribution.
  const files = mkdtempSync(join(tmpdir(), 'bloks-settings-app-relay-'));
  const tracePath = join(files, 'trace.json'); writeFileSync(join(files, 'index.html'), '<!doctype html><title>Fixture</title>');
  const pending = new Map<string, ServerResponse>(); const clients = new Set<ServerResponse>();
  const eventPayloads: string[] = []; let upstream: ServerResponse | null = null;
  let connected!: () => void; const connection = new Promise<void>((resolve) => connected = resolve);
  const relay = createServer(async (req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/space/agent/stream') {
      upstream = res; res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"kind":"hello","spaceId":"fixture-space"}\n\n'); connected(); return;
    }
    if (path === '/space/client/stream') {
      clients.add(res); res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"kind":"hello","online":true}\n\n'); req.on('close', () => clients.delete(res)); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (path === '/space/client/ask') {
      if (!upstream) { res.writeHead(503).end('{}'); return; }
      const id = randomUUID(); pending.set(id, res);
      upstream.write(`data: ${JSON.stringify({ kind: 'ask', id, payload: body.payload })}\n\n`); return;
    }
    if (path === '/space/agent/result') {
      const answer = pending.get(body.id); pending.delete(body.id);
      answer?.writeHead(200, { 'content-type': 'application/json' }); answer?.end(JSON.stringify({ payload: body.payload }));
    }
    if (path === '/space/agent/events') for (const payload of body.frames ?? []) {
      eventPayloads.push(payload);
      for (const client of clients) client.write(`data: ${JSON.stringify({ kind: 'frame', payload })}\n\n`);
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  let h: Harness | undefined; let proxy: Awaited<ReturnType<typeof startRemoteProxy>> | undefined;
  t.after(async () => {
    proxy?.stop(); if (h) { await h.stop(); assert.ok(!existsSync(h.home), 'remote fixture HOME was not removed'); }
    relay.closeAllConnections(); await new Promise<void>((resolve) => relay.close(() => resolve()));
    if (existsSync(tracePath)) t.diagnostic(`fixture trace: ${readFileSync(tracePath, 'utf8')}`);
    rmSync(files, { recursive: true, force: true });
  });
  h = await startHarness({ NODE_OPTIONS: `--import=${new URL('./helpers/settings-app-preload.mjs', import.meta.url).pathname}`,
    BLOKS_SETTINGS_TEST_TRACE: tracePath, BLOKS_SETTINGS_TEST_RELAY: relayUrl, BLOKS_LOOPBACK_ONLY: '1' });
  await connection;
  proxy = await startRemoteProxy({ relayUrl, relayToken: 'fixture-relay-client', deviceId: 'owner-device', deviceToken: 'fixture-owner' }, { staticDir: files });
  const origin = `http://127.0.0.1:${proxy.port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const streams: { stop: () => void; control: any }[] = [];
  t.after(() => streams.forEach((stream) => stream.stop()));
  for (let i = 0; i < 2; i++) {
    const stop = new AbortController(); const res = await fetch(origin + '/api/events', { signal: stop.signal });
    assert.equal(res.status, 200); const reader = res.body!.getReader(); const decoder = new TextDecoder(); let bytes = ''; let control: any;
    while (!control) {
      const next = await reader.read(); assert.ok(!next.done); bytes += decoder.decode(next.value);
      control = bytes.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))).find((frame) => frame.kind === 'settings-report');
    }
    streams.push({ stop: () => stop.abort(), control });
  }
  for (const [i, stream] of streams.entries()) {
    const result = await post('/api/settings/device-session', { action: 'renew', windowKey: stream.control.windowKey });
    assert.equal(result.status, 200, 'remote report admission did not reach real workspace auth');
    stream.control.admission = result.body.admission;
    const sent = await post('/api/settings/device-report', { ...stream.control, sequence: 1,
      snapshot: { schema: 1, revision: 1, observedAt: 10, values: { 'theme.applied': { status: 'observed', value: i ? 'light' : 'dark' } } } });
    assert.equal(sent.status, 200);
  }
  assert.notEqual(streams[0]!.control.windowKey, streams[1]!.control.windowKey);
  const read = async () => {
    const response = await h!.fetch('/api/agent/settings?category=device.browser'); assert.equal(response.status, 200); return response.json();
  };
  const inspected = await read();
  const observations = inspected.rows.map((row: { observation: any }) => row.observation).filter((row: any) => row.source);
  assert.equal(observations.length, 2, 'workspace SSE association cannot represent proxy-local windows');
  for (const row of observations) { assert.equal(row.source.path, 'remote'); assert.equal(row.transportKnowledge, 'unconfirmed'); }
  assert.match(JSON.stringify(inspected), /dark/); assert.match(JSON.stringify(inspected), /light/);
  for (const stream of streams) for (const secret of [stream.control.windowKey, stream.control.admission.capability, stream.control.admission.generation]) {
    assert.ok(!JSON.stringify(inspected).includes(secret));
  }
  assert.equal((await post('/api/settings/device-report', { windowKey: streams[1]!.control.windowKey, admission: streams[0]!.control.admission, sequence: 2 })).status, 409);
  assert.equal((await post('/api/settings/device-session', { action: 'renew', windowKey: streams[0]!.control.windowKey }, { authorization: 'Bearer fixture-member' })).status, 403);
  streams[0]!.stop();
  let observedClose = false;
  for (let i = 0; i < 30; i++) {
    observedClose = JSON.stringify(await read()).includes('observed-closed'); if (observedClose) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(observedClose, 'proxy close did not invalidate its real workspace generation');
  assert.equal((await h.fetch('/api/pair/devices/owner-device', { method: 'DELETE' })).status, 200);
  const revoked = JSON.stringify(await read()); assert.match(revoked, /revoked/); assert.match(revoked, /light/);
  const afterRevoke = await post('/api/settings/device-session', { action: 'renew', windowKey: streams[1]!.control.windowKey });
  assert.notEqual(afterRevoke.status, 200, 'revoked encrypted device renewed report authority');
  for (const payload of eventPayloads) {
    const envelope = peek(payload); if (!envelope) continue;
    const frame = open(keyFromToken('fixture-owner', 'mac-to-phone'), envelope);
    assert.ok(!JSON.stringify(frame).includes('settings-report'), 'private control entered the broadcast relay stream');
  }
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')); assert.deepEqual(trace.readEffects, []); assert.equal(trace.modelCalls, 0);
});
