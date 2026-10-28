'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { LocalSendService, API } = require('../src/service');
const { loadCertificate } = require('../src/certificate');

test('automatic fallback port persists across restarts so firewall setup remains stable',async t=>{
  const root=await fs.mkdtemp(path.join(__dirname,'.service-test-'));
  const blocker=net.createServer();await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));
  let first,second;
  t.after(async()=>{await first?.stop();await second?.stop();await new Promise(resolve=>blocker.close(resolve));assert.ok(path.resolve(root).startsWith(path.resolve(__dirname)+path.sep));await fs.rm(root,{recursive:true,force:true});});
  first=new LocalSendService({dataDir:root,host:'127.0.0.1',discovery:false,settings:{port:blocker.address().port}});await first.start();
  const chosen=first.port;assert.notEqual(chosen,blocker.address().port);assert.equal(JSON.parse(await fs.readFile(path.join(root,'settings.json'),'utf8')).port,chosen);
  await first.stop();first=null;
  second=new LocalSendService({dataDir:root,host:'127.0.0.1',discovery:false});await second.start();assert.equal(second.port,chosen);assert.equal(second.info().port,chosen);
});

test('discovery refreshes memberships and sends through a newly connected phone hotspot', async t => {
  class FakeUdp extends EventEmitter {
    constructor() { super(); this.memberships=[]; this.dropped=[]; this.outbound=[]; this.sent=[]; }
    bind() { queueMicrotask(() => this.emit('listening')); }
    setMulticastTTL() {} setMulticastLoopback() {}
    addMembership(group,address) { this.memberships.push([group,address || null]); }
    dropMembership(group,address) { this.dropped.push([group,address || null]); }
    setMulticastInterface(address) { this.outbound.push(address); }
    send(bytes,port,address,done) { this.sent.push({bytes:Buffer.from(bytes),port,address}); done?.(); }
    close() {}
  }
  const root=await fs.mkdtemp(path.join(__dirname,'.service-test-'));
  const udp=new FakeUdp();
  let interfaces={wifi:[{family:'IPv4',internal:false,address:'192.168.1.20'}]};
  const service=new LocalSendService({dataDir:root,discoveryPort:53317,interfaceProvider:()=>interfaces,udpFactory:()=>udp});
  t.after(async()=>{await service.stop();await fs.rm(root,{recursive:true,force:true});});
  await service.startDiscovery();
  assert.deepEqual(udp.memberships,[['224.0.0.167','192.168.1.20']]);
  assert.deepEqual(udp.outbound,['192.168.1.20']);
  interfaces={hotspot:[{family:'IPv4',internal:false,address:'192.168.43.72'}]};
  service.discover();
  assert.deepEqual(udp.dropped,[['224.0.0.167','192.168.1.20']]);
  assert.deepEqual(udp.memberships,[['224.0.0.167','192.168.1.20'],['224.0.0.167','192.168.43.72']]);
  assert.equal(udp.outbound.at(-1),'192.168.43.72');
  assert.equal(udp.sent.at(-1).address,'224.0.0.167');
  assert.deepEqual(service.getState().network.discoveryInterfaces,['192.168.43.72']);
});

