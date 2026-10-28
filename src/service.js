'use strict';



const { EventEmitter } = require('node:events');

const fs = require('node:fs');

const fsp = require('node:fs/promises');

const path = require('node:path');

const os = require('node:os');

const http = require('node:http');

const https = require('node:https');

const dgram = require('node:dgram');

const crypto = require('node:crypto');

const { Transform, Readable } = require('node:stream');

const { pipeline } = require('node:stream/promises');

const { loadCertificate } = require('./certificate');

const { ReverseReceiver } = require('./reverse-receiver');
const { MAX_PARALLEL_FILES, parallelFiles, runTransfers } = require('./transfer-pool');



const API = '/api/localsend/v2';

// Coalesce disk I/O while retaining stream backpressure and bounded memory.
const FILE_BUFFER_SIZE = 256 * 1024;

const MULTICAST = '224.0.0.167';

const uuid = () => crypto.randomUUID();

const ip = value => String(value || '').replace(/^::ffff:/, '');

const fileMime = name => ({ '.txt':'text/plain', '.md':'text/markdown', '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.mp4':'video/mp4', '.mp3':'audio/mpeg', '.zip':'application/zip', '.json':'application/json' }[path.extname(name).toLowerCase()] || 'application/octet-stream');

const fail = (status, message) => Object.assign(new Error(message), { status });

function respond(res, status, data) { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end(data === undefined ? '' : JSON.stringify(data)); }

async function json(req) {

  const chunks = []; let length = 0;

  for await (const chunk of req) { length += chunk.length; if (length > 2 * 1024 * 1024) throw fail(413, 'Request too large'); chunks.push(chunk); }

  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON'); }

}



function safeRelative(fileName) {

  if (typeof fileName !== 'string' || !fileName || fileName.length > 1000 || /^[\\/]|^[a-z]:/i.test(fileName)) throw fail(400, 'Invalid file name');

  const parts = fileName.replaceAll('\\', '/').split('/');

  if (parts.some(p => !p || p === '.' || p === '..')) throw fail(400, 'Unsafe file path');

  return parts.map(p => {

    const cleaned = p.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');

    if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) throw fail(400, 'Reserved file name');

    return cleaned;

  }).join(path.sep);

}



class LocalSendService extends EventEmitter {

