import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startHarness, type Harness } from './helpers/server.ts';
import { SETTINGS_CATEGORIES } from '../server/settings-pages.ts';
import { ASK_REUSE_MS } from '../server/settings-devices.ts';
import { startRemoteProxy } from '../electron/remote.mjs';
import { keyFromToken, open, peek } from '../server/relay-crypto.ts';

async function command(h: Harness, token: string, args: string[]) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/bloks.mjs', import.meta.url)), ...args], {
    env: { ...process.env, NODE_OPTIONS: '', HOME: h.home, BLOKS_URL: h.url, BLOKS_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (b) => out += b); child.stderr.on('data', (b) => err += b);
  const [code] = await once(child, 'close'); return { code, out, err };
}
/** An owner event stream that keeps every frame it is sent, so a test can
 * say both what arrived and what did not. */
async function ownerStream(origin: string, headers: Record<string, string> = {}) {
  const stop = new AbortController();
  const res = await fetch(origin + '/api/events', { signal: stop.signal, headers });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader(); const decoder = new TextDecoder();
  const frames: any[] = []; let text = '';
  const waiters = new Set<() => void>();
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) return;
        text += decoder.decode(next.value);
        const parts = text.split('\n\n'); text = parts.pop()!;
        for (const part of parts) if (part.startsWith('data: ')) frames.push(JSON.parse(part.slice(6)));
        for (const wake of [...waiters]) wake();
      }
    } catch { /* aborted */ }
  })();
  const next = async (kind: string, after = 0) => {
    for (let i = 0; i < 200; i++) {
      const found = frames.slice(after).find((frame) => frame.kind === kind);
      if (found) return found;
      await new Promise<void>((resolve) => { const wake = () => { waiters.delete(wake); resolve(); }; waiters.add(wake); setTimeout(wake, 50); });
    }
    throw new Error(`no ${kind} frame arrived`);
  };
  await next('hello');
  return { stop: () => stop.abort(), frames, next };
}
const snapshot = (theme: string) => ({ schema: 1, revision: 1, observedAt: 10, values: { 'theme.applied': { status: 'observed', value: theme } } });
const phoneSettings = (badges: boolean) => [
  { id: 'looks.roleBadges', kind: 'preference', value: { status: 'value', value: badges }, default: { status: 'value', value: true },
    owner: 'Conversation list', control: 'Settings > How it looks > Role badges' },
  { id: 'system.notifications', kind: 'system', value: { status: 'value', value: 'denied' }, default: null,
    owner: 'iOS', control: 'iOS Settings > Bloks > Notifications' },
  { id: 'pairing.token', kind: 'credential', value: { status: 'configured', configured: true },
    owner: 'Keychain', control: 'Settings > Mac connection > Pairing' },
];

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
    // NODE_OPTIONS splits on spaces and this checkout's path has one; a
    // file URL has none, where a bare path or a URL's pathname would.
    NODE_OPTIONS: `--import=${new URL('./helpers/settings-app-preload.mjs', import.meta.url).href}`,
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

  // First, before any other read has made an ask this one could join.
  await t.test('open owner windows are asked once per inspection, answer privately and are dated against the ask', async (st) => {
    const a = await ownerStream(app.url, { authorization: 'Bearer fixture-owner' });
    const b = await ownerStream(app.url);
    st.after(a.stop); st.after(b.stop);
    // nothing is asked while nobody inspects, and a non-device read asks nothing
    await read('workspace.general');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(![...a.frames, ...b.frames].some((frame) => frame.kind === 'settings-request'));
    const reading = read('device.browser');
    const [ra, rb] = await Promise.all([a.next('settings-request'), b.next('settings-request')]);
    assert.equal(ra.request, rb.request, 'one ask, sent to every owner stream');
    assert.equal(ra._seq, undefined, 'the ask is not a sequenced, replayable frame');
    for (const [stream, theme, label] of [[ra, 'dark', 'fixture-window-a'], [rb, 'light', 'fixture-window-b']] as const) {
      const sent = await request('/api/settings/device-report', undefined, 'POST', { kind: 'window', request: stream.request, label, snapshot: snapshot(theme) });
      assert.equal(sent.status, 200);
    }
    const observations = await reading; const text = JSON.stringify(observations);
    assert.match(text, /dark/); assert.match(text, /light/);
    assert.equal((text.match(/"freshness":"current"/g) ?? []).length, 2);
    assert.ok(!text.includes(ra.request), 'the ask id is never shown');
    // a second read straight after joins the same ask: no second frame
    const again = await read('device.browser');
    assert.equal((JSON.stringify(again).match(/"freshness":"current"/g) ?? []).length, 2);
    assert.equal([...a.frames].filter((frame) => frame.kind === 'settings-request').length, 1);
    // a phone report needs a paired identity, which loopback is not
    const phone = await request('/api/settings/device-report', 'fixture-owner', 'POST', { kind: 'phone', reason: 'connected', observedAt: 1, settings: phoneSettings(true) });
    assert.equal(phone.status, 409);
  });

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

  await t.test('members, invalid and expired credentials and raw writes cannot enter inspection or reports', async () => {
    for (const [token, status] of [['fixture-member', 403], ['invalid', 401], [tokens.expired!, 401], ['', 401]] as const) {
      for (const path of ['/api/agent/settings', '/api/settings/device-report']) {
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
      assert.equal((await request('/api/settings/device-report', tokens.alpha, method, method === 'GET' ? undefined : {})).status, 403);
    }
    // A relay header without the relay's own secret is only a header: the
    // request is the owner's loopback, and it cannot name a paired device.
    const forged = await app.fetch('/api/settings/device-report', { method: 'POST', headers: { 'x-bloks-relay-device': 'owner-device' },
      body: JSON.stringify({ kind: 'phone', reason: 'connected', observedAt: 1, settings: phoneSettings(true) }) });
    assert.equal(forged.status, 409);
    const unasked = await request('/api/settings/device-report', undefined, 'POST', { kind: 'window', label: 'fixture-window', snapshot: snapshot('dark') });
    assert.equal(unasked.status, 409, 'a loopback caller cannot plant a window report nobody asked for');
    const oversized = await request('/api/settings/device-report', undefined, 'POST', { kind: 'window', sentinel: 'BODY SENTINEL'.repeat(3000) });
    assert.equal(oversized.status, 400); assert.ok(!(await oversized.text()).includes('SENTINEL'));
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
    // a room holds two agents at least, so alpha's seat goes to two others
    const third = (await (await request('/api/bots', undefined, 'POST', { name: 'Gamma' })).json()).bot.id;
    for (let i = 0; i < 25; i++) {
      assert.equal((await request(`/api/bloks/room-${i}`, undefined, 'PATCH', { memberIds: ['beta', third] })).status, 200);
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

  const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
  assert.deepEqual(trace.readEffects, [], 'inspection reached IO, provider or registry discovery');
  assert.ok(trace.readRequests > 30, 'request-context traps did not observe the real read path');
  assert.equal(trace.modelCalls, 0, 'a model operation was attempted');
  assert.ok(!app.logs().includes('fixture-protected-value-123456'));
  await app.stop(); h = undefined; assert.ok(!existsSync(app.home), 'fixture HOME was not removed');
});

test('D1 a paired phone reports over the sealed relay channel, answers asks, and members are never asked', { timeout: 60_000 }, async (t) => {
  // The relay only forwards encrypted payloads. The production RelayLink owns
  // device authentication, anti-replay and trusted request attribution. The
  // Electron remote proxy stands in for the phone: it seals each request
  // with the paired device's own key, exactly as the phone does.
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
  let h: Harness | undefined;
  const proxies: Awaited<ReturnType<typeof startRemoteProxy>>[] = [];
  const streams: { stop: () => void }[] = [];
  t.after(async () => {
    streams.forEach((stream) => stream.stop());
    proxies.forEach((proxy) => proxy.stop()); if (h) { await h.stop(); assert.ok(!existsSync(h.home), 'remote fixture HOME was not removed'); }
    relay.closeAllConnections(); await new Promise<void>((resolve) => relay.close(() => resolve()));
    if (existsSync(tracePath)) t.diagnostic(`fixture trace: ${readFileSync(tracePath, 'utf8')}`);
    rmSync(files, { recursive: true, force: true });
  });
  h = await startHarness({ NODE_OPTIONS: `--import=${new URL('./helpers/settings-app-preload.mjs', import.meta.url).href}`,
    BLOKS_SETTINGS_TEST_TRACE: tracePath, BLOKS_SETTINGS_TEST_RELAY: relayUrl, BLOKS_LOOPBACK_ONLY: '1' });
  await connection;
  const phone = await startRemoteProxy({ relayUrl, relayToken: 'fixture-relay-client', deviceId: 'owner-device', deviceToken: 'fixture-owner' },
    { staticDir: files, client: 'iOS 3.0 (40)' });
  const member = await startRemoteProxy({ relayUrl, relayToken: 'fixture-relay-member', deviceId: 'member-device', deviceToken: 'fixture-member' }, { staticDir: files });
  proxies.push(phone, member);
  const origin = `http://127.0.0.1:${phone.port}`;
  const post = async (base: string, body: unknown) => {
    const response = await fetch(base + '/api/settings/device-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.status;
  };
  const read = async (category: string) => {
    const response = await h!.fetch(`/api/agent/settings?category=${category}`); assert.equal(response.status, 200); return response.json();
  };
  const phoneRow = (page: any) => page.rows.map((row: { observation: any }) => row.observation).find((row: any) => 'settings' in row);

  // Before the phone says anything, it is unavailable: never a default.
  // It is listening, and is asked, but has not answered.
  const stream = await ownerStream(origin); streams.push(stream);
  const first = read('device.phone');
  await stream.next('settings-request');
  let row = phoneRow(await first);
  assert.equal(row.status, 'unavailable'); assert.equal(row.settings, null);

  // It reports as it connects, over the paired channel, as itself.
  assert.equal(await post(origin, { kind: 'phone', reason: 'connected', observedAt: 1, settings: phoneSettings(true) }), 200);
  // A member's phone is turned away by the guard before any owner route.
  assert.notEqual(await post(`http://127.0.0.1:${member.port}`, { kind: 'phone', reason: 'connected', observedAt: 1, settings: phoneSettings(true) }), 200);

  // A later inspection asks again; a phone that does not answer keeps its
  // last word, dated. Past the reuse window, so this is a new ask.
  await new Promise((resolve) => setTimeout(resolve, ASK_REUSE_MS + 100));
  const seen = stream.frames.length;
  const reading = read('device.phone');
  const ask = await stream.next('settings-request', seen);
  row = phoneRow(await reading);
  assert.equal(row.status, 'last-reported', 'a report from before the ask is never shown as current');
  assert.equal(row.reportedBy.value, 'iOS 3.0 (40)');
  assert.deepEqual(row.settings.find((s: any) => s.id === 'looks.roleBadges').value, { status: 'value', value: true });
  assert.deepEqual(row.settings.find((s: any) => s.id === 'looks.roleBadges').default, { status: 'value', value: true });
  assert.deepEqual(row.settings.find((s: any) => s.id === 'pairing.token').value, { status: 'configured', configured: true });

  // The person changes it on the phone, and the answer to the ask says so.
  assert.equal(await post(origin, { kind: 'phone', request: ask.request, observedAt: 2, settings: phoneSettings(false) }), 200);
  row = phoneRow(await read('device.phone'));
  assert.equal(row.status, 'current');
  assert.deepEqual(row.settings.find((s: any) => s.id === 'looks.roleBadges').value, { status: 'value', value: false });
  assert.deepEqual(row.settings.find((s: any) => s.id === 'system.notifications').value, { status: 'value', value: 'denied' });
  assert.ok(!JSON.stringify(row).includes(ask.request));

  // A desktop window on a paired computer answers the same ask as a window.
  assert.equal(await post(origin, { kind: 'window', request: ask.request, label: 'remote-window-1', snapshot: snapshot('dark') }), 200);
  const browser = JSON.stringify(await read('device.browser'));
  assert.match(browser, /"path":"relay"/); assert.match(browser, /paired-owner-device/); assert.match(browser, /dark/);

  // The asks went sealed to the owner's device only, one per burst of reads.
  let asked = 0;
  for (const payload of eventPayloads) {
    const envelope = peek(payload); if (!envelope) continue;
    const owner = envelope.d === 'owner-device';
    const frame = open(keyFromToken(owner ? 'fixture-owner' : 'fixture-member', 'mac-to-phone'), envelope);
    if ((frame as { kind?: string } | null)?.kind === 'settings-request') { assert.ok(owner, 'a member device was asked'); asked++; }
  }
  assert.equal(asked, 2, 'one ask per burst of reads');

  // Revoked, the phone's word goes with it and it cannot report again.
  assert.equal((await h.fetch('/api/pair/devices/owner-device', { method: 'DELETE' })).status, 200);
  const after = await read('device.phone');
  assert.equal(phoneRow(after), undefined);
  assert.ok(!JSON.stringify(await read('device.browser')).includes('remote-window-1'));
  assert.notEqual(await post(origin, { kind: 'phone', reason: 'changed', observedAt: 3, settings: phoneSettings(true) }), 200);

  const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
  assert.deepEqual(trace.readEffects, []); assert.equal(trace.modelCalls, 0);
});