test('progress snapshots do not rescan adapters, while discovery refreshes the displayed address', async t => {
  const root=await fs.mkdtemp(path.join(__dirname,'.service-test-'));
  let reads=0,address='192.168.1.20';
  const service=new LocalSendService({dataDir:root,discovery:false,interfaceProvider:()=>{reads++;return {wifi:[{family:'IPv4',internal:false,address}]};}});
  t.after(async()=>{await service.stop();await fs.rm(root,{recursive:true,force:true});});
  const first=service.getState();const initial=reads;
  first.device.addresses.push('caller mutation');
  for(let i=0;i<100;i++)assert.deepEqual(service.getState().device.addresses,['192.168.1.20']);
  assert.equal(reads,initial);
  address='192.168.43.72';service.discover();
  assert.equal(reads,initial+1);assert.deepEqual(service.getState().device.addresses,['192.168.43.72']);
});

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(__dirname, '.service-test-'));
  const sender = new LocalSendService({ dataDir: path.join(root, 'sender'), downloadDir: path.join(root, 'sender-received'), alias: 'Test Sender', host: '127.0.0.1', port: 0, discovery: false });
  const receiver = new LocalSendService({ dataDir: path.join(root, 'receiver'), downloadDir: path.join(root, 'received'), alias: 'Test Receiver', host: '127.0.0.1', port: 0, discovery: false, autoAccept: options.autoAccept ?? true });
  t.after(async () => {
    await Promise.all([sender.stop(), receiver.stop()]);
    // Keep recursive deletion confined to this test's verified workspace child.
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(__dirname) + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await Promise.all([sender.start(), receiver.start()]);
  return { root, sender, receiver, peer: { ...receiver.info(), host: '127.0.0.1' } };
}

test('unverified discovery cannot start reverse polling or persist a phone address',async t=>{
  const {sender,receiver}=await fixture(t);
  const advertised={...receiver.info(),capabilities:{reversePull:1}};
  sender.rememberPeer(advertised,'127.0.0.1');
  assert.equal(sender.reverse.peers.size,0);
  assert.equal(sender.knownPeers.length,0);
  await assert.rejects(fs.access(path.join(sender.dataDir,'known-peers.json')),{code:'ENOENT'});
});

test('authenticated phone registration persists its identity and rejects an advertised certificate mismatch',async t=>{
  const {sender,receiver}=await fixture(t);
  const original=receiver.info.bind(receiver);
  receiver.info=()=>({...original(),capabilities:{reversePull:1}});
  const peer=await sender.addPeer({host:'127.0.0.1',port:receiver.port});
  assert.equal(peer.peers.length,1);
  assert.equal(sender.reverse.peers.size,1);
  const saved=JSON.parse(await fs.readFile(path.join(sender.dataDir,'known-peers.json'),'utf8'));
  assert.equal(saved[0].fingerprint,receiver.tls.fingerprint);
  assert.equal(saved[0].verified,true);
  const restored=new LocalSendService({dataDir:sender.dataDir,discovery:false});
  assert.equal(restored.knownPeers[0].fingerprint,receiver.tls.fingerprint);
  receiver.info=()=>({...original(),fingerprint:'0'.repeat(64),capabilities:{reversePull:1}});
  await assert.rejects(sender.addPeer({host:'127.0.0.1',port:receiver.port}),/certificate does not match/);
  assert.equal(sender.knownPeers.length,1);
});

function waitState(service, predicate, message = 'Expected service state') {
  if (predicate(service.getState())) return Promise.resolve(service.getState());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, 7000);
    const cleanup = () => { clearTimeout(timer); service.off('state', onState); };
    const onState = state => { if (predicate(state)) { cleanup(); resolve(state); } };
    service.on('state', onState);
  });
}

