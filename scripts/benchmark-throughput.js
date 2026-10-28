'use strict';

// Reproducible transport benchmark, not a phone/Wi-Fi speed prediction.
// Runs the shipping Node service and the shipping Java engine on loopback,
// including mutual TLS, approval, file writes, and final saved acknowledgment.
// Usage: node scripts/benchmark-throughput.js --label current --mib 512 --runs 3
// Baseline: --pc-src test-output/throughput-baseline-1.4-source/pc-src
//           --engine test-output/throughput-baseline-1.4-source/TransferEngine.java
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const {createInterface} = require('node:readline');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {performance} = require('node:perf_hooks');

const project = path.resolve(__dirname, '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || process.argv[i + 1] === undefined) throw new Error('Expected --option value');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const mib = Number(options.mib || 512), runs = Number(options.runs || 3), warmups = Number(options.warmups || 1);
const fileCount = Number(options.files || 1);
assert.ok(Number.isInteger(fileCount) && fileCount >= 1 && fileCount <= 1000, '--files must be 1..1000');
assert.ok(Number.isInteger(mib) && mib >= 1 && mib <= 8192, '--mib must be 1..8192');
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 20, '--runs must be 1..20');
assert.ok(Number.isInteger(warmups) && warmups >= 0 && warmups <= 5, '--warmups must be 0..5');
const label = String(options.label || 'current').replace(/[^a-z0-9._-]/gi, '-');
const output = path.resolve(project, options.output || path.join('test-output', 'throughput-' + label + '-' + new Date().toISOString().replace(/[:.]/g, '-')));
const pcSource = path.resolve(project, options['pc-src'] || 'src');
const engineSource = path.resolve(project, options.engine || 'android/app/src/main/java/org/localsend/rebuilt/TransferEngine.java');
const harnessSource = path.resolve(project, options.harness || 'android/test/EngineHarness.java');
const javaHome = process.env.JAVA_HOME || 'C:\\Program Files\\Microsoft\\jdk-17.0.20.101-hotspot';
const javaExe = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const javacExe = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
const jsonLibrary = path.join(project, 'android/tools/json-20250517.jar');
const fileBytes = mib * 1024 * 1024, bytes = fileBytes * fileCount;
const report = {
  label, startedAt: new Date().toISOString(), scope: 'Windows loopback Node-to-JVM transport benchmark; no physical Android phone or Wi-Fi was measured',
  measurement: 'Approval to successful completion at both peers; includes TLS setup, file write close, and final saved acknowledgment. Source generation and post-transfer SHA-256 verification are excluded. No fsync/durable-media claim.',
  fixture: {bytes, fileBytes, fileCount, mibPerFile: mib, generation: 'AES-256-CTR of zero blocks using a fixed public test seed; no compression'},
  environment: {platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, node: process.version},
  warmupsPerDirection: warmups, measuredRunsPerDirection: runs, sources: {}, results: [], summaries: {}
};
let LocalSendService, loadCertificate, classpath;

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, {highWaterMark: 1024 * 1024})) hash.update(chunk);
  return hash.digest('hex');
}

async function snapshot() {
  await fsp.mkdir(output, {recursive: false});
  const snapshotDir = path.join(output, 'source');
  await fsp.mkdir(path.join(snapshotDir, 'pc-src'), {recursive: true});
  for (const name of ['service.js', 'reverse-receiver.js', 'certificate.js', ...(fs.existsSync(path.join(pcSource, 'transfer-pool.js')) ? ['transfer-pool.js'] : [])]) {
    const destination = path.join(snapshotDir, 'pc-src', name);
    await fsp.copyFile(path.join(pcSource, name), destination);
    report.sources[name] = {source: path.join(pcSource, name), sha256: await digest(destination)};
  }
  for (const [name, source] of [['TransferEngine.java', engineSource], ['EngineHarness.java', harnessSource]]) {
    const destination = path.join(snapshotDir, name);
    await fsp.copyFile(source, destination);
    report.sources[name] = {source, sha256: await digest(destination)};
  }
  const classes = path.join(output, 'classes');
  await fsp.mkdir(classes);
  const compilation = spawnSync(javacExe, ['--release', '8', '-encoding', 'UTF-8', '-classpath', jsonLibrary, '-d', classes, path.join(snapshotDir, 'TransferEngine.java'), path.join(snapshotDir, 'EngineHarness.java')], {windowsHide: true, encoding: 'utf8'});
  await fsp.writeFile(path.join(output, 'compile.log'), (compilation.stdout || '') + (compilation.stderr || ''), 'utf8');
  if (compilation.error || compilation.status !== 0) throw compilation.error || new Error('Java compilation failed: ' + compilation.stderr);
  report.environment.java = spawnSync(javaExe, ['-version'], {windowsHide: true, encoding: 'utf8'}).stderr.trim();
  ({LocalSendService} = require(path.join(snapshotDir, 'pc-src/service')));
  ({loadCertificate} = require(path.join(snapshotDir, 'pc-src/certificate')));
  classpath = [classes, jsonLibrary].join(path.delimiter);
}