  constructor(options = {}) {

    super();

    this.options = options;

    this.dataDir = options.dataDir || path.join(__dirname, '..', '.local');

    fs.mkdirSync(this.dataDir, { recursive:true });

    let saved = {}; try { saved = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'settings.json'), 'utf8')); } catch {}

    const alias=['Kind','Calm','Bright','Gentle','Happy','Quiet'][crypto.randomInt(6)]+' '+['Maple','Willow','River','Cedar','Falcon','Meadow'][crypto.randomInt(6)];

    this.settings = { alias, downloadDir:path.join(this.dataDir, '..', 'received'), autoAccept:false, theme:'dark', port:53317, multicast:MULTICAST, showAdvanced:false, ...saved, ...options.settings };

    if (options.port !== undefined) this.settings.port = options.port;

    if (options.alias) this.settings.alias = options.alias;

    if (options.downloadDir) this.settings.downloadDir = options.downloadDir;

    if (options.autoAccept !== undefined) this.settings.autoAccept = options.autoAccept;

    this.tls = loadCertificate(this.dataDir);

    this.protocol = options.protocol || 'https';

    this.peers = new Map(); this.sessions = new Map(); this.pending = new Map();

    this.selection = []; this.transfers = []; this.history = [];

    try { this.history = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'history.json'), 'utf8')).slice(0, 30); } catch {}

    this.network = { ready:false, discovery:false };

    // Discovery must follow the active network, not only the adapters that
    // existed when Super Send was opened. This matters when Windows moves from
    // home Wi-Fi to an Android hotspot without restarting the app.
    this.interfaceProvider = options.interfaceProvider || (() => os.networkInterfaces());
    this.udpFactory = options.udpFactory || (socketOptions => dgram.createSocket(socketOptions));
    this.discoveryMemberships = new Set();
    this.discoveryFallbackMembership = false;

    this.knownPeers=[];

    try{this.knownPeers=JSON.parse(fs.readFileSync(path.join(this.dataDir,'known-peers.json'),'utf8')).filter(peer=>this.validPeer(peer)&&typeof peer.host==='string'&&peer.host.length<254).slice(0,16);}catch{}

    this.reverse=options.reverseReceive===false?null:new ReverseReceiver(this,{validatePath:safeRelative});

    this.saveSettings();

  }



  info() { return { alias:this.settings.alias, version:'2.2', deviceModel:process.platform === 'win32' ? 'Windows' : os.type(), deviceType:'desktop', fingerprint:this.tls.fingerprint, port:this.port || this.settings.port, protocol:this.protocol, download:false, capabilities:{parallelFiles:MAX_PARALLEL_FILES,...(this.reverse?{reverseReceive:1}:{})} }; }

  addresses(refresh = false) {
    if (!refresh && this.cachedAddresses) return [...this.cachedAddresses];
    let interfaces;
    try { interfaces = this.interfaceProvider(); } catch { return [...(this.cachedAddresses || [])]; }
    this.cachedAddresses = [...new Set(Object.values(interfaces || {}).flat().filter(n => n && n.family === 'IPv4' && !n.internal && n.address).map(n => n.address))];
    return [...this.cachedAddresses];
  }

  getState() {

    const publicTransfer = t => ({ ...t, controller:undefined, peerInfo:undefined });

    return JSON.parse(JSON.stringify({ device:{...this.info(), addresses:this.addresses()}, settings:{...this.settings}, peers:[...this.peers.values()].sort((a,b) => a.alias.localeCompare(b.alias)), selection:this.selection.map(({source,...f})=>f), transfers:this.transfers.map(publicTransfer), requests:[...this.pending.values()].map(p=>p.public), history:this.history, network:this.network, version:'1.6.0' }));

  }

  changed(immediate = false) {

    if (immediate) { clearTimeout(this.changeTimer); this.changeTimer = null; this.emit('state', this.getState()); return; }

    if (!this.changeTimer) this.changeTimer = setTimeout(()=>{ this.changeTimer = null; this.emit('state', this.getState()); }, 70);

  }

  saveSettings() { fs.writeFileSync(path.join(this.dataDir, 'settings.json'), JSON.stringify(this.settings, null, 2)); }

  async start() {

    if (this.server) return this.getState();

    this.server = (this.protocol === 'https' ? https.createServer({ key:this.tls.key, cert:this.tls.cert, requestCert:true, rejectUnauthorized:false }) : http.createServer());

    this.server.on('request', (req,res)=>this.handle(req,res).catch(error=>{ if (!res.headersSent) respond(res,error.status || 500,{message:error.message}); else res.destroy(); }));

    this.server.requestTimeout = 0;

    const listen = port => new Promise((resolve,reject)=> { const onError = e=>{ this.server.off('listening',onListen); reject(e); }; const onListen = ()=>{ this.server.off('error',onError); resolve(); }; this.server.once('error',onError); this.server.once('listening',onListen); this.server.listen(port, this.options.host || '0.0.0.0'); });

    let fallback=false;

    try { await listen(this.settings.port); } catch(error) {

      if (error.code !== 'EADDRINUSE' || this.options.port !== undefined) throw error;

      fallback=true;let bound=false;

      for(let candidate=53318;candidate<=53327;candidate++){if(candidate===this.settings.port)continue;try{await listen(candidate);bound=true;break;}catch(next){if(next.code!=='EADDRINUSE')throw next;}}

      if(!bound)await listen(0);

      this.network.notice = 'The previous receiving port was in use. A free port was selected and saved.';

    }

    this.port = this.server.address().port;

    if(fallback){this.settings.port=this.port;this.saveSettings();}

    this.network.ready = true;

    if (this.options.discovery !== false) await this.startDiscovery();

    this.reverse?.start();

    this.changed(true); return this.getState();

  }

  async stop() {

    await this.reverse?.stop();

    clearTimeout(this.changeTimer); clearInterval(this.announceTimer); clearInterval(this.pruneTimer);

    for (const p of this.pending.values()) p.finish(false);

    for (const t of this.transfers) t.controller?.abort();

    if (this.udp) { try { this.udp.close(); } catch {} this.udp = null; }
    this.discoveryMemberships.clear(); this.discoveryFallbackMembership = false;

    if (this.server) { this.server.closeAllConnections(); await new Promise(r=>this.server.close(r)); this.server = null; }

    this.network.ready = false;

  }

  async startDiscovery() {

    const udp = this.udp = this.udpFactory({type:'udp4',reuseAddr:true});

    udp.on('error', error=> { this.network.discovery = false; this.network.error = `Discovery: ${error.message}. Add a device by IP address.`; this.changed(); });

    udp.on('message', (buffer,remote)=> { if (buffer.length > 65507) return; let data; try { data = JSON.parse(buffer.toString()); } catch { return; } if (!this.validPeer(data) || data.fingerprint === this.tls.fingerprint) return; this.rememberPeer(data,remote.address); if (data.announce === true) this.registerPeer({...data,host:remote.address}).catch(()=>{}); });

    await new Promise(resolve=> { udp.once('listening',()=>{ try { udp.setMulticastTTL(1); udp.setMulticastLoopback(true); this.refreshDiscoveryInterfaces(); this.network.discovery = true; } catch(error) { this.network.error = error.message; } resolve(); }); udp.once('error',resolve); udp.bind(this.options.discoveryPort || 53317); });

    this.discover(); this.announceTimer = setInterval(()=>this.discover(),10000);

    this.pruneTimer = setInterval(()=>{ for (const [id,p] of this.peers) if (Date.now()-p.lastSeen>150000) this.peers.delete(id); for (const [id,s] of this.sessions) if (Date.now()-s.createdAt>1800000 && s.transfer.status !== 'transferring') this.sessions.delete(id); this.changed(); },30000);

  }

  refreshDiscoveryInterfaces() {
    if (!this.udp) return [];
    const addresses = this.addresses(true);
    const active = new Set(addresses);
    for (const address of [...this.discoveryMemberships]) {
      if (active.has(address)) continue;
      try { this.udp.dropMembership?.(this.settings.multicast,address); } catch {}
      this.discoveryMemberships.delete(address);
    }
    for (const address of addresses) {
      if (this.discoveryMemberships.has(address)) continue;
      try { this.udp.addMembership(this.settings.multicast,address); this.discoveryMemberships.add(address); } catch {}
    }
    if (addresses.length && this.discoveryFallbackMembership) {
      try { this.udp.dropMembership?.(this.settings.multicast); } catch {}
      this.discoveryFallbackMembership = false;
    } else if (!addresses.length && !this.discoveryFallbackMembership) {
      try { this.udp.addMembership(this.settings.multicast); this.discoveryFallbackMembership = true; } catch {}
    }
    this.network.discoveryInterfaces = addresses;
    return addresses;
  }

  discover() {

    if (this.udp && this.network.discovery) {
      const bytes = Buffer.from(JSON.stringify({...this.info(),announce:true}));
      const addresses = this.refreshDiscoveryInterfaces();
      let sent = false;
      for (const address of addresses) {
        try { this.udp.setMulticastInterface(address); this.udp.send(bytes,this.options.discoveryPort || 53317,this.settings.multicast,()=>{}); sent = true; } catch {}
      }
      if (!sent) { try { this.udp.send(bytes,this.options.discoveryPort || 53317,this.settings.multicast,()=>{}); } catch {} }
    } else this.addresses(true);

    this.changed(); return this.getState();

  }

  validPeer(data) { return data && typeof data.alias === 'string' && data.alias.length <= 120 && typeof data.fingerprint === 'string' && data.fingerprint.length <= 256 && ['http','https'].includes(data.protocol) && Number.isInteger(data.port) && data.port > 0 && data.port <= 65535; }

  rememberPeer(data,host,verified=false) {

    if(data.fingerprint===this.tls.fingerprint)return;

    const id=data.fingerprint||`${host}:${data.port}`;

    const peer={id,alias:data.alias,deviceModel:data.deviceModel||'Device',deviceType:data.deviceType||'desktop',host:ip(host),port:data.port,protocol:data.protocol,fingerprint:data.fingerprint,capabilities:{reversePull:data.capabilities?.reversePull===1?1:0},verified,lastSeen:Date.now()};

    this.peers.set(id,peer);

    if(verified&&peer.protocol==='https'&&peer.capabilities.reversePull===1){

      this.reverse?.observe(peer);

      this.knownPeers=[peer,...this.knownPeers.filter(p=>p.id!==id)].slice(0,16);

      fs.writeFileSync(path.join(this.dataDir,'known-peers.json'),JSON.stringify(this.knownPeers,null,2));

    }

    this.changed();return peer;

  }

  checkIdentity(req, data) { if (!this.validPeer(data)) throw fail(400,'Invalid device information'); if (req.socket.encrypted) { const cert = req.socket.getPeerCertificate(); if (!cert.raw) throw fail(403,'A device certificate is required'); if (crypto.createHash('sha256').update(cert.raw).digest('hex').toUpperCase() !== data.fingerprint.toUpperCase()) throw fail(403,'Certificate fingerprint does not match device identity'); } }

  request(peer, route, { method = 'POST', body, stream, size, onChunk, signal, timeout = 120000 } = {}) {

    return new Promise((resolve,reject)=>{

      const headers = {}; if (body !== undefined) { body = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; } else if (stream) { headers['Content-Type'] = 'application/octet-stream'; headers['Content-Length'] = size; }

      let actualFingerprint;

      // Use a fresh TLS handshake: a resumed Java TLS session can omit the peer

      // certificate, which cannot establish the identity we pin below.

      const req = (peer.protocol === 'https' ? https : http).request({ hostname:peer.host, port:peer.port, method, path:API+route, headers, rejectUnauthorized:false, agent:false, cert:this.tls.cert, key:this.tls.key, signal }, async res=>{ try { const chunks=[]; let n=0; for await (const c of res) { n+=c.length; if(n>2*1024*1024) throw new Error('Response too large'); chunks.push(c); } const raw=Buffer.concat(chunks).toString(); let data; try { data=raw?JSON.parse(raw):null; } catch { data=null; } if(res.statusCode<200||res.statusCode>=300) throw fail(res.statusCode,data?.message || ({401:'Receiver requires a PIN. PIN-protected receivers are not supported yet.',403:'The receiver declined the transfer.',409:'The receiver is busy.',429:'Too many attempts. Try again later.'}[res.statusCode] || `Device returned HTTP ${res.statusCode}`)); resolve({status:res.statusCode,data,fingerprint:actualFingerprint}); } catch(error){reject(error);} });

      req.setTimeout(timeout,()=>req.destroy(new Error('The device did not respond in time.')));

      req.on('socket',socket=> { if(peer.protocol==='https'){const verify=()=>{const actual=socket.getPeerCertificate().fingerprint256?.replaceAll(':','');actualFingerprint=actual;if(peer.fingerprint&&(!actual||actual.toUpperCase()!==peer.fingerprint.replaceAll(':','').toUpperCase()))req.destroy(new Error('Device certificate changed. Discover the device again.'));};if(socket.getPeerCertificate()?.raw)verify();else socket.once('secureConnect',verify);} });

      req.on('error',reject);

      if(stream) { const counter=new Transform({highWaterMark:FILE_BUFFER_SIZE,transform(chunk,enc,cb){onChunk?.(chunk.length);cb(null,chunk);}}); pipeline(stream,counter,req).catch(error=>{req.destroy(error);reject(error);}); }

      else req.end(body);

    });

  }

  async registerPeer(peer) {

    const result=await this.request(peer,'/register',{body:this.info(),timeout:4000});

    if(!this.validPeer(result.data))throw new Error('Device returned invalid information.');

    if(peer.protocol==='https'&&result.fingerprint?.toUpperCase()!==result.data.fingerprint.replaceAll(':','').toUpperCase())throw new Error('Device certificate does not match its identity.');

    const remembered=this.rememberPeer({...peer,...result.data,port:peer.port,protocol:peer.protocol},peer.host,peer.protocol==='https');

    return remembered;

  }

  async addPeer({host,port=53317,protocol='https'}) { host=String(host||'').trim(); if(!host || /[\s/?#@]/.test(host) || host.length>253 || !Number.isInteger(Number(port)) || Number(port)<1 || Number(port)>65535 || !['http','https'].includes(protocol)) throw new Error('Enter a valid IP address or hostname and port.'); const result = await this.registerPeer({host,port:Number(port),protocol}); if(!result) throw new Error('This is this device. Enter another device’s address.'); return this.getState(); }



  async handle(req,res) {

    const url = new URL(req.url,'https://localsend.local'); const route = url.pathname; const remote = ip(req.socket.remoteAddress);

    if (req.method==='GET' && route===API+'/info') return respond(res,200,this.info());

    if (req.method==='POST' && route===API+'/register') { const data=await json(req); this.checkIdentity(req,data); this.rememberPeer(data,remote,!!req.socket.encrypted); return respond(res,200,this.info()); }

    if (req.method==='POST' && route===API+'/prepare-upload') {

      const data=await json(req); this.checkIdentity(req,data.info);

      if(this.pending.size || [...this.sessions.values()].some(s=>['waiting','transferring'].includes(s.transfer.status))) throw fail(409,'Another transfer is in progress');

      if(!data.files || typeof data.files!=='object' || Array.isArray(data.files)) throw fail(400,'Invalid files');

      const entries=Object.entries(data.files); if(!entries.length || entries.length>1000) throw fail(400,'Select between 1 and 1000 files');

      for(const [id,f] of entries) { if(!f || id.length>200 || !Number.isSafeInteger(f.size) || f.size<0 || typeof f.fileType!=='string') throw fail(400,'Invalid file metadata'); safeRelative(f.fileName); if(f.sha256 && !/^[a-f\d]{64}$/i.test(f.sha256)) throw fail(400,'Invalid checksum'); }

      this.rememberPeer(data.info,remote,!!req.socket.encrypted);

      const requestId=uuid(); const publicRequest={id:requestId,alias:data.info.alias,host:remote,files:entries.map(([id,f])=>({...f,id}))};

      const accept=await new Promise(resolve=> {

        let done=false; let timer;

        const finish=value=>{if(done)return;done=true;clearTimeout(timer);this.pending.delete(requestId);this.changed(true);resolve(value);};

        this.pending.set(requestId,{public:publicRequest,finish}); timer=setTimeout(()=>finish(false),120000); res.once('close',()=>finish(false));

        this.changed(true); if(this.settings.autoAccept) finish(true);

      });

      if(!accept) return respond(res,403,{message:'Transfer declined'});

      const sessionId=uuid(); const tokens=Object.fromEntries(entries.map(([id])=>[id,uuid()]));

      const transfer={id:sessionId,direction:'receive',peer:data.info.alias,files:entries.map(([id,f])=>({id,name:f.fileName,size:f.size,transferred:0,status:'waiting'})),status:'waiting',progress:0,total:entries.reduce((n,[,f])=>n+f.size,0),transferred:0,createdAt:Date.now(),controller:new AbortController()};

      this.transfers.unshift(transfer); this.sessions.set(sessionId,{remote,metadata:data.files,tokens,transfer,createdAt:Date.now()}); this.changed(true); return respond(res,200,{sessionId,files:tokens,capabilities:{parallelFiles:MAX_PARALLEL_FILES}});

    }

    if(req.method==='POST' && route===API+'/upload') {

      const session=this.sessions.get(url.searchParams.get('sessionId')); const id=url.searchParams.get('fileId'); const token=url.searchParams.get('token');

      if(!session || session.remote!==remote || !token || session.tokens[id]!==token) throw fail(403,'Invalid session or token');

      const file=session.transfer.files.find(f=>f.id===id); if(!file || file.status!=='waiting' || session.transfer.controller.signal.aborted || !['waiting','transferring'].includes(session.transfer.status)) throw fail(409,'File is not available for upload');

      const metadata=session.metadata[id]; if(req.headers['content-length'] && Number(req.headers['content-length'])!==metadata.size) throw fail(400,'File size does not match');

      file.status='transferring'; session.transfer.status='transferring'; this.changed();

      let destination; let handle;

      try {

        ({destination,handle}=await this.reserveFile(metadata.fileName));

        const hash=metadata.sha256?crypto.createHash('sha256'):null; let count=0; const text=[];

        const meter=new Transform({highWaterMark:FILE_BUFFER_SIZE,transform:(chunk,encoding,callback)=>{count+=chunk.length;if(count>metadata.size)return callback(fail(400,'Received more bytes than declared'));hash?.update(chunk);if(metadata.fileType==='text/plain'&&metadata.size<=1048576)text.push(chunk);this.advance(session.transfer,file,chunk.length);callback(null,chunk);}});

        await pipeline(req,meter,handle.createWriteStream({highWaterMark:FILE_BUFFER_SIZE}),{signal:session.transfer.controller.signal});

        if(count!==metadata.size) throw fail(400,'Transfer was interrupted');

        if(metadata.sha256 && hash.digest('hex').toUpperCase()!==metadata.sha256.toUpperCase()) throw fail(422,'Checksum mismatch');

        file.status='completed';file.path=destination;if(metadata.fileType==='text/plain'&&metadata.size<=1048576)file.text=Buffer.concat(text).toString('utf8');

        const modified=metadata.metadata?.modified; if(modified && !Number.isNaN(Date.parse(modified))) await fsp.utimes(destination,new Date(),new Date(modified)).catch(()=>{});

        if(session.transfer.files.every(f=>f.status==='completed')) this.finish(session.transfer,'completed'); else this.progress(session.transfer);

        return respond(res,200);

      } catch(error) { await handle?.close().catch(()=>{}); if(destination)await fsp.unlink(destination).catch(()=>{});file.status='failed';this.finish(session.transfer,session.transfer.controller.signal.aborted?'cancelled':'failed',error.message);throw error; }

    }

    if(req.method==='POST' && route===API+'/cancel') { const session=this.sessions.get(url.searchParams.get('sessionId')); if(!session||session.remote!==remote)throw fail(403,'Invalid session');session.transfer.controller.abort();this.finish(session.transfer,'cancelled');return respond(res,200); }

    return respond(res,404,{message:'Unknown endpoint'});

  }

  respond({requestId,accept}) { const pending=this.pending.get(requestId);if(!pending)throw new Error('This request is no longer waiting.');pending.finish(accept===true);return this.getState(); }

  async reserveFile(name) {

    const root=path.resolve(this.settings.downloadDir);await fsp.mkdir(root,{recursive:true});const realRoot=await fsp.realpath(root);

    const relative=safeRelative(name);const candidate=path.resolve(root,relative);

    if(!candidate.toLowerCase().startsWith(root.toLowerCase()+path.sep))throw fail(400,'Unsafe destination');

    const parent=path.dirname(candidate);

    let cursor=root;

    for(const component of path.relative(root,parent).split(path.sep).filter(Boolean)) { cursor=path.join(cursor,component);try{await fsp.mkdir(cursor);}catch(error){if(error.code!=='EEXIST')throw error;}const resolved=await fsp.realpath(cursor);if(resolved!==realRoot&&!resolved.toLowerCase().startsWith(realRoot.toLowerCase()+path.sep))throw fail(400,'Destination points outside the receive folder'); }

    const realParent=await fsp.realpath(parent);

    if(realParent!==realRoot&&!realParent.toLowerCase().startsWith(realRoot.toLowerCase()+path.sep))throw fail(400,'Destination points outside the receive folder');

    const ext=path.extname(candidate),base=candidate.slice(0,candidate.length-ext.length);

    for(let i=0;i<10000;i++){const destination=i?`${base} (${i})${ext}`:candidate;try{return{destination,handle:await fsp.open(destination,'wx')};}catch(error){if(error.code!=='EEXIST')throw error;}}

    throw new Error('Too many files with the same name');

  }

  progress(transfer) { transfer.transferred=transfer.files.reduce((n,f)=>n+f.transferred,0);transfer.progress=transfer.total?Math.min(1,transfer.transferred/transfer.total):transfer.status==='completed'?1:0;this.changed(); }

  // The hot path must not scan up to 1,000 selected files for every TLS chunk.
  advance(transfer,file,bytes) { file.transferred+=bytes;transfer.transferred+=bytes;transfer.progress=transfer.total?Math.min(1,transfer.transferred/transfer.total):0;this.changed(); }

  finish(transfer,status,error) { if(transfer.saved)return;transfer.status=status;if(error)transfer.error=error;if(['failed','cancelled'].includes(status))transfer.controller?.abort();this.progress(transfer);if(status==='completed')transfer.progress=1;transfer.saved=true;const copy={...transfer,controller:undefined,peerInfo:undefined};this.history.unshift(copy);this.history=this.history.slice(0,30);fs.writeFileSync(path.join(this.dataDir,'history.json'),JSON.stringify(this.history,null,2));this.changed(true); }

  async addPaths(paths) {

    if(!Array.isArray(paths))throw new Error('Expected file paths');

    const add=async(source,name)=>{ if(this.selection.length>=1000)throw new Error('Select up to 1000 files at a time.'); const stat=await fsp.lstat(source);if(stat.isSymbolicLink())return;if(stat.isDirectory()){for(const child of await fsp.readdir(source))await add(path.join(source,child),path.join(name,child));}else if(stat.isFile()&&!this.selection.some(f=>f.source===source)){this.selection.push({id:uuid(),name:name.replaceAll('\\','/'),size:stat.size,type:'file',source,mime:fileMime(name),modified:stat.mtime.toISOString()});} };

    for(const source of paths)await add(path.resolve(source),path.basename(source));this.changed(true);return this.getState();

  }

  addText(text) { text=String(text).trim();if(!text)throw new Error('Enter a message.');if(Buffer.byteLength(text)>1048576)throw new Error('Messages can contain up to 1 MB of text.');this.selection.push({id:uuid(),name:'Message.txt',size:Buffer.byteLength(text),type:'text',text,mime:'text/plain'});this.changed(true);return this.getState(); }

  removeSelection(id) { this.selection=this.selection.filter(f=>f.id!==id);this.changed(true);return this.getState(); }

  clearSelection() { this.selection=[];this.changed(true);return this.getState(); }

  async send(peerId) {

    const peer=this.peers.get(peerId);if(!peer)throw new Error('Device is no longer available. Discover it again.');if(!this.selection.length)throw new Error('Select files or add a message first.');

    const files=this.selection.map(f=>({...f}));const controller=new AbortController();

    const transfer={id:uuid(),direction:'send',peer:peer.alias,peerInfo:peer,files:files.map(f=>({id:f.id,name:f.name,size:f.size,transferred:0,status:'waiting',...(f.type==='text'?{text:f.text}:{})})),status:'waiting',total:files.reduce((n,f)=>n+f.size,0),transferred:0,progress:0,createdAt:Date.now(),controller};

    this.transfers.unshift(transfer);this.changed(true);

    // Keep the IPC call quick; progress is delivered through state events.

    this.performSend(peer,files,transfer).catch(error=>this.finish(transfer,controller.signal.aborted?'cancelled':error.status===403?'rejected':'failed',error.message));

    return this.getState();

  }

  async performSend(peer,files,transfer) {

    const metadata=Object.fromEntries(files.map(f=>[f.id,{id:f.id,fileName:f.name,size:f.size,fileType:f.mime,preview:f.type==='text'?f.text:null,metadata:f.modified?{modified:f.modified}:null}]));

    const prepared=await this.request(peer,'/prepare-upload',{body:{info:this.info(),files:metadata},signal:transfer.controller.signal});

    if(prepared.status===204){for(const f of transfer.files){f.status='completed';f.transferred=f.size;}return this.finish(transfer,'completed');}

    const {sessionId,files:tokens}=prepared.data||{};if(!sessionId||!tokens)throw new Error('Receiver sent an invalid transfer response');transfer.remoteSessionId=sessionId;

    if(!files.some(f=>tokens[f.id]))throw fail(403,'The receiver did not accept any files.');

    transfer.status='transferring';this.changed(true);

    const batch=new AbortController(),signal=AbortSignal.any([transfer.controller.signal,batch.signal]);
    try {
      await runTransfers(files,parallelFiles(prepared.data.capabilities),async source=>{
        signal.throwIfAborted();
        const f=transfer.files.find(f=>f.id===source.id);
        if(!tokens[f.id]){f.status='skipped';return;}
        f.status='transferring';
        const stream=source.type==='text'?Readable.from([Buffer.from(source.text)]):fs.createReadStream(source.source,{highWaterMark:FILE_BUFFER_SIZE});
        try {
          await this.request(peer,'/upload?'+new URLSearchParams({sessionId,fileId:f.id,token:tokens[f.id]}),{stream,size:source.size,signal,onChunk:n=>this.advance(transfer,f,n)});
          signal.throwIfAborted();f.status='completed';this.progress(transfer);
        } catch(error) { stream.destroy();f.status=signal.aborted?'cancelled':'failed';throw error; }
      },()=>batch.abort());
      transfer.controller.signal.throwIfAborted();this.finish(transfer,'completed');
    }

    catch(error){await this.request(peer,'/cancel?'+new URLSearchParams({sessionId}),{timeout:2000}).catch(()=>{});throw error;}

  }

  cancelTransfer(id){const t=this.transfers.find(t=>t.id===id);if(t&&['waiting','transferring'].includes(t.status)){t.controller.abort();this.finish(t,'cancelled');}return this.getState();}

  updateSettings(partial) {

    if(!partial||typeof partial!=='object')throw new Error('Invalid settings');

    if(partial.alias!==undefined){const alias=String(partial.alias).trim();if(!alias||alias.length>80)throw new Error('Device name must be 1–80 characters.');this.settings.alias=alias;}

    if(partial.downloadDir!==undefined){if(typeof partial.downloadDir!=='string'||!path.isAbsolute(partial.downloadDir))throw new Error('Choose an absolute receive folder.');this.settings.downloadDir=partial.downloadDir;}

    if(partial.theme!==undefined&&['light','dark','system'].includes(partial.theme))this.settings.theme=partial.theme;

    if(partial.autoAccept!==undefined)this.settings.autoAccept=partial.autoAccept===true;

    if(partial.showAdvanced!==undefined)this.settings.showAdvanced=partial.showAdvanced===true;

    this.saveSettings();this.discover();this.changed(true);return this.getState();

  }

}



module.exports={LocalSendService,safeRelative,API};

