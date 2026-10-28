'use strict';
const {EventEmitter}=require('node:events');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');

function runPowerShell(script,args,{timeout=30000}={}) {
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise((resolve,reject)=>execFile(executable,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,...args],{windowsHide:true,timeout,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout)=>{
    try { const value=JSON.parse(stdout.trim().replace(/^\uFEFF/,'')); if(!value.ok)throw Object.assign(new Error(value.message||'Windows receiving setup failed.'),{code:value.code}); resolve(value); }
    catch(parseError){reject(parseError.code?parseError:Object.assign(new Error(error?.killed?'Windows setup timed out. Check the administrator prompt.':'Windows receiving status is unavailable. Your administrator may restrict firewall access.'),{cause:parseError}));}
  }));
}
class WindowsNetwork extends EventEmitter {
  constructor({program,script,dataDir,port,platform=process.platform,packaged=true,run=runPowerShell}) {
    super();Object.assign(this,{program,script,dataDir,port,run});
    this.supported=platform==='win32'&&packaged;
    this.receiptFile=path.join(dataDir,'receiving-setup.json');
    try{this.receipt=JSON.parse(fs.readFileSync(this.receiptFile,'utf8'));}catch{this.receipt={};}
    this.state={supported:this.supported,phase:this.supported?'checking':'unsupported',port,firstRun:!this.receipt.seen,privateAllowed:false,publicAllowed:false,networks:[],blocks:[],policyBlocked:[],temporary:program.toLowerCase().startsWith(os.tmpdir().toLowerCase()+path.sep),message:''};
  }
  snapshot(){return JSON.parse(JSON.stringify(this.state));}
  publish(value){Object.assign(this.state,value);this.emit('state',this.snapshot());return this.snapshot();}
  save(value){this.receipt={...this.receipt,...value};fs.mkdirSync(this.dataDir,{recursive:true});fs.writeFileSync(this.receiptFile,JSON.stringify(this.receipt,null,2));}
  args(action,extra=[]){return ['-Action',action,'-Program',this.program,'-Port',String(this.port),...extra];}
  async refresh(){
    if(!this.supported)return this.snapshot();
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      try{
        const {status}=await this.run(this.script,this.args('Status'));
        const current=(status.networks||[]).map(n=>n.category);
        const policyBlocked=current.filter(category=>(status.policyBlocked||[]).includes(category==='DomainAuthenticated'?'Domain':category));
        const blocked=(status.blocks||[]).length>0||policyBlocked.length>0;
        const ready=current.length>0&&current.every(category=>category==='Private'?status.privateAllowed:category==='Public'?status.publicAllowed:false);
        const moved=this.receipt.program&&this.receipt.program.toLowerCase()!==this.program.toLowerCase();
        const changedPort=this.receipt.port&&this.receipt.port!==this.port;
        let phase=blocked?'blocked':ready?'ready':status.privateAllowed?'limited':this.receipt.configured||status.anyOwned?'repair':'needs-setup';
        let message=policyBlocked.length?`Windows blocks inbound rules on your ${policyBlocked.join(' / ')} network. Open Windows Firewall or contact your administrator.`:blocked?'Windows has a block rule for this app. Open Windows Firewall or contact your administrator.':ready?'Windows rules allow nearby devices on your current network.':phase==='limited'?'Private-network access is enabled. Your current network needs additional permission.':moved?'The app moved. Enable receiving for its new location.':changedPort?'The receiving port changed. Repair access for the current port.':'Enable receiving so nearby devices can connect to this PC.';
        return this.publish({...status,phase,message,firstRun:!this.receipt.seen});
      }catch(error){return this.publish({phase:'error',message:error.message});}
      finally{this.refreshing=null;}
    })();return this.refreshing;
  }
  dismiss(){this.save({seen:true});return this.publish({firstRun:false});}
  async configure(options){
    if(!options||Object.keys(options).some(key=>key!=='allowPublic')||typeof options.allowPublic!=='boolean')throw new Error('Choose whether receiving is allowed on Public networks.');
    return this.mutate('Apply',options.allowPublic);
  }
  async remove(){return this.mutate('Remove',false);}
  async mutate(action,allowPublic){
    if(!this.supported)throw new Error('Open the packaged Windows app to configure receiving.');
    if(this.busy)throw new Error('Windows receiving setup is already running.');
    this.busy=true;if(this.refreshing)await this.refreshing;this.publish({phase:'working',operationError:'',operationCode:'',message:'Waiting for Windows administrator approval…'});
    const resultFile=path.join(this.dataDir,`network-result-${crypto.randomUUID()}.json`);
    try{
      const previous=action==='Apply'&&this.receipt.configured&&this.receipt.program&&this.receipt.program.toLowerCase()!==this.program.toLowerCase()?['-PreviousProgram',this.receipt.program]:[];
      await this.run(this.script,this.args(action,['-Profiles',allowPublic?'Private,Public':'Private','-ResultPath',resultFile,...previous]),{timeout:180000});
      this.save(action==='Apply'?{seen:true,configured:true,program:this.program,port:this.port,allowPublic}:{seen:true,configured:false,allowPublic:false});
      await this.refresh();
      if(action==='Apply'&&(!this.state.privateAllowed||(allowPublic&&!this.state.publicAllowed)||this.state.phase==='blocked'||this.state.phase==='error'))throw new Error('Windows could not confirm receiving access. Check the status below or contact your administrator.');
      if(action==='Remove'&&this.state.anyOwned)throw new Error('Windows still reports receiving rules for this app. Check administrator policy and retry.');
      if(action==='Remove')this.publish({phase:'needs-setup',firstRun:false,message:'The app’s receiving rules were removed.'});
      return this.snapshot();
    }catch(error){await this.refresh();return this.publish({operationError:error.message,operationCode:error.code||'failed'});}
    finally{this.busy=false;try{fs.unlinkSync(resultFile);}catch{}}
  }
}
module.exports={WindowsNetwork,runPowerShell};