async function request(receiver, sender, route, { body, bytes, certificate = true, method = 'POST' } = {}) {
  const payload = body === undefined ? bytes : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: receiver.port, path: API + route, method,
      rejectUnauthorized: false, agent: false,
      ...(certificate ? { cert: sender.tls.cert, key: sender.tls.key } : {}),
      headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...(body === undefined ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }) }
    }, async res => {
      try {
        const chunks = []; for await (const chunk of res) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        resolve({ status: res.statusCode, data, headers: res.headers });
      } catch (error) { reject(error); }
    });
    req.setTimeout(7000, () => req.destroy(new Error('Test request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

function metadata(name, bytes, extra = {}) {
  return { id: 'file-1', fileName: name, size: bytes.length, fileType: 'application/octet-stream', ...extra };
}

async function prepare(receiver, sender, files) {
  const result = await request(receiver, sender, '/prepare-upload', { body: { info: sender.info(), files } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(typeof result.data.sessionId, 'string');
  return result.data;
}

async function upload(receiver, sender, prepared, id, bytes, token = prepared.files[id]) {
  const query = new URLSearchParams({ sessionId: prepared.sessionId, fileId: id, token });
  return request(receiver, sender, '/upload?' + query, { bytes });
}

test('generated TLS identity is self-signed, matches its private key, and persists', async t => {
  const { sender } = await fixture(t);
  const certificate = new crypto.X509Certificate(sender.tls.cert);
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.equal(certificate.checkPrivateKey(crypto.createPrivateKey(sender.tls.key)), true);
  assert.ok(Date.parse(certificate.validFrom) < Date.now());
  assert.ok(Date.parse(certificate.validTo) > Date.now());
  assert.match(sender.tls.fingerprint, /^[A-F0-9]{64}$/);
  assert.equal(sender.tls.fingerprint, crypto.createHash('sha256').update(certificate.raw).digest('hex').toUpperCase());
  assert.deepEqual(loadCertificate(sender.dataDir), sender.tls);
});

test('real HTTPS registration accepts the matching client certificate and rejects a false fingerprint', async t => {
  const { sender, receiver, peer } = await fixture(t);
  const registered = await sender.registerPeer(peer);
  assert.equal(registered.alias, 'Test Receiver');
  assert.equal(registered.fingerprint, receiver.tls.fingerprint);
  assert.equal(receiver.getState().peers[0].fingerprint, sender.tls.fingerprint);
  const forged = await request(receiver, sender, '/register', { body: { ...sender.info(), fingerprint: 'A'.repeat(64) } });
  assert.equal(forged.status, 403);
});

test('HTTPS identity routes reject clients that do not present a certificate', async t => {
  const { sender, receiver } = await fixture(t);
  const response = await request(receiver, sender, '/register', { certificate: false, body: sender.info() });
  assert.equal(response.status, 403, 'A claimed fingerprint without a TLS certificate must not register a peer');
  assert.equal(receiver.getState().peers.length, 0);
});

test('two services send a nested binary file byte-for-byte and record completion', async t => {
  const { root, sender, receiver, peer } = await fixture(t);
  const bytes = Buffer.concat([Buffer.from([0, 255, 128, 13, 10]), crypto.randomBytes(160 * 1024)]);
  const folder = path.join(root, 'source-folder'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'sample.bin'), bytes);
  await sender.addPaths([folder]);
  await sender.registerPeer(peer);
  await sender.send(peer.fingerprint);
  const sending = await waitState(sender, state => state.transfers[0]?.status === 'completed', 'Binary send did not complete');
  const receiving = await waitState(receiver, state => state.transfers[0]?.status === 'completed', 'Binary receive did not complete');
  assert.deepEqual(await fs.readFile(path.join(receiver.settings.downloadDir, 'source-folder', 'sample.bin')), bytes);
  assert.equal(sending.transfers[0].transferred, bytes.length);
  assert.equal(receiving.transfers[0].transferred, bytes.length);
  assert.equal(receiving.transfers[0].progress, 1);
  assert.equal(receiving.history[0].status, 'completed');
});

test('duplicate destination names preserve both existing and incoming content', async t => {
  const { sender, receiver } = await fixture(t);
  const first = Buffer.from('original'); const second = Buffer.from('incoming');
  await fs.mkdir(receiver.settings.downloadDir, { recursive: true });
  await fs.writeFile(path.join(receiver.settings.downloadDir, 'same.bin'), first);
  const prepared = await prepare(receiver, sender, { 'file-1': metadata('same.bin', second) });
  assert.equal((await upload(receiver, sender, prepared, 'file-1', second)).status, 200);
  assert.deepEqual(await fs.readFile(path.join(receiver.settings.downloadDir, 'same.bin')), first);
  assert.deepEqual(await fs.readFile(path.join(receiver.settings.downloadDir, 'same (1).bin')), second);
});

test('manual approval holds the request, rejects competing sessions, then permits upload', async t => {
  const { sender, receiver } = await fixture(t, { autoAccept: false });
  const bytes = Buffer.from('approved');
  const resultPromise = request(receiver, sender, '/prepare-upload', { body: { info: sender.info(), files: { 'file-1': metadata('approved.bin', bytes) } } });
  const pending = await waitState(receiver, state => state.requests.length === 1);
  assert.equal(receiver.getState().transfers.length, 0);
  const competing = await request(receiver, sender, '/prepare-upload', { body: { info: sender.info(), files: { 'file-1': metadata('other.bin', bytes) } } });
  assert.equal(competing.status, 409);
  receiver.respond({ requestId: pending.requests[0].id, accept: true });
  const prepared = await resultPromise;
  assert.equal(prepared.status, 200);
  assert.equal(receiver.getState().requests.length, 0);
  assert.equal((await upload(receiver, sender, prepared.data, 'file-1', bytes)).status, 200);
  assert.deepEqual(await fs.readFile(path.join(receiver.settings.downloadDir, 'approved.bin')), bytes);
});

test('manual rejection sends 403 and frees the pending request', async t => {
  const { sender, receiver } = await fixture(t, { autoAccept: false });
  const bytes = Buffer.from('declined');
  const resultPromise = request(receiver, sender, '/prepare-upload', { body: { info: sender.info(), files: { 'file-1': metadata('declined.bin', bytes) } } });
  const pending = await waitState(receiver, state => state.requests.length === 1);
  receiver.respond({ requestId: pending.requests[0].id, accept: false });
  assert.equal((await resultPromise).status, 403);
  assert.equal(receiver.getState().requests.length, 0);
  assert.equal(receiver.getState().transfers.length, 0);
  await assert.rejects(fs.access(path.join(receiver.settings.downloadDir, 'declined.bin')), { code: 'ENOENT' });
});

test('receive rejects traversal, absolute paths, and Windows reserved device names before approval', async t => {
  const { sender, receiver } = await fixture(t);
  for (const name of ['../outside.bin', '..\\outside.bin', '/absolute.bin', 'C:\\absolute.bin', 'sub/../../outside.bin', 'CON.txt', 'folder/NUL', 'folder//file.bin']) {
    const response = await request(receiver, sender, '/prepare-upload', { body: { info: sender.info(), files: { 'file-1': metadata(name, Buffer.alloc(0)) } } });
    assert.equal(response.status, 400, `Unsafe path was accepted: ${name}`);
  }
  assert.equal(receiver.getState().requests.length, 0);
  assert.equal(receiver.getState().transfers.length, 0);
});

test('checksum mismatch returns 422 and removes the incomplete destination', async t => {
  const { sender, receiver } = await fixture(t);
  const bytes = Buffer.from('contents with a deliberately incorrect hash');
  const prepared = await prepare(receiver, sender, { 'file-1': metadata('bad-hash.bin', bytes, { sha256: '0'.repeat(64) }) });
  assert.equal((await upload(receiver, sender, prepared, 'file-1', bytes)).status, 422);
  await assert.rejects(fs.access(path.join(receiver.settings.downloadDir, 'bad-hash.bin')), { code: 'ENOENT' });
  assert.equal(receiver.getState().transfers[0].status, 'failed');
});

test('buffered multi-file transfers preserve content and exact byte totals', async t => {
  const { sender, receiver, peer } = await fixture(t);
  const sources = [crypto.randomBytes(1024 * 1024 + 137), Buffer.alloc(0), crypto.randomBytes(256 * 1024 - 19)];
  const files = sources.map((_, i) => path.join(sender.dataDir, `buffered-${i}.bin`));
  await Promise.all(files.map((file, i) => fs.writeFile(file, sources[i])));
  const registered = await sender.registerPeer(peer);
  await sender.addPaths(files);
  await sender.send(registered.id);
  const sent = await waitState(sender, state => state.history.some(x => x.direction === 'send'));
  const received = await waitState(receiver, state => state.history.some(x => x.direction === 'receive'));
  const total = sources.reduce((sum, bytes) => sum + bytes.length, 0);
  for (const transfer of [sent.history[0], received.history[0]]) {
    assert.equal(transfer.status, 'completed');
    assert.equal(transfer.transferred, total);
    assert.equal(transfer.progress, 1);
    assert.deepEqual(transfer.files.map(file => file.transferred), sources.map(bytes => bytes.length));
  }
  for (let i = 0; i < sources.length; i++) {
    assert.deepEqual(await fs.readFile(path.join(receiver.settings.downloadDir, path.basename(files[i]))), sources[i]);
  }
});

test('an unauthorized file token writes no bytes and leaves the valid token usable', async t => {
  const { sender, receiver } = await fixture(t);
  const bytes = Buffer.from('correct-token-only');
  const prepared = await prepare(receiver, sender, { 'file-1': metadata('token.bin', bytes) });
  assert.equal((await upload(receiver, sender, prepared, 'file-1', bytes, 'not-the-token')).status, 403);
  await assert.rejects(fs.access(path.join(receiver.settings.downloadDir, 'token.bin')), { code: 'ENOENT' });
  assert.equal((await upload(receiver, sender, prepared, 'file-1', bytes)).status, 200);
  assert.deepEqual(await fs.readFile(path.join(receiver.settings.downloadDir, 'token.bin')), bytes);
});

test('a zero-byte file completes with an empty destination and full progress', async t => {
  const { sender, receiver } = await fixture(t);
  const bytes = Buffer.alloc(0);
  const prepared = await prepare(receiver, sender, { 'file-1': metadata('empty.bin', bytes, { sha256: crypto.createHash('sha256').update(bytes).digest('hex') }) });
  assert.equal((await upload(receiver, sender, prepared, 'file-1', bytes)).status, 200);
  assert.equal((await fs.stat(path.join(receiver.settings.downloadDir, 'empty.bin'))).size, 0);
  assert.equal(receiver.getState().transfers[0].status, 'completed');
  assert.equal(receiver.getState().transfers[0].progress, 1);
});

test('cancelled receive session rejects a later upload and releases the receiver', async t => {
  const { sender, receiver } = await fixture(t);
  const bytes = Buffer.from('cancel me');
  const prepared = await prepare(receiver, sender, { 'file-1': metadata('cancelled.bin', bytes) });
  const cancelled = await request(receiver, sender, '/cancel?' + new URLSearchParams({ sessionId: prepared.sessionId }));
  assert.equal(cancelled.status, 200);
  assert.equal(receiver.getState().transfers[0].status, 'cancelled');
  assert.ok((await upload(receiver, sender, prepared, 'file-1', bytes)).status >= 400);
  await assert.rejects(fs.access(path.join(receiver.settings.downloadDir, 'cancelled.bin')), { code: 'ENOENT' });
  const next = await prepare(receiver, sender, { 'file-1': metadata('next.bin', bytes) });
  assert.equal((await upload(receiver, sender, next, 'file-1', bytes)).status, 200);
});