async function generateFixture() {
  const input = path.join(output, 'fixture.bin');
  const zeros = Buffer.alloc(1024 * 1024);
  const key = crypto.createHash('sha256').update('Super Send reproducible throughput fixture v1').digest();
  const cipher = crypto.createCipheriv('aes-256-ctr', key, Buffer.alloc(16));
  await pipeline(Readable.from((function* () { for (let i = 0; i < mib; i++) yield zeros; })()), cipher, fs.createWriteStream(input));
  report.fixture.sha256 = await digest(input);
  return input;
}

async function fixture(mode) {
  const root = path.join(output, mode);
  const mobileDir = path.join(root, 'mobile');
  const mobileReceived = path.join(root, 'mobile-received');
  loadCertificate(mobileDir);
  const pc = new LocalSendService({dataDir: path.join(root, 'pc'), downloadDir: path.join(root, 'pc-received'), alias: 'Benchmark PC', port: 0, host: '127.0.0.1', discovery: false, reverseReceive: mode === 'java-to-pc-reverse'});
  await pc.start();
  const child = spawn(javaExe, ['-cp', classpath, 'org.localsend.rebuilt.EngineHarness', path.join(mobileDir, 'certificate.pem'), path.join(mobileDir, 'private-key.pem'), mobileReceived], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  let state, errors = '', exited = false, commandId = 0, incomingRequests = 0;
  const events = new Set(), commands = new Map();
  const notify = () => { for (const event of events) event(); };
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('error', error => { errors += error.stack; exited = true; notify(); });
  child.on('exit', () => { exited = true; notify(); });
  createInterface({input: child.stdout}).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { errors += line + '\n'; return; }
    if (event.state) state = event.state;
    const pending = commands.get(event.id);
    if (pending && event.type === 'result') { commands.delete(event.id); pending.resolve(state); }
    else if (event.type === 'error') { if (pending) { commands.delete(event.id); pending.reject(new Error(event.message)); } else errors += event.message + '\n'; }
    notify();
  });
  const send = command => new Promise((resolve, reject) => {
    const id = String(++commandId);
    const timer = setTimeout(() => { commands.delete(id); reject(new Error('Java command timed out: ' + command.action + '\n' + errors)); }, 30000);
    commands.set(id, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
    child.stdin.write(JSON.stringify({...command, id}) + '\n');
  });
  const until = (predicate, description, timeout = 120000) => new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); events.delete(check); pc.off('state', check); };
    const check = () => {
      try {
        const result = predicate(state, pc.getState());
        if (result) { cleanup(); resolve(result); }
        else if (exited) { cleanup(); reject(new Error('Java exited: ' + errors)); }
      } catch (error) { cleanup(); reject(error); }
    };
    timer = setTimeout(() => { cleanup(); reject(new Error(description + '\n' + errors + '\n' + JSON.stringify({mobile: state, pc: pc.getState()}))); }, timeout);
    events.add(check); pc.on('state', check); check();
  });
  const close = async () => {
    await fsp.writeFile(path.join(root, 'final-states.json'), JSON.stringify({mobile:state,pc:pc.getState()},null,2));
    try { child.stdin.end(JSON.stringify({action: 'stop'}) + '\n'); } catch {}
    await pc.stop();
    await new Promise(resolve => {
      if (exited) return resolve();
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await fsp.writeFile(path.join(root, 'java-errors.log'), errors, 'utf8');
  };
  try {
    await until(m => m?.network.ready, 'Java server did not start');
    const mobilePeer = {...state.device, host: '127.0.0.1'};
    if (mode === 'java-to-pc-reverse') pc.handle = async (req, res) => { incomingRequests++; res.destroy(); };
    await pc.addPeer({host: '127.0.0.1', port: mobilePeer.port, protocol: 'https'});
    await until(m => m.peers.some(peer => peer.id === pc.info().fingerprint), 'Java did not learn PC');
    if (mode === 'java-to-pc-reverse') await until((m, p) => p.network.reverseReady, 'PC reverse polling did not connect');
    return {pc, send, until, close, mobileId: mobilePeer.fingerprint, mobileReceived, root, errors: () => errors, incoming: () => incomingRequests};
  } catch (error) { await close(); throw error; }
}

function completed(state, direction, name) {
  const history = state?.history || [];
  const transfer = history.find(item => item.direction === direction && item.files?.some(file => file.name === name));
  if (transfer && transfer.status !== 'completed') throw new Error('Transfer failed: ' + JSON.stringify(transfer));
  return transfer;
}

async function runDirection(mode, input) {
  const f = await fixture(mode);
  try {
    for (let i = 0; i < warmups + runs; i++) {
      const warmup = i < warmups, index = warmup ? i + 1 : i - warmups + 1;
      const name = mode + '-' + (warmup ? 'warmup-' : 'run-') + index + '.bin';
      const names = Array.from({length:fileCount}, (_, n) => n ? name.replace('.bin', '-' + n + '.bin') : name);
      let started, finished, senderResult, receiverResult, destination;
      if (mode === 'pc-to-java') {
        const inputLinks = names.map(name => path.join(output, name));
        for (const link of inputLinks) await fsp.link(input, link);
        try {
          f.pc.clearSelection(); await f.pc.addPaths(inputLinks); await f.pc.send(f.mobileId);
          const request = await f.until(m => m?.requests.find(item => item.files?.some(file => file.fileName === name)), 'Android approval missing');
          started = performance.now();
          await f.send({action: 'respond', requestId: request.id, accept: true});
          await f.until((m, p) => {
            senderResult = completed(p, 'send', name); receiverResult = completed(m, 'receive', name);
            return senderResult && receiverResult;
          }, 'PC-to-Java transfer did not complete');
          finished = performance.now();
          destination = path.join(f.mobileReceived, name);
        } finally { for (const link of inputLinks) await fsp.unlink(link); }
      } else {
        await f.send({action: 'clear'});
        for (const name of names) await f.send({action: 'file', path: input, name});
        await f.send({action: 'send', peerId: f.pc.info().fingerprint});
        const request = await f.until((m, p) => p.requests.find(item => item.files?.some(file => file.fileName === name)), 'PC approval missing');
        started = performance.now();
        f.pc.respond({requestId: request.id, accept: true});
        await f.until((m, p) => {
          senderResult = completed(m, 'send', name); receiverResult = completed(p, 'receive', name);
          return senderResult && receiverResult;
        }, 'Java-to-PC transfer did not complete');
        finished = performance.now();
        destination = path.join(f.root, 'pc-received', name);
      }
      const elapsedMs = finished - started;
      assert.equal(senderResult.transferred, bytes, 'Sender byte count');
      assert.equal(receiverResult.transferred, bytes, 'Receiver byte count');
      assert.equal(senderResult.files.length, fileCount, 'Sender file count');
      assert.equal(receiverResult.files.length, fileCount, 'Receiver file count');
      for (const name of names) {
        const saved = path.join(path.dirname(destination), name);
        assert.equal((await fsp.stat(saved)).size, fileBytes, 'Destination file length');
        assert.equal(await digest(saved), report.fixture.sha256, 'Destination SHA-256');
        await fsp.unlink(saved);
      }
      if (mode === 'java-to-pc-reverse') assert.equal(f.incoming(), 0, 'Reverse path opened incoming PC request');
      const result = {mode, warmup, run: index, bytes, fileCount, elapsedMs, megabytesPerSecond: bytes / 1e6 / (elapsedMs / 1000), mebibytesPerSecond: bytes / 1048576 / (elapsedMs / 1000), checksumVerified: true};
      report.results.push(result);
      console.log(JSON.stringify(result));
      await save();
    }
    assert.equal(f.errors(), '', 'Unexpected Java errors');
  } finally { await f.close(); }
}

async function save() {
  for (const mode of ['pc-to-java', 'java-to-pc-direct', 'java-to-pc-reverse']) {
    const results = report.results.filter(result => result.mode === mode && !result.warmup);
    if (!results.length) continue;
    const values = results.map(result => result.megabytesPerSecond).sort((a, b) => a - b);
    report.summaries[mode] = {runs: values.length, medianMBps: values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2, minMBps: values[0], maxMBps: values[values.length - 1], aggregateMBps: results.reduce((sum, result) => sum + result.bytes, 0) / 1e6 / (results.reduce((sum, result) => sum + result.elapsedMs, 0) / 1000)};
  }
  await fsp.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
}

(async () => {
  await snapshot();
  console.log(JSON.stringify({output, label, bytes, runs, warmups, scope: report.scope}));
  const input = await generateFixture();
  await save();
  for (const mode of ['pc-to-java', 'java-to-pc-direct', 'java-to-pc-reverse']) await runDirection(mode, input);
  report.finishedAt = new Date().toISOString();
  report.success = true;
  await fsp.unlink(input);
  await save();
  console.log(JSON.stringify({output, summaries: report.summaries}));
})().catch(async error => {
  report.success = false; report.error = error.stack;
  if (fs.existsSync(output)) await save().catch(() => {});
  console.error(error.stack);
  process.exitCode = 1;
});
