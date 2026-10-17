// Isolated real-server proof only. This preloader is never imported by the app.
// Tokens are minted by its actual AgentTokens owner, without starting a turn.
// Factories are fake before index.ts can construct any real provider.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

if (!process.env.BLOKS_SETTINGS_TEST_TRACE || !process.env.HOME?.includes('bloks-test-')) {
  throw new Error('settings proof requires a disposable harness HOME');
}
const tracePath = process.env.BLOKS_SETTINGS_TEST_TRACE;
// Only the rendered fixture uses neutral names and completed onboarding.
const renderedFixture = process.env.BLOKS_SETTINGS_TEST_UI === '1';
const root = join(process.env.HOME, '.bloks');
const write = fs.writeFileSync.bind(fs);
const rename = fs.renameSync.bind(fs);
const context = new AsyncLocalStorage();
const trace = { readRequests: 0, readEffects: [], blockedBackground: [], fakeSnapshots: 0, modelCalls: 0 };
const flush = () => context.run(false, () => {
  write(tracePath + '.tmp', JSON.stringify(trace), { mode: 0o600 }); rename(tracePath + '.tmp', tracePath);
});
const effect = (operation) => {
  if (context.getStore()) {
    if (trace.readEffects.length < 50) trace.readEffects.push(operation); flush();
    throw new Error('settings read side effect blocked');
  }
};
for (const name of Object.keys(process.env)) {
  if (/KEY|TOKEN|SECRET|PASSWORD|AUTH/.test(name)) delete process.env[name];
}
process.env.CODEX_HOME = join(process.env.HOME, '.codex');
process.env.CLAUDE_CONFIG_DIR = join(process.env.HOME, '.claude');
process.env.BLOKS_URL = '';
fs.mkdirSync(root, { recursive: true });
const device = (id, token, member = false) => ({ id, name: 'Fixture device',
  hash: createHash('sha256').update(token).digest('hex'), pairedAt: 1,
  ...(member ? { personId: 'fixture-member' } : {}) });
write(join(root, 'config.json'), JSON.stringify({
  ...(renderedFixture ? { setupDoneAt: 1 } : {}),
  brief: { enabled: false }, backups: { auto: false }, agents: { turnLimit: 24 },
  profile: { name: 'Fixture owner', about: 'Fixture context' },
  remote: { enabled: false, devices: [device('owner-device', 'fixture-owner'),
    ...(renderedFixture ? [device('second-owner-device', 'fixture-owner-two')] : [])],
    memberDevices: [device('member-device', 'fixture-member', true)] },
  secrets: { FIXTURE_CREDENTIAL: 'fixture-protected-value-123456' },
  ...(process.env.BLOKS_SETTINGS_TEST_RELAY ? { relay: {
    enabled: true, url: process.env.BLOKS_SETTINGS_TEST_RELAY, agentToken: 'fixture-relay-agent',
  } } : {}),
  providers: {}, instances: { codex: { driver: 'codex' } },
}));
write(join(root, 'bots.json'), JSON.stringify(['alpha', 'beta'].map((id) => ({
  id, name: id === 'alpha' ? (renderedFixture ? 'Alpha' : 'fixture-protected-value-123456') : 'Beta', title: 'Fixture', description: '',
  ...(renderedFixture ? { computer: 'sandbox', unread: false } : {}),
  threadId: `${id}-lane`, activeTaskId: `${id}-lane`, tasks: [{ id: `${id}-lane`, title: 'General', createdAt: 1 }],
  createdAt: 1, modelSelection: { instanceId: 'codex', model: 'fixture-model' },
  skills: [], color: 'blue', shape: 'star', busy: false,
}))));
write(join(root, 'bloks.json'), JSON.stringify(Array.from({ length: 25 }, (_, i) => ({
  id: `room-${i}`, name: `Fixture room ${i}`, memberIds: ['alpha'], createdAt: 1,
})).concat([{ id: 'hidden-room', name: 'PRIVATE ROOM SENTINEL', memberIds: ['beta'], createdAt: 1 }])));

