'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const crypto=require('node:crypto');
const https=require('node:https');
const {Readable}=require('node:stream');
const originalPcSource=path.resolve(__dirname,'..','..','src');
const pcSource=require('node:fs').existsSync(path.join(originalPcSource,'service.js'))?originalPcSource:path.resolve(__dirname,'..','pc-test-host');
const {LocalSendService}=require(path.join(pcSource,'service'));
const {loadCertificate}=require(path.join(pcSource,'certificate'));

test('Android Java engine and PC Node service transfer both directions over mutual TLS',{timeout:60000},async t=>{
  await fs.mkdir(path.join(__dirname,'..','test-output'),{recursive:true});
  const root=await fs.mkdtemp(path.join(__dirname,'..','test-output','interop-'));
  const mobileDir=path.join(root,'mobile');const mobileReceived=path.join(root,'mobile-received');
  loadCertificate(mobileDir);
  const pc=new LocalSendService({dataDir:path.join(root,'pc'),downloadDir:path.join(root,'pc-received'),alias:'PC integration test',port:0,host:'127.0.0.1',discovery:false,reverseReceive:false});
  await pc.start();
  const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin','java.exe'):'C:\\Program Files\\Microsoft\\jdk-17.0.20.101-hotspot\\bin\\java.exe';
  const classpath=[path.resolve(__dirname,'..','build','jvm-test'),path.resolve(__dirname,'..','tools','json-20250517.jar')].join(path.delimiter);
  const child=spawn(java,['-cp',classpath,'org.localsend.rebuilt.EngineHarness',path.join(mobileDir,'certificate.pem'),path.join(mobileDir,'private-key.pem'),mobileReceived],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let state,errors='',exited=false;const events=new Set();
  child.stderr.on('data',c=>errors+=c);child.on('exit',()=>{exited=true;for(const fn of events)fn();});
  createInterface({input:child.stdout}).on('line',line=>{try{const event=JSON.parse(line);if(event.state)state=event.state;if(event.type==='error')errors+=event.message;for(const fn of events)fn();}catch{errors+=line;}});
  const send=command=>child.stdin.write(JSON.stringify(command)+'\n');
  const until=(predicate,message)=>new Promise((resolve,reject)=>{let timer;const check=()=>{try{if(state&&predicate(state)){cleanup();resolve(state);}else if(exited){cleanup();reject(new Error('Java exited: '+errors));}}catch(error){cleanup();reject(error);}};const cleanup=()=>{clearTimeout(timer);events.delete(check);};timer=setTimeout(()=>{cleanup();reject(new Error(message+'\n'+errors+'\n'+JSON.stringify(state)));},12000);events.add(check);check();});
  const pcUntil=(predicate,message)=>new Promise((resolve,reject)=>{let timer;const check=()=>{if(predicate(pc.getState())){clearTimeout(timer);pc.off('state',check);resolve(pc.getState());}};timer=setTimeout(()=>{pc.off('state',check);reject(new Error(message));},12000);pc.on('state',check);check();});
  t.after(async()=>{try{send({action:'stop'});}catch{}child.stdin.end();await pc.stop();await new Promise(resolve=>{if(exited)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});});
  await until(s=>s.network.ready,'Mobile engine did not start');
  send({action:'peer',host:'127.0.0.1',port:pc.port});
  await until(s=>s.peers.some(p=>p.id===pc.info().fingerprint),'Mobile could not register with PC');
  const mobileId=state.device.fingerprint;
  assert.ok(pc.peers.has(mobileId));

  await t.test('PC to Android binary transfer with mobile approval',async()=>{
    const bytes=crypto.randomBytes(512*1024+37);const input=path.join(root,'desktop-file.bin');await fs.writeFile(input,bytes);
    await pc.addPaths([input]);await pc.send(mobileId);
    await until(s=>s.requests.length===1,'Mobile approval was not requested');
    send({action:'respond',requestId:state.requests[0].id,accept:true});
    await until(s=>s.history.some(x=>x.direction==='receive'&&x.status==='completed'),'Mobile receive did not finish');
    await pcUntil(s=>s.history.some(x=>x.direction==='send'&&x.status==='completed'),'PC send did not finish');
    assert.deepEqual(await fs.readFile(path.join(mobileReceived,'desktop-file.bin')),bytes);
  });
  await t.test('Android to PC binary transfer with PC approval',async()=>{
    const bytes=crypto.randomBytes(260*1024+13);const input=path.join(root,'mobile-file.bin');await fs.writeFile(input,bytes);
    send({action:'file',path:input});await until(s=>s.selection.some(f=>f.name==='mobile-file.bin'),'Mobile file was not selected');
    send({action:'send',peerId:pc.info().fingerprint});
    await pcUntil(s=>s.requests.length===1,'PC approval was not requested');pc.respond({requestId:pc.getState().requests[0].id,accept:true});
    await pcUntil(s=>s.history.some(x=>x.direction==='receive'&&x.status==='completed'),'PC receive did not finish');
    await until(s=>s.history.some(x=>x.direction==='send'&&x.status==='completed'),'Mobile send did not finish');
    assert.deepEqual(await fs.readFile(path.join(root,'pc-received','mobile-file.bin')),bytes);
  });
  await t.test('Android handles PC rejection without writing text',async()=>{
    send({action:'clear'});send({action:'text',text:'PC ↔ Android 🔒'});await until(s=>s.selection.length===1&&s.selection[0].type==='text','Mobile text was not selected');
    send({action:'send',peerId:pc.info().fingerprint});await pcUntil(s=>s.requests.length===1,'PC text approval was not requested');pc.respond({requestId:pc.getState().requests[0].id,accept:false});
    await until(s=>s.history.some(x=>x.status==='rejected'||x.status==='failed'),'Mobile did not handle rejection');
    assert.equal(await fs.access(path.join(root,'pc-received','Message.txt')).then(()=>true,()=>false),false);
  });
  await t.test('Android sends UTF-8 text to PC after rejection',async()=>{
    send({action:'send',peerId:pc.info().fingerprint});await pcUntil(s=>s.requests.length===1,'PC second text approval was not requested');pc.respond({requestId:pc.getState().requests[0].id,accept:true});
    await pcUntil(s=>s.history.filter(x=>x.direction==='receive'&&x.status==='completed').length===2,'PC text receive did not finish');
    assert.equal(await fs.readFile(path.join(root,'pc-received','Message.txt'),'utf8'),'PC ↔ Android 🔒');
  });
  await t.test('Android rejects traversal before approval',async()=>{
    const peer={...state.device,host:'127.0.0.1'};
    await assert.rejects(pc.request(peer,'/prepare-upload',{body:{info:pc.info(),files:{unsafe:{id:'unsafe',fileName:'../escape.txt',fileType:'text/plain',size:0}}}}),error=>error.status===400);
    assert.equal(state.requests.length,0);
  });
  await t.test('Android preserves duplicates on repeated PC send',async()=>{
    await pc.send(mobileId);await until(s=>s.requests.length===1,'Repeated mobile approval was not requested');send({action:'respond',requestId:state.requests[0].id,accept:true});
    await until(s=>s.history.filter(x=>x.direction==='receive'&&x.status==='completed').length===2,'Repeated mobile transfer did not finish');
    assert.deepEqual(await fs.readFile(path.join(mobileReceived,'desktop-file (1).bin')),await fs.readFile(path.join(mobileReceived,'desktop-file.bin')));
  });
  const mobilePeer={...state.device,host:'127.0.0.1'};
  async function prepareMobile(name,bytes,extra={}){
    const result=pc.request(mobilePeer,'/prepare-upload',{body:{info:pc.info(),files:{fixture:{id:'fixture',fileName:name,fileType:'application/octet-stream',size:bytes.length,...extra}}}});
    // State notifications are coalesced. A fast upload can finish before the
    // previous dialog disappears from the last observed snapshot; approve only
    // the new named request, never that stale request ID.
    await until(s=>s.requests.some(request=>request.files.some(file=>file.fileName===name)),'Raw mobile approval was not requested for '+name);
    const request=state.requests.find(request=>request.files.some(file=>file.fileName===name));
    send({action:'respond',requestId:request.id,accept:true});return (await result).data;
  }
  const uploadMobile=(prepared,bytes,token=prepared.files.fixture)=>pc.request(mobilePeer,'/upload?'+new URLSearchParams({sessionId:prepared.sessionId,fileId:'fixture',token}),{stream:Readable.from([bytes]),size:bytes.length});
  await t.test('Android rejects spoofed certificate identity',async()=>{
    await assert.rejects(pc.request(mobilePeer,'/register',{body:{...pc.info(),fingerprint:'0'.repeat(64)}}),error=>error.status===403);
  });
  await t.test('Android rejects wrong token and accepts correct token',async()=>{
    const bytes=Buffer.from('Only the accepted token may write this file.');const prepared=await prepareMobile('token-test.txt',bytes);
    await assert.rejects(uploadMobile(prepared,bytes,'wrong-token'),error=>error.status===403);
    assert.equal(await fs.access(path.join(mobileReceived,'token-test.txt')).then(()=>true,()=>false),false);
    await uploadMobile(prepared,bytes);assert.deepEqual(await fs.readFile(path.join(mobileReceived,'token-test.txt')),bytes);
  });
  await t.test('Android checks SHA-256 and removes failed file',async()=>{
    const bytes=Buffer.from('This checksum is deliberately wrong.');const prepared=await prepareMobile('checksum-test.bin',bytes,{sha256:'0'.repeat(64)});
    await assert.rejects(uploadMobile(prepared,bytes),error=>error.status===422);
    assert.equal(await fs.access(path.join(mobileReceived,'checksum-test.bin')).then(()=>true,()=>false),false);
  });
  await t.test('Android receives empty files and honours session cancellation',async()=>{
    const empty=await prepareMobile('empty.bin',Buffer.alloc(0));await uploadMobile(empty,Buffer.alloc(0));assert.equal((await fs.stat(path.join(mobileReceived,'empty.bin'))).size,0);
    const bytes=Buffer.from('cancelled');const cancelled=await prepareMobile('cancelled.bin',bytes);
    await pc.request(mobilePeer,'/cancel?'+new URLSearchParams({sessionId:cancelled.sessionId}));
    await assert.rejects(uploadMobile(cancelled,bytes),error=>[403,409].includes(error.status));
    assert.equal(await fs.access(path.join(mobileReceived,'cancelled.bin')).then(()=>true,()=>false),false);
  });
  assert.equal(errors,'');
});

// These fixtures use the same Java transport class as the APK. The PC is not a
// Java mock: its outgoing HTTPS requests terminate at the real Java TLS server.
async function reverseFixture(t,{automatic=true,direct=false}={}) {
  await fs.mkdir(path.join(__dirname,'..','test-output'),{recursive:true});
  const root=await fs.mkdtemp(path.join(__dirname,'..','test-output','reverse-interop-'));
  const mobileDir=path.join(root,'mobile');loadCertificate(mobileDir);
  const pc=new LocalSendService({dataDir:path.join(root,'pc'),downloadDir:path.join(root,'pc-received'),alias:'PC integration test',port:0,host:'127.0.0.1',discovery:false,reverseReceive:automatic&&!direct});
  if(!automatic&&!direct){const originalInfo=pc.info.bind(pc);pc.info=()=>({...originalInfo(),capabilities:{reverseReceive:1}});}
  await pc.start();
  const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin','java.exe'):'C:\\Program Files\\Microsoft\\jdk-17.0.20.101-hotspot\\bin\\java.exe';
  const classpath=[path.resolve(__dirname,'..','build','jvm-test'),path.resolve(__dirname,'..','tools','json-20250517.jar')].join(path.delimiter);
  const child=spawn(java,['-cp',classpath,'org.localsend.rebuilt.EngineHarness',path.join(mobileDir,'certificate.pem'),path.join(mobileDir,'private-key.pem'),path.join(root,'mobile-received')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let state,errors='',exited=false,openedSources=0,activeSources=0,peakSources=0,nextCommand=0;const events=new Set(),commands=new Map();
  child.stderr.on('data',chunk=>errors+=chunk);
  child.on('error',error=>{errors+=error.message;exited=true;for(const fn of events)fn();});
  child.on('exit',()=>{exited=true;for(const fn of events)fn();});
  createInterface({input:child.stdout}).on('line',line=>{
    try {
      const event=JSON.parse(line);if(event.state)state=event.state;if(Number.isInteger(event.openedSources))openedSources=event.openedSources;
      if(Number.isInteger(event.activeSources))activeSources=event.activeSources;if(Number.isInteger(event.peakSources))peakSources=event.peakSources;
      const command=commands.get(event.id);if(command&&event.type==='result'){commands.delete(event.id);command.resolve(state);}else if(event.type==='error'){if(command){commands.delete(event.id);command.reject(new Error(event.message));}else errors+=event.message;}
      for(const fn of events)fn();
    } catch(error){errors+=line+' '+error.message;}
  });
  const send=command=>new Promise((resolve,reject)=>{
    const id=String(++nextCommand),timer=setTimeout(()=>{commands.delete(id);reject(new Error('Mobile command timed out: '+command.action+' '+errors));},12000);
    commands.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    child.stdin.write(JSON.stringify({...command,id})+'\n');
  });
  const until=(predicate,message,timeout=15000)=>new Promise((resolve,reject)=>{
    let timer;const cleanup=()=>{clearTimeout(timer);events.delete(check);};
    const check=()=>{try{if(state&&predicate(state)){cleanup();resolve(state);}else if(exited){cleanup();reject(new Error('Java exited: '+errors));}}catch(error){cleanup();reject(error);}};
    timer=setTimeout(()=>{cleanup();reject(new Error(message+'\n'+errors+'\n'+JSON.stringify(state)));},timeout);events.add(check);check();
  });
  const pcUntil=(predicate,message,timeout=15000)=>new Promise((resolve,reject)=>{
    let timer;const check=()=>{try{if(predicate(pc.getState())){clearTimeout(timer);pc.off('state',check);resolve(pc.getState());}}catch(error){clearTimeout(timer);pc.off('state',check);reject(error);}};
    timer=setTimeout(()=>{pc.off('state',check);reject(new Error(message+'\n'+JSON.stringify(pc.getState())));},timeout);pc.on('state',check);check();
  });
  t.after(async()=>{
    try{child.stdin.write(JSON.stringify({action:'stop'})+'\n');}catch{}child.stdin.end();await pc.stop();
    await new Promise(resolve=>{if(exited)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});
  });
  await until(s=>s.network.ready,'Mobile engine did not start');
  const mobilePeer={...state.device,host:'127.0.0.1'};
  assert.equal(mobilePeer.capabilities.reversePull,1);
  // Deny incoming PC requests before initial pairing, too. This is the actual
  // manual-connect recovery flow on a PC whose inbound connections are blocked.
  let incomingRequests=0;
  if(!direct)pc.handle=async(req,res)=>{incomingRequests++;res.destroy();};
  await pc.addPeer({host:mobilePeer.host,port:mobilePeer.port,protocol:'https'});
  await until(s=>s.peers.some(peer=>peer.id===pc.info().fingerprint),'Phone did not learn the PC through its outgoing registration');
  return {root,pc,mobilePeer,send,until,pcUntil,state:()=>state,opened:()=>openedSources,sources:()=>({active:activeSources,peak:peakSources}),incoming:()=>incomingRequests,errors:()=>errors};
}

function binaryRequest(sender,peer,route,body,{certificate=true}={}) {
  const bytes=Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:peer.host,port:peer.port,method:'POST',path:'/api/localsend/v2'+route,rejectUnauthorized:false,agent:false,
      ...(certificate?{key:sender.tls.key,cert:sender.tls.cert}:{}),headers:{'Content-Type':'application/json','Content-Length':bytes.length}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
    });
    req.setTimeout(15000,()=>req.destroy(new Error('Raw reverse request timed out')));req.on('error',reject);req.end(bytes);
  });
}

