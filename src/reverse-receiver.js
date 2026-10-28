'use strict';
const https=require('node:https');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {parallelFiles,runTransfers}=require('./transfer-pool');
const ROUTE='/api/localsend/v2/rebuilt/reverse';
const FILE_BUFFER_SIZE=256*1024;
const fingerprint=value=>String(value||'').replaceAll(':','').toUpperCase();
const fail=(status,message)=>Object.assign(new Error(message),{status});

// Every connection here originates at the receiving PC. No firewall policy is changed.
class ReverseReceiver {
  constructor(service,{validatePath}){this.service=service;this.validatePath=validatePath;this.peers=new Map();this.active=new Map();this.tasks=new Set();this.running=false;}
  start(){this.running=true;for(const peer of [...this.service.knownPeers,...[...this.service.peers.values()].filter(p=>p.verified)])this.observe(peer);}
  observe(peer){
    if(!this.running||peer.protocol!=='https'||peer.capabilities?.reversePull!==1)return;
    const existing=this.peers.get(peer.id);if(existing){existing.peer=peer;return;}
    if(this.peers.size>=16)return;
    const entry={peer,controller:new AbortController(),connected:false,lastSuccess:0};this.peers.set(peer.id,entry);void this.poll(entry);
  }
  update(){
    const connected=[...this.peers.values()].filter(p=>p.connected&&(p.processing||Date.now()-p.lastSuccess<15000));
    this.service.network.reverseReady=connected.length>0;
    this.service.network.reversePeers=connected.map(p=>({id:p.peer.id,alias:p.peer.alias}));
    this.service.changed();
  }
  async poll(entry){
    if(!this.running||entry.controller.signal.aborted)return;
    let delay=700;
    try{
      const result=await this.json(entry.peer,'poll',{info:this.service.info()},{signal:entry.controller.signal,timeout:7000});
      entry.connected=true;entry.lastSuccess=Date.now();
      this.service.peers.set(entry.peer.id,{...entry.peer,lastSeen:Date.now()});this.update();
      if(result.data?.offer&&!this.active.size&&!this.service.pending.size&&!this.service.transfers.some(t=>t.direction==='receive'&&!t.saved&&['waiting','transferring'].includes(t.status))){
        entry.processing=true;const task=this.receive(entry.peer,result.data.offer);this.tasks.add(task);try{await task;}finally{entry.processing=false;this.tasks.delete(task);}
      }
    }catch(error){entry.connected=false;delay=error.status===404?30000:3500;this.update();}
    finally{if(this.running&&!entry.controller.signal.aborted){entry.timer=setTimeout(()=>void this.poll(entry),delay);entry.timer.unref?.();}}
  }
  validate(peer,offer){
    if(!offer||typeof offer.id!=='string'||!offer.id||offer.id.length>200||!this.service.validPeer(offer.info)||fingerprint(offer.info.fingerprint)!==fingerprint(peer.fingerprint))throw new Error('Invalid phone transfer identity.');
    if(!offer.files||typeof offer.files!=='object'||Array.isArray(offer.files))throw new Error('Invalid phone transfer metadata.');
    const files=Object.entries(offer.files);let total=0;
    if(!files.length||files.length>1000)throw new Error('Invalid phone file count.');
    for(const [id,file]of files){
      if(!id||id.length>200||!file||typeof file.fileType!=='string'||!Number.isSafeInteger(file.size)||file.size<0)throw new Error('Invalid phone file metadata.');
      this.validatePath(file.fileName);if(file.sha256&&!/^[a-f\d]{64}$/i.test(file.sha256))throw new Error('Invalid phone checksum.');
      total+=file.size;if(!Number.isSafeInteger(total))throw new Error('Phone transfer is too large.');
    }
    return {files,total};
  }
  approval(peer,offer,files,signal){
    return new Promise(resolve=>{
      const id=crypto.randomUUID();let done=false,timer;
      const finish=accept=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);this.service.pending.delete(id);this.service.changed(true);resolve(accept);};
      const abort=()=>finish(false);
      this.service.pending.set(id,{public:{id,alias:peer.alias,host:peer.host,files:files.map(([fileId,file])=>({...file,id:fileId})),connectionMode:'reverse'},finish});
      signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>finish(false),120000);
      this.service.changed(true);if(this.service.settings.autoAccept)finish(true);if(signal.aborted)finish(false);
    });
  }
  async receive(peer,offer){
    const {files,total}=this.validate(peer,offer),controller=new AbortController();
    const active={peer,offer,controller};this.active.set(offer.id,active);
    let transfer;
    const decision=(action,message)=>this.json(peer,'decision',{info:this.service.info(),offerId:offer.id,action,...(message?{message:String(message).slice(0,400)}:{})},{timeout:5000});
    try{
      const accepted=await this.approval(peer,offer,files,controller.signal);
      if(!accepted){await decision(controller.signal.aborted?'cancel':'decline');return;}
      transfer={id:crypto.randomUUID(),direction:'receive',peer:peer.alias,files:files.map(([id,f])=>({id,name:f.fileName,size:f.size,transferred:0,status:'waiting'})),status:'waiting',total,transferred:0,progress:0,createdAt:Date.now(),controller,connectionMode:'reverse'};
      this.service.transfers.unshift(transfer);this.service.changed(true);
      const claimed=await this.json(peer,'decision',{info:this.service.info(),offerId:offer.id,action:'accept'},{signal:controller.signal,timeout:10000});
      const tokens=claimed.data?.files;if(!tokens||!files.every(([id])=>typeof tokens[id]==='string'&&tokens[id].length>0))throw new Error('Phone did not authorize the selected files.');
      transfer.status='transferring';this.service.changed(true);
      const batch=new AbortController(),signal=AbortSignal.any([controller.signal,batch.signal]);
      await runTransfers(files,parallelFiles(claimed.data.capabilities),async ([id,metadata])=>{
        signal.throwIfAborted();
        const file=transfer.files.find(f=>f.id===id);file.status='transferring';
        let destination,handle,response;
        try{
          response=await this.open(peer,'file',{info:this.service.info(),offerId:offer.id,fileId:id,token:tokens[id]},{signal,timeout:120000});
          if(response.statusCode!==200){const result=await this.readResponse(response);throw fail(response.statusCode,result?.message||'Phone could not open the selected file.');}
          if(Number(response.headers['content-length'])!==metadata.size){response.destroy();throw new Error('Phone returned a different file size.');}
          ({destination,handle}=await this.service.reserveFile(metadata.fileName));
          const hash=metadata.sha256?crypto.createHash('sha256'):null,text=[];let count=0;
          const meter=new Transform({highWaterMark:FILE_BUFFER_SIZE,transform:(chunk,encoding,callback)=>{count+=chunk.length;if(count>metadata.size)return callback(new Error('Phone sent more bytes than declared.'));hash?.update(chunk);if(metadata.fileType==='text/plain'&&metadata.size<=1048576)text.push(chunk);this.service.advance(transfer,file,chunk.length);callback(null,chunk);}});
          await pipeline(response,meter,handle.createWriteStream({highWaterMark:FILE_BUFFER_SIZE}),{signal});handle=null;
          signal.throwIfAborted();
          if(count!==metadata.size)throw new Error('Phone transfer was interrupted.');
          if(metadata.sha256&&hash.digest('hex').toUpperCase()!==metadata.sha256.toUpperCase())throw new Error('Checksum mismatch.');
          file.path=destination;file.status='completed';if(metadata.fileType==='text/plain'&&metadata.size<=1048576)file.text=Buffer.concat(text).toString('utf8');this.service.progress(transfer);
        }catch(error){response?.destroy();await handle?.close().catch(()=>{});if(destination)await fs.unlink(destination).catch(()=>{});file.status=signal.aborted?'cancelled':'failed';throw error;}
      },()=>batch.abort());
      if(controller.signal.aborted)throw new Error('Transfer cancelled.');
      for(let attempt=0;;attempt++){try{await decision('complete');break;}catch(error){if(error.status!==409||attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,150));}}
      this.service.finish(transfer,'completed');
    }catch(error){
      const cancelled=controller.signal.aborted;
      if(transfer&&!transfer.saved)this.service.finish(transfer,cancelled?'cancelled':'failed',error.message);
      await decision(cancelled?'cancel':'fail',error.message).catch(()=>{});
    }finally{this.active.delete(offer.id);this.update();}
  }
  open(peer,route,body,{signal,timeout=10000}={}){
    return new Promise((resolve,reject)=>{
      const data=Buffer.from(JSON.stringify(body));
      const req=https.request({hostname:peer.host,port:peer.port,method:'POST',path:ROUTE+'/'+route,key:this.service.tls.key,cert:this.service.tls.cert,rejectUnauthorized:false,agent:false,signal,headers:{'Content-Type':'application/json','Content-Length':data.length,'Connection':'close'}},resolve);
      req.on('error',reject);req.setTimeout(timeout,()=>req.destroy(new Error('Phone did not respond in time.')));
      req.once('socket',socket=>socket.once('secureConnect',()=>{
        const cert=socket.getPeerCertificate();const actual=cert.raw?crypto.createHash('sha256').update(cert.raw).digest('hex').toUpperCase():'';
        if(!actual||actual!==fingerprint(peer.fingerprint)){req.destroy(new Error('Phone certificate changed. Connect the phone again.'));return;}
        req.end(data);
      }));
    });
  }
  async readResponse(response){const chunks=[];let count=0;for await(const chunk of response){count+=chunk.length;if(count>2*1024*1024){response.destroy();throw new Error('Phone response is too large.');}chunks.push(chunk);}const text=Buffer.concat(chunks).toString('utf8');return text?JSON.parse(text):null;}
  async json(peer,route,body,options){const response=await this.open(peer,route,body,options);const data=await this.readResponse(response);if(response.statusCode<200||response.statusCode>=300)throw fail(response.statusCode,data?.message||`Phone returned HTTP ${response.statusCode}`);return {status:response.statusCode,data};}
  async stop(){
    this.running=false;
    for(const entry of this.peers.values()){clearTimeout(entry.timer);entry.controller.abort();entry.connected=false;}
    for(const active of this.active.values())active.controller.abort();
    await Promise.allSettled([...this.tasks]);
    this.update();
  }
}
module.exports={ReverseReceiver};