for (const name of ['readFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync',
  'readdirSync', 'statSync', 'lstatSync', 'accessSync', 'existsSync', 'openSync', 'rmSync', 'unlinkSync', 'watch']) {
  const original = fs[name].bind(fs);
  fs[name] = (...args) => { effect(`fs.${name}`); return original(...args); };
}
for (const name of ['readFile', 'writeFile', 'appendFile', 'rename', 'mkdir', 'readdir', 'stat',
  'lstat', 'access', 'open', 'rm', 'unlink']) {
  const original = fsp[name].bind(fsp);
  fsp[name] = async (...args) => { effect(`fsp.${name}`); return original(...args); };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[name] = () => {
    effect(`subprocess.${name}`); trace.blockedBackground.push(`subprocess.${name}`); flush();
    throw new Error('fixture forbids subprocesses');
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  effect('fetch');
  const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url ?? args[0]);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    trace.blockedBackground.push('external-fetch'); flush();
    throw new Error('fixture forbids external fetch');
  }
  return originalFetch(...args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  effect('network.connect');
  const options = typeof args[0] === 'object' ? args[0] : {};
  const host = options.host ?? options.hostname ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    trace.blockedBackground.push('external-connect'); flush();
    throw new Error('fixture forbids external connections');
  }
  return connect.apply(this, args);
};
const createServer = http.createServer.bind(http);
http.createServer = (...args) => {
  const i = args.findIndex((arg) => typeof arg === 'function');
  if (i >= 0) {
    const listener = args[i];
    args[i] = (req, res) => {
      const inspection = req.url?.split('?')[0] === '/api/agent/settings';
      if (inspection) { trace.readRequests++; flush(); res.once('finish', flush); }
      return context.run(inspection, () => listener(req, res));
    };
  }
  return createServer(...args);
};
syncBuiltinESMExports();

const { BUILT_IN_DRIVERS } = await import('../../server/drivers/builtIn.ts');
for (const driver of BUILT_IN_DRIVERS) {
  for (const method of ['defaultConfig', 'decodeConfig']) {
    const original = driver[method].bind(driver);
    driver[method] = (...args) => { effect(`driver.${method}`); return original(...args); };
  }
  driver.create = async (input) => {
    effect('driver.create');
    const prohibited = async () => { trace.modelCalls++; flush(); throw new Error('no model operation is allowed'); };
    return { instanceId: input.instanceId, driverKind: driver.driverKind, displayName: input.displayName,
      enabled: input.enabled, models: { default: 'fixture-model', options: [{ id: 'fixture-model', label: 'Fixture' }] },
      adapter: { provider: driver.driverKind, capabilities: { sessionModelSwitch: 'unsupported' },
        onEvent: () => () => {}, hasSession: () => false, stopAll: async () => {},
        sendTurn: prohibited, interruptTurn: async () => {}, respondToRequest: prohibited },
      snapshot: async () => { effect('provider.snapshot'); trace.fakeSnapshots++; flush();
        return { state: 'unavailable', reason: 'isolated fake provider' }; },
      dispose: async () => {}, generateText: prohibited,
    };
  };
}
const { ProviderRegistry } = await import('../../server/harness/registry.ts');
for (const method of ['describe', 'load', 'reload']) {
  const original = ProviderRegistry.prototype[method];
  ProviderRegistry.prototype[method] = function (...args) { effect(`registry.${method}`); return original.apply(this, args); };
}
const { AgentTokens } = await import('../../server/agent-cli.ts');
const identify = AgentTokens.prototype.identify;
let minted = false;
AgentTokens.prototype.identify = function (...args) {
  if (!minted) {
    minted = true;
    const alpha = this.mint('alpha', 'alpha-lane', Date.now()).token;
    const beta = this.mint('beta', 'beta-lane', Date.now()).token;
    const expired = this.mint('alpha', 'expired-lane', 0).token;
    write(join(root, 'fixture-tokens.json'), JSON.stringify({ alpha, beta, expired }), { mode: 0o600 });
  }
  return identify.apply(this, args);
};
flush();