async function noPartialFiles(directory, prefix) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    if(!(await fs.readdir(directory).catch(()=>[])).some(name=>name.startsWith(prefix)))return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail('Incomplete files left behind: '+prefix);
}

for(const direct of [true,false]) test('Parallel Android '+(direct?'direct':'reverse')+' batches preserve bytes and stop all workers',{timeout:120000},async t=>{
  const f=await reverseFixture(t,{direct}),{pc}=f;
  const bytes=crypto.randomBytes(2*1024*1024+37),input=path.join(f.root,'fixture.bin');await fs.writeFile(input,bytes);
  const received=path.join(f.root,'pc-received');
  const history=(s,prefix,direction)=>s.history.find(x=>x.direction===direction&&x.files.some(file=>file.name.startsWith(prefix)));
  async function select(prefix,options={}) {
    await f.send({action:'clear'});
    for(let i=0;i<6;i++)await f.send({action:'file',path:input,name:prefix+i+'.bin',slowReadMs:40,...(i===0?options:{})});
  }
  async function start() {
    await f.send({action:'send',peerId:pc.info().fingerprint});
    await f.pcUntil(s=>s.requests.length===1,'Batch approval missing');
    pc.respond({requestId:pc.getState().requests[0].id,accept:true});
  }
  await t.test('six files overlap with at most three open sources and exact saved contents',async()=>{
    await select('parallel-');await start();
    await f.pcUntil(s=>history(s,'parallel-','receive'),'Batch did not finish');
    await f.until(s=>history(s,'parallel-','send'),'Phone did not acknowledge batch');
    const result=history(pc.getState(),'parallel-','receive');
    assert.equal(result.status,'completed');assert.equal(result.transferred,bytes.length*6);
    assert.equal(history(f.state(),'parallel-','send').transferred,bytes.length*6);
    assert.equal(f.sources().peak,3);assert.equal(f.sources().active,0);
    for(let i=0;i<6;i++)assert.deepEqual(await fs.readFile(path.join(received,'parallel-'+i+'.bin')),bytes);
    if(!direct)assert.equal(f.incoming(),0);
  });
  await t.test('cancelling three in-flight files closes every source and removes partial files',async()=>{
    await select('cancel-batch-',{slowReadMs:120});await start();
    await f.until(()=>f.sources().active===3,'Three sources never became active');
    const transfer=f.state().transfers.find(x=>x.direction==='send'&&x.files.some(file=>file.name==='cancel-batch-0.bin'));
    await f.send({action:'cancel',transferId:transfer.id});
    await f.pcUntil(s=>history(s,'cancel-batch-','receive'),'Cancelled PC receive did not terminate');
    await f.until(()=>f.sources().active===0,'Cancelled sources stayed open');
    assert.equal(history(f.state(),'cancel-batch-','send').status,'cancelled');
    await noPartialFiles(received,'cancel-batch-');
  });
  await t.test('a failed source aborts the batch without reporting successful delivery',async()=>{
    await select('failure-batch-',{failAfterBytes:256*1024});await start();
    await f.pcUntil(s=>history(s,'failure-batch-','receive'),'Failed receive did not terminate');
    await f.until(s=>history(s,'failure-batch-','send')&&f.sources().active===0,'Failed batch leaked a source');
    assert.equal(history(f.state(),'failure-batch-','send').status,'failed');
    assert.notEqual(history(pc.getState(),'failure-batch-','receive').status,'completed');
    // Other files may already have finished before the failing source was opened.
    // Keep those intact, but never leave an incomplete destination behind.
    for(const file of history(pc.getState(),'failure-batch-','receive').files) {
      if(file.status==='completed')assert.deepEqual(await fs.readFile(path.join(received,file.name)),bytes);
      else await noPartialFiles(received,file.name);
    }
    assert.equal(await fs.access(path.join(received,'failure-batch-0.bin')).then(()=>true,()=>false),false);
    assert.deepEqual(await fs.readFile(path.join(received,'parallel-0.bin')),bytes,'Previous completed file changed');
  });
  if(direct)await t.test('PC-to-Android negotiates three streams and falls back to one for an older reply',async()=>{
    const original=pc.request.bind(pc);let active=0,peak=0,legacy=false;
    pc.request=async(peer,route,options)=>{
      if(route.startsWith('/upload?')){active++;peak=Math.max(peak,active);try{return await original(peer,route,options);}finally{active--;}}
      const result=await original(peer,route,options);
      if(legacy&&route==='/prepare-upload')delete result.data.capabilities;
      return result;
    };
    try {
      for(const old of [false,true]) {
        legacy=old;peak=0;pc.clearSelection();const prefix=old?'legacy-':'pc-parallel-';
        const paths=[];
        for(let i=0;i<6;i++){const file=path.join(f.root,prefix+i+'.bin');await fs.writeFile(file,bytes);paths.push(file);}
        await pc.addPaths(paths);await pc.send(f.mobilePeer.fingerprint);
        await f.until(s=>s.requests.some(x=>x.files.some(file=>file.fileName===prefix+'0.bin')),'Phone batch approval missing');
        await f.send({action:'respond',requestId:f.state().requests.find(x=>x.files.some(file=>file.fileName===prefix+'0.bin')).id,accept:true});
        await f.pcUntil(s=>history(s,prefix,'send'),'PC batch send incomplete');
        await f.until(s=>history(s,prefix,'receive'),'Phone batch receive incomplete');
        assert.equal(history(pc.getState(),prefix,'send').status,'completed');assert.equal(peak,old?1:3);
        for(let i=0;i<6;i++)assert.deepEqual(await fs.readFile(path.join(f.root,'mobile-received',prefix+i+'.bin')),bytes);
      }
    }finally{pc.request=original;}
  });
  assert.equal(f.errors(),'');
});

