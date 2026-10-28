'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {WindowsNetwork}=require('../src/windows-network');

function fixture(t,category='Private',receipt={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'localsend-network-test-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dataDir,'receiving-setup.json'),JSON.stringify(receipt));
  const calls=[],status={privateAllowed:false,publicAllowed:false,anyOwned:false,networks:[{name:'Wi-Fi',category}],blocks:[],policyBlocked:[]};
  let failure,ignoreApply=false;
  const runner=async(script,args)=>{
    calls.push(args);const action=args[args.indexOf('-Action')+1];
    if(action==='Status')return {ok:true,status:JSON.parse(JSON.stringify(status))};
    if(failure)throw failure;
    if(action==='Apply'&&!ignoreApply){status.privateAllowed=true;status.publicAllowed=args.includes('Private,Public');status.anyOwned=true;}
    if(action==='Remove'){status.privateAllowed=false;status.publicAllowed=false;status.anyOwned=false;}
    return {ok:true};
  };
  const network=new WindowsNetwork({program:'C:\\Apps\\LocalSend Rebuilt.exe',script:'controlled-script.ps1',dataDir,port:59807,platform:'win32',run:runner});
  return {network,status,calls,dataDir,fail:error=>{failure=error;},ignore:()=>{ignoreApply=true;}};
}
test('startup and focus status checks never request firewall changes',async t=>{
  const f=fixture(t);await f.network.refresh();await f.network.refresh();
  assert.equal(f.network.state.phase,'needs-setup');assert.equal(f.network.state.firstRun,true);
  assert.ok(f.calls.every(args=>args[1]==='Status'));
});
test('Private consent configures exact current program/port without Public access',async t=>{
  const f=fixture(t);await f.network.configure({allowPublic:false});
  assert.equal(f.network.state.phase,'ready');assert.equal(f.network.state.publicAllowed,false);
  const args=f.calls.find(args=>args[1]==='Apply');assert.equal(args[args.indexOf('-Profiles')+1],'Private');
  assert.equal(args[args.indexOf('-Program')+1],f.network.program);assert.equal(args[args.indexOf('-Port')+1],'59807');
  assert.equal(JSON.parse(fs.readFileSync(f.network.receiptFile)).configured,true);
});
test('Public Wi-Fi stays limited until the separate Public choice is enabled',async t=>{
  const f=fixture(t,'Public');await f.network.configure({allowPublic:false});assert.equal(f.network.state.phase,'limited');
  await f.network.configure({allowPublic:true});assert.equal(f.network.state.phase,'ready');assert.equal(f.network.state.publicAllowed,true);
  await f.network.configure({allowPublic:false});assert.equal(f.network.state.phase,'limited');
});
test('cancelled Windows approval keeps existing access and shows a retryable error',async t=>{
  const f=fixture(t);f.fail(Object.assign(new Error('Approval cancelled'),{code:'cancelled'}));
  const result=await f.network.configure({allowPublic:false});assert.equal(result.phase,'needs-setup');assert.equal(result.privateAllowed,false);assert.equal(result.operationCode,'cancelled');
  assert.notEqual(JSON.parse(fs.readFileSync(f.network.receiptFile)).configured,true);
});
test('renderer cannot select another program, arbitrary profile or script',async t=>{
  const f=fixture(t);
  for(const input of [null,{}, {allowPublic:'false'},{allowPublic:false,program:'C:\\Other.exe'},{allowPublic:false,profiles:'Any'}])await assert.rejects(()=>f.network.configure(input));
  assert.equal(f.calls.length,0);
});
test('changed location and receiving port are detected from fresh OS state',async t=>{
  const f=fixture(t,'Private',{seen:true,configured:true,program:'C:\\Old\\LocalSend Rebuilt.exe',port:53317});
  await f.network.refresh();assert.equal(f.network.state.phase,'repair');assert.match(f.network.state.message,/moved/);
  f.network.receipt.program=f.network.program;await f.network.refresh();assert.match(f.network.state.message,/port changed/);
});
test('moving a configured app requests cleanup only for the recorded previous app path',async t=>{
  const f=fixture(t,'Private',{seen:true,configured:true,program:'C:\\Old\\LocalSend Rebuilt.exe',port:53317});
  await f.network.configure({allowPublic:false});const args=f.calls.find(args=>args[1]==='Apply');
  assert.equal(args[args.indexOf('-PreviousProgram')+1],'C:\\Old\\LocalSend Rebuilt.exe');assert.equal(f.network.receipt.program,f.network.program);
});
test('local block rules and enterprise inbound policy prevent a ready claim',async t=>{
  const f=fixture(t);f.status.blocks=['Blocked app'];await f.network.configure({allowPublic:false});assert.equal(f.network.state.phase,'blocked');assert.ok(f.network.state.operationError);
  f.status.blocks=[];f.status.policyBlocked=['Private'];await f.network.refresh();assert.equal(f.network.state.phase,'blocked');
});
test('OS success response is insufficient unless the rules can be verified',async t=>{
  const f=fixture(t);f.ignore();await f.network.configure({allowPublic:false});assert.notEqual(f.network.state.phase,'ready');assert.match(f.network.state.operationError,/could not confirm/);
});
test('access removal is explicit and clears the configured receipt',async t=>{
  const f=fixture(t);await f.network.configure({allowPublic:true});await f.network.remove();
  assert.equal(f.network.state.anyOwned,false);assert.equal(f.network.state.firstRun,false);assert.equal(f.network.receipt.configured,false);
  assert.equal(f.calls.filter(args=>args[1]==='Remove').length,1);
});
test('Later persists without elevation and source mode never runs PowerShell',async t=>{
  const f=fixture(t);f.network.dismiss();assert.equal(f.network.state.firstRun,false);assert.equal(f.calls.length,0);
  const source=new WindowsNetwork({program:'electron.exe',script:'unused',dataDir:f.dataDir,port:53317,platform:'win32',packaged:false,run:()=>{throw new Error('must not run');}});
  await source.refresh();await assert.rejects(()=>source.configure({allowPublic:false}));assert.equal(source.state.phase,'unsupported');
});
