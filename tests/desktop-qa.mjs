import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { createSocket } from 'node:dgram';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../ui/package.json', import.meta.url));
const { AccessToken, RoomServiceClient, TrackSource } = require('livekit-server-sdk');
const [stage, output, livekit, mode, backend, updateFolder, updateKey] = process.argv.slice(2);
if (!stage || !output || !livekit) throw new Error('Usage: desktop-qa.mjs <app-stage> <new-output-dir> <livekit-server.exe> [voice-only|full|optional-update|forced-update|immediate-update|required-exit] [server.test.exe] [update-fixture public-key.json]');
const updateTest = ['optional-update', 'forced-update', 'immediate-update', 'required-exit'].includes(mode);
const expectMusic = !updateTest && mode !== 'voice-only';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const random = () => randomBytes(24).toString('hex');
const children = [];
const wait = async (fn, ms = 45000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { }
    await sleep(200);
  }
  throw new Error('condition timed out');
};
await mkdir(output, { recursive: false });
const out = resolve(output);
const tcpPort = () => new Promise((resolve, reject) => {
  const probe = createTcp().listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  probe.on('error', reject);
});
const udpPort = () => new Promise((resolve, reject) => {
  const probe = createSocket('udp4').bind(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  probe.on('error', reject);
});
const port = await tcpPort();
const rtcTcp = await tcpPort(), rtcUdp = await udpPort();
const base = 'http://127.0.0.1:' + port;
const apiKey = random(), secret = random();
const config = [
  'port: ' + port, 'bind_addresses: ["127.0.0.1"]', 'log_level: error', 'keys:', '  ' + apiKey + ': "' + secret + '"',
  'room:', '  auto_create: false', 'rtc:', '  tcp_port: ' + rtcTcp, '  udp_port: ' + rtcUdp,
  '  node_ip: 127.0.0.1', '  use_external_ip: false', '  enable_loopback_candidate: true', '  ips:', '    includes: ["127.0.0.1/32"]',
].join('\n');
function launch(file, args, options = {}) {
  const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', ...options });
  child.on('error', () => {});
  children.push(child);
  return child;
}
const lk = launch(livekit, ['--bind', '127.0.0.1'], { env: { ...process.env, LIVEKIT_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
for (const stream of [lk.stdout, lk.stderr]) stream.on('data', chunk => {
  serverOutput = (serverOutput + chunk.toString().replaceAll(apiKey, '[redacted]').replaceAll(secret, '[redacted]')).slice(-4096);
});
const names = ['星野', '阿澈', '小满', '凌风', '墨羽', '小白'];
const accounts = names.map((name, i) => {
  const password = random(), salt = randomBytes(16);
  return { username: 'qa' + (i + 1), id: 'tester-' + (i + 1), name, password, salt, hash: scryptSync(password, salt, 32) };
});
const releaseVersion = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim();
const sessions = new Map();
const roomName = backend ? 'voice-lobby-5' : 'voice-lobby';
const channels = [
  { id: roomName, name: '开黑大厅', description: '自由聊天 · 5 人小队', capacity: 5 },
  { id: 'tactical', name: '战术一队', description: '一起打排位', capacity: 5 },
  { id: 'break', name: '休息室', description: '等人和闲聊', capacity: 5 },
];
const roomSvc = new RoomServiceClient(base, apiKey, secret);
let broker;
let backendProcess;
const receipts = [];
function reply(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 8192) throw new Error('body size'); }
  return JSON.parse(data || '{}');
}
try {
  await wait(async () => { if (lk.exitCode !== null) return false; return (await fetch(base)).ok; }, 13000).catch(() => {
    throw new Error('LiveKit bootstrap failed. ' + serverOutput);
  });
  let endpoint;
  if (backend) {
    const config = { LiveKit: base, Key: apiKey, Secret: secret, ChatFixtures: !updateTest, Owner: accounts[0].username, Updates: updateFolder ?? '', UpdatesPublicKey: updateKey ?? '',
      Accounts: accounts.map((a, index) => ({ Username: a.username, Name: a.name, Password: a.password, Admin: index === 0 })) };
    backendProcess = spawn(backend, ['-test.run=^TestDesktopBroker$', '-test.v'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SQUADVOICE_TEST_DESKTOP_BROKER: JSON.stringify(config), SQUADVOICE_TEST_TEMP: out },
    });
    let output = '';
    for (const stream of [backendProcess.stdout, backendProcess.stderr]) stream.on('data', chunk => {
      output = (output + chunk.toString()).slice(-2048);
    });
    const started = await wait(() => /SV_TEST_READY=(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1], 15000)
      .catch(() => { throw new Error('Go backend fixture failed: ' + output); });
    endpoint = started;
  } else {
    for (const channel of channels) await roomSvc.createRoom({ name: channel.id, maxParticipants: 5, emptyTimeout: 240 });
    broker = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') return reply(res, 405, {});
      const data = await body(req);
      if (req.url === '/api/v1/login') {
        const user = accounts.find(a => a.username === data.username);
        if (!user || typeof data.password !== 'string' || !timingSafeEqual(scryptSync(data.password, user.salt, 32), user.hash)) return reply(res, 401, {});
        const session = random();
        sessions.set(session, user);
        return reply(res, 200, { sessionToken: session, user: { id: user.id, name: user.name }, workspace: { name: '夜航开黑小队', channels } });
      }
      const auth = req.headers.authorization?.slice(7) || '';
      const user = sessions.get(auth);
      if (!user) return reply(res, 401, {});
      if (req.url === '/api/v1/logout') { sessions.delete(auth); return reply(res, 200, {}); }
      if (req.url !== '/api/v1/voice/join' || !channels.some(c => c.id === data.channelId)) return reply(res, 403, {});
      const participants = await roomSvc.listParticipants(data.channelId);
      if (participants.length >= 5 && !participants.some(p => p.identity === user.id)) return reply(res, 409, {});
      const token = new AccessToken(apiKey, secret, { identity: user.id, name: user.name, ttl: '2m' });
      token.addGrant({ roomJoin: true, room: data.channelId, canPublish: true, canSubscribe: true, canPublishData: false,
        canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE_AUDIO] });
      return reply(res, 200, { serverUrl: base.replace('http:', 'ws:'), accessToken: await token.toJwt() });
    } catch { return reply(res, 500, {}); }
    });
    await new Promise((resolve, reject) => { broker.on('error', reject); broker.listen(0, '127.0.0.1', resolve); });
    endpoint = 'http://127.0.0.1:' + broker.address().port;
  }
  if (expectMusic) {
    const fx = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const tone = join(out, 'SquadToneA.exe');
    const compiled = spawnSync(fx, ['/nologo','/target:winexe','/platform:x64','/out:' + tone, fileURLToPath(new URL('./Tone.cs', import.meta.url))], { windowsHide: true, encoding: 'utf8' });
    if (compiled.status !== 0) throw new Error('Synthetic audio compile failed: ' + compiled.stdout);
    await copyFile(tone, join(out, 'SquadToneB.exe'));
    launch(tone, ['540']);
    launch(join(out, 'SquadToneB.exe'), ['1390']);
  }
  async function startClient(index, kind, existingDirectory, installation = stage) {
    const directory = existingDirectory ?? join(out, 'client-' + (index + 1));
    if (!existingDirectory) await mkdir(directory);
    const a = accounts[index];
    const input = { number: index + 1, mode: kind, endpoint, username: a.username, password: a.password, expectMusic, accountEndpoints: Boolean(backend), releaseVersion };
    return {
      directory,
      process: launch(join(installation, 'SquadVoice.exe'), [], {
        cwd: installation, env: { ...process.env, SQUADVOICE_DATA_DIR: directory, SQUADVOICE_QA_INPUT: JSON.stringify(input) },
      }),
    };
  }
  if (updateTest) {
    if (!backend || !updateFolder || !updateKey) throw new Error('update tests require the backend, signed release fixture, and its public key');
    const installation = join(out, 'Installed Squad Voice');
    await cp(stage, installation, { recursive: true });
    const app = await startClient(0, mode, undefined, installation);
    const resultPath = join(app.directory, 'qa-result.json');
    const readReport = async () => JSON.parse(await readFile(resultPath, 'utf8'));
    const before = await wait(readReport, 45000);
    if (!before.ok) throw new Error(JSON.stringify(before));
    await wait(() => app.process.exitCode === 0, 10000);
    await wait(async () => {
      const marker = await readFile(join(installation, 'app', 'qa-update-installed.txt'), 'utf8');
      return marker.trim() === releaseVersion;
    }, 15000);
    let reopened = false;
    if (mode === 'immediate-update') {
      const after = await wait(async () => {
        const result = await readReport();
        return result.reopened || !result.ok ? result : null;
      }, 24000);
      if (!after.ok || !after.defaultScreen) throw new Error(JSON.stringify(after));
      reopened = true;
    } else {
      await sleep(3000);
      if ((await readReport()).reopened) throw new Error('deferred update unexpectedly restarted the client');
    }
    const report = { ...before, installed: true, reopened };
    await writeFile(join(out, 'desktop-qa.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } else {
  const lifecycle = {};
  const lifecycleDir = join(out, 'desktop-lifecycle');
  await mkdir(lifecycleDir);
  for (const mode of ['persist', 'resume', 'signed-out']) {
    const resultPath = join(lifecycleDir, 'qa-result.json');
    await unlink(resultPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const launched = await startClient(0, mode, lifecycleDir);
    const receipt = await wait(async () => JSON.parse(await readFile(resultPath, 'utf8')), 45000);
    if (!receipt.ok) throw new Error('Desktop lifecycle ' + mode + ': ' + JSON.stringify(receipt));
    lifecycle[mode] = receipt;
    await wait(() => launched.process.exitCode === 0, 10000);
  }
  console.log('Desktop restart, local microphone test and tray checks passed.');
  const five = await Promise.all(accounts.slice(0,5).map((_, i) => startClient(i, 'normal')));
  console.log('Started five isolated Windows clients.');
  await wait(async () => (await roomSvc.listParticipants(roomName)).length === 5, 48000).catch(async () => {
    const failed = await Promise.all(five.map(async (c) => { try { return JSON.parse(await readFile(join(c.directory,'qa-result.json'), 'utf8')); } catch { return { exit: c.process.exitCode }; } }));
    throw new Error('Five participants did not join: ' + JSON.stringify(failed));
  });
  const extra = await startClient(5, 'full');
  const all = [...five, extra];
  await Promise.all(all.map(async (client, index) => {
    const report = await wait(async () => JSON.parse(await readFile(join(client.directory, 'qa-result.json'), 'utf8')), 65000);
    receipts[index] = { client: index + 1, ...report };
  }));
  const secured = await Promise.all(five.map(async (client, index) => {
    const content = await readFile(join(client.directory,'connection.dpapi'));
    const known = [endpoint, accounts[index].username, accounts[index].password, apiKey, secret];
    const clean = !known.some(s => content.includes(Buffer.from(s)) || content.includes(Buffer.from(s,'utf16le')));
    const prefs = await readFile(join(client.directory, 'Public', 'preferences.json'), 'utf8');
    return content.length > 40 && clean && !known.some(s => prefs.includes(s));
  }));
  const ok = receipts.every(report => report.ok) && secured.every(Boolean) &&
    receipts[5].roomFull === true && receipts.slice(0,5).every(report => report.remoteMicrophones === 4) &&
    (!expectMusic || (!!receipts[0].isolation && receipts.slice(1,5).every(report => report.remoteMusic?.packets > 12)));
  const report = { ok, livekit: '1.13.11', goBackend: Boolean(backend), isolatedDesktopClients: 5, rejectedSixth: receipts[5].roomFull === true,
    plaintextCredentialsInFiles: false, protectedProfiles: secured, lifecycle, accompaniment: expectMusic, clients: receipts };
  await writeFile(join(out, 'desktop-qa.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!ok) process.exitCode = 1;
  }
} catch (error) {
  const text = String(error.message).replaceAll(apiKey, '[redacted]').replaceAll(secret, '[redacted]');
  await writeFile(join(out, 'desktop-qa.json'), JSON.stringify({ ok: false, error: text, clients: receipts }, null, 2));
  console.error(text);
  process.exitCode = 1;
} finally {
  if (backendProcess && backendProcess.exitCode === null) {
    backendProcess.stdin.end();
    await wait(() => backendProcess.exitCode !== null, 5000).catch(() => backendProcess.kill());
  }
  for (const child of children.reverse()) if (child.exitCode === null) child.kill();
  if (broker) { broker.closeAllConnections(); broker.close(); }
}