test('Android sends through a PC-initiated TLS path while every incoming PC request is denied',{timeout:100000},async t=>{
  const f=await reverseFixture(t),{pc}=f;
  await f.pcUntil(s=>s.network.reverseReady===true,'PC did not establish its outgoing reverse poll');
  const pcId=pc.info().fingerprint;
  const completed=(state,direction)=>state.history.filter(item=>item.direction===direction&&item.status==='completed').length;
  let receives=0,sends=0;

  await t.test('binary data waits for PC approval and arrives without an Android-to-PC request',async()=>{
    const bytes=crypto.randomBytes(768*1024+31),input=path.join(f.root,'reverse-binary.bin');await fs.writeFile(input,bytes);
    await f.send({action:'file',path:input});const opened=f.opened();await f.send({action:'send',peerId:pcId});
    await f.pcUntil(s=>s.requests.length===1,'PC did not display reverse-transfer approval');
    assert.equal(f.opened(),opened,'Source was read before the PC approved');
    pc.respond({requestId:pc.getState().requests[0].id,accept:true});
    receives++;await f.pcUntil(s=>completed(s,'receive')===receives,'PC reverse binary receive did not complete');
    await f.until(s=>completed(s,'send')>sends,'Mobile reverse binary send did not complete');sends++;
    assert.deepEqual(await fs.readFile(path.join(f.root,'pc-received','reverse-binary.bin')),bytes);
    assert.equal(f.incoming(),0,'Android tried opening an incoming PC connection');
  });
  await t.test('an empty file completes with a zero-byte body',async()=>{
    await f.send({action:'clear'});const input=path.join(f.root,'reverse-empty.bin');await fs.writeFile(input,Buffer.alloc(0));
    await f.send({action:'file',path:input});await f.send({action:'send',peerId:pcId});
    await f.pcUntil(s=>s.requests.length===1,'PC did not request empty-file approval');pc.respond({requestId:pc.getState().requests[0].id,accept:true});
    receives++;await f.pcUntil(s=>completed(s,'receive')===receives,'PC reverse empty receive did not complete');
    sends++;await f.until(s=>completed(s,'send')===sends,'Mobile reverse empty send did not complete');
    assert.equal((await fs.stat(path.join(f.root,'pc-received','reverse-empty.bin'))).size,0);
  });
  await t.test('UTF-8 text survives the reverse path',async()=>{
    await f.send({action:'clear'});await f.send({action:'text',text:'Reverse PC ↔ Android 🔒 — café'});await f.send({action:'send',peerId:pcId});
    await f.pcUntil(s=>s.requests.length===1,'PC did not request reverse text approval');pc.respond({requestId:pc.getState().requests[0].id,accept:true});
    receives++;await f.pcUntil(s=>completed(s,'receive')===receives,'PC reverse text receive did not complete');
    sends++;await f.until(s=>completed(s,'send')===sends,'Mobile reverse text send did not complete');
    assert.equal(await fs.readFile(path.join(f.root,'pc-received','Message.txt'),'utf8'),'Reverse PC ↔ Android 🔒 — café');
  });
  await t.test('declining a reverse offer never opens its source',async()=>{
    await f.send({action:'clear'});const input=path.join(f.root,'declined-source.bin');await fs.writeFile(input,crypto.randomBytes(200000));
    await f.send({action:'file',path:input});const opened=f.opened(),oldFailures=f.state().history.filter(item=>item.direction==='send'&&item.status!=='completed').length;
    await f.send({action:'send',peerId:pcId});await f.pcUntil(s=>s.requests.length===1,'PC did not request decline approval');pc.respond({requestId:pc.getState().requests[0].id,accept:false});
    await f.until(s=>s.history.filter(item=>item.direction==='send'&&item.status!=='completed').length>oldFailures,'Mobile did not receive reverse rejection');
    assert.equal(f.opened(),opened);assert.equal(await fs.access(path.join(f.root,'pc-received','declined-source.bin')).then(()=>true,()=>false),false);
  });
  await t.test('mobile cancellation stops an accepted slow source and removes the partial PC file',async()=>{
    await f.send({action:'clear'});const input=path.join(f.root,'cancel-reverse.bin');await fs.writeFile(input,crypto.randomBytes(12*1024*1024));
    await f.send({action:'file',path:input,slowReadMs:40});await f.send({action:'send',peerId:pcId});
    await f.pcUntil(s=>s.requests.length===1,'PC did not request slow-file approval');pc.respond({requestId:pc.getState().requests[0].id,accept:true});
    await f.pcUntil(s=>s.transfers.some(item=>item.direction==='receive'&&item.status==='transferring'&&item.transferred>0),'PC never began the reverse data stream');
    const active=f.state().transfers.find(item=>item.direction==='send'&&!['completed','cancelled','failed','rejected'].includes(item.status));assert.ok(active);
    await f.send({action:'cancel',transferId:active.id});
    await f.pcUntil(s=>s.history.some(item=>item.direction==='receive'&&item.files.some(file=>file.name==='cancel-reverse.bin')&&['failed','cancelled'].includes(item.status)),'PC did not terminate the cancelled reverse receive');
    assert.equal(await fs.access(path.join(f.root,'pc-received','cancel-reverse.bin')).then(()=>true,()=>false),false);
    assert.ok((await fs.readdir(path.join(f.root,'pc-received'))).every(name=>!name.includes('.part')),'Partial reverse file was left behind');
  });
  await t.test('a restarted PC reconnects to its saved phone without any incoming PC request',async()=>{
    await pc.stop();
    const restored=new LocalSendService({dataDir:pc.dataDir,downloadDir:pc.settings.downloadDir,alias:'Restarted PC',port:0,host:'127.0.0.1',discovery:false,autoAccept:true});
    let incoming=0;restored.handle=async(req,res)=>{incoming++;res.destroy();};
    const until=async(predicate,message)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(predicate(restored.getState()))return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error(message+' '+JSON.stringify(restored.getState()));};
    try{
      await restored.start();await until(s=>s.network.reverseReady,'Saved phone did not reconnect');
      await f.send({action:'clear'});await f.send({action:'text',text:'Reconnect after PC restart'});await f.send({action:'send',peerId:pcId});
      await until(s=>s.history.some(item=>item.connectionMode==='reverse'&&item.status==='completed'&&item.files.some(file=>file.text==='Reconnect after PC restart')),'Restarted PC did not receive the queued text');
      assert.equal(incoming,0);assert.equal(restored.info().fingerprint,pcId);
    }finally{await restored.stop();}
  });
  assert.equal(f.incoming(),0);assert.equal(f.errors(),'');
});

test('Java reverse offers enforce mutual TLS, recipient identity, tokens and terminal state',{timeout:75000},async t=>{
  const f=await reverseFixture(t,{automatic:false}),{pc,mobilePeer}=f;
  const attacker=new LocalSendService({dataDir:path.join(f.root,'attacker'),port:59819,discovery:false,reverseReceive:false});
  const pcId=pc.info().fingerprint,route='/rebuilt/reverse';
  const owner=extra=>({info:pc.info(),...extra});
  const decision=(offerId,action,sender=pc,info=sender.info())=>sender.request(mobilePeer,route+'/decision',{body:{info,offerId,action}});
  const input=path.join(f.root,'boundary.bin'),bytes=crypto.randomBytes(196*1024+7);await fs.writeFile(input,bytes);
  await f.send({action:'file',path:input});const opened=f.opened();await f.send({action:'send',peerId:pcId});
  const polled=await pc.request(mobilePeer,route+'/poll',{body:owner()});assert.equal(polled.status,200);const offer=polled.data.offer;assert.ok(offer?.id);
  assert.equal(offer.info.fingerprint,mobilePeer.fingerprint);assert.ok(Number.isFinite(offer.expiresAt));assert.equal(Object.keys(offer.files).length,1);
  const fileId=Object.keys(offer.files)[0];

  await t.test('missing client certificate and a spoofed body fingerprint are denied',async()=>{
    await assert.rejects(binaryRequest(pc,mobilePeer,route+'/poll',owner(),{certificate:false}),error=>error.code==='ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'||error.code==='ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE');
    await assert.rejects(attacker.request(mobilePeer,route+'/poll',{body:owner()}),error=>error.status===403);
    assert.equal(f.opened(),opened);
  });
  await t.test('a different recipient sees no offer and cannot claim another recipient\'s transfer',async()=>{
    const invisible=await attacker.request(mobilePeer,route+'/poll',{body:{info:attacker.info()}});assert.equal(invisible.status,204);
    await assert.rejects(decision(offer.id,'accept',attacker),error=>[403,404].includes(error.status));assert.equal(f.opened(),opened);
  });
  let token;
  await t.test('acceptance grants only the intended receiver a source token',async()=>{
    const accepted=await decision(offer.id,'accept');assert.equal(accepted.data.sessionId,offer.id);token=accepted.data.files[fileId];assert.ok(typeof token==='string'&&token.length>=16);
    const bad=await binaryRequest(pc,mobilePeer,route+'/file',owner({offerId:offer.id,fileId,token:'wrong-token'}));assert.equal(bad.status,403);
    const stolen=await binaryRequest(attacker,mobilePeer,route+'/file',{info:attacker.info(),offerId:offer.id,fileId,token});assert.equal(stolen.status,403);
    assert.equal(f.opened(),opened,'Authentication/token failure opened a source');
  });
  await t.test('exact bytes are streamed once and completing the offer retires its token',async()=>{
    const served=await binaryRequest(pc,mobilePeer,route+'/file',owner({offerId:offer.id,fileId,token}));
    assert.equal(served.status,200);assert.equal(Number(served.headers['content-length']),bytes.length);assert.equal(served.headers['transfer-encoding'],undefined);assert.deepEqual(served.bytes,bytes);
    const replay=await binaryRequest(pc,mobilePeer,route+'/file',owner({offerId:offer.id,fileId,token}));assert.equal(replay.status,409);
    await decision(offer.id,'complete');await f.until(s=>s.history.some(item=>item.direction==='send'&&item.status==='completed'),'Mobile did not acknowledge reverse completion');
    const retired=await binaryRequest(pc,mobilePeer,route+'/file',owner({offerId:offer.id,fileId,token}));assert.ok([403,404,409,410].includes(retired.status));
    assert.equal(f.opened(),opened+1,'Replay reopened the original source');
  });
  await t.test('cancelling a queued offer retires access without reading bytes',async()=>{
    await f.send({action:'send',peerId:pcId});const next=(await pc.request(mobilePeer,route+'/poll',{body:owner()})).data.offer;
    assert.notEqual(next.id,offer.id);await decision(next.id,'cancel');
    const cancelled=await binaryRequest(pc,mobilePeer,route+'/file',owner({offerId:next.id,fileId:Object.keys(next.files)[0],token:'retired'}));assert.ok([403,404,409,410].includes(cancelled.status));
    await f.until(s=>s.history.some(item=>item.direction==='send'&&item.status==='cancelled'),'Mobile did not finalize the cancelled queued offer');assert.equal(f.opened(),opened+1);
  });
  assert.equal(f.incoming(),0);assert.equal(f.errors(),'');
});
