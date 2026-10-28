'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
async function run(window,service,output){
  await fs.mkdir(output,{recursive:true});
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const pause=()=>new Promise(resolve=>setTimeout(resolve,160));
  const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await pause();};
  const capture=async name=>{await pause();await fs.writeFile(path.join(output,name+'.png'),(await window.webContents.capturePage({stayHidden:true})).toPNG());};
  const checks=[];
  assert.equal(window.getTitle(),'Super Send');assert.equal(await evaluate('document.title'),'Super Send');
  assert.equal(await evaluate(`document.querySelector('.brand-mark img').alt`),'Super Send');
  assert.equal(await evaluate(`['enableReceiving','checkReceiving','openFirewall','removeReceiving'].some(key=>typeof window.localSend[key]==='function')`),false);
  assert.equal(await evaluate(`!!document.querySelector('[role="dialog"]')`),false);
  checks.push('New name/logo are present and first launch has no firewall setup dialog or exposed firewall actions');
  const removed=`(()=>{const text=document.body.innerText;return ['Configure receiving','Check status','Open Windows Firewall'].some(label=>text.includes(label));})()`;
  const layouts=[];
  for(const theme of ['light','dark']){
    service.updateSettings({theme});await pause();
    for(const [mode,ready] of [['connect',false],['connected',true]]){
      service.network.reverseReady=ready;service.network.reversePeers=ready?[{id:'ui-phone',alias:'My Android phone'}]:[];service.changed(true);await pause();
      for(const page of ['receive','settings']){
        await click(`[data-action="navigate"][data-page="${page}"]`);assert.equal(await evaluate(removed),false);
        assert.equal(await evaluate(`!!document.querySelector('#connection-card')`),true);
        assert.match(await evaluate(`document.querySelector('#connection-card').innerText`),ready?/Phone connected/:/Connect once/);
        for(const [size,width,height,zoom] of [['regular',1160,790,1],['compact',820,610,1],['zoomed',1000,760,1.5]]){
          window.setSize(width,height);window.webContents.setZoomFactor(zoom);await pause();
          const layout=await evaluate(`(()=>{const c=document.querySelector('#connection-card'),r=c.getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,scrollWidth:c.scrollWidth,clientWidth:c.clientWidth};})()`);
          assert.ok(layout.scroll<=layout.width+1&&layout.left>=0&&layout.right<=layout.width+1&&layout.scrollWidth<=layout.clientWidth+1,JSON.stringify(layout));
          layouts.push([theme,mode,page,size].join('/'));
          if(page==='receive'&&size!=='zoomed')await capture(`${theme}-${mode}-${size}`);
        }
      }
    }
  }
  checks.push('Removed controls stay absent across receive/settings, connected/unconnected, both themes and three window sizes');
  window.webContents.setZoomFactor(1);window.setSize(1160,790);await click('[data-action="connect-phone"]');
  assert.equal(await evaluate(`document.querySelector('#manual-port').value`),'53317');assert.equal(await evaluate(`document.querySelector('#manual-protocol').value`),'https');
  await click('[data-action="close-modal"]');checks.push('Connect Android phone opens the usable HTTPS pairing form');
  // These are deliberately simulated byte counters for rendering checks. They
  // do not transfer a file and must never be reported as a throughput benchmark.
  const speedChecks=[];
  const savedTransfers=service.transfers,savedHistory=service.history,savedTheme=service.settings.theme;
  try{
    for(const theme of ['light','dark']){
      service.updateSettings({theme});await pause();
      for(const [size,width,height]of [['regular',1160,790],['compact',820,610]]){
        window.setSize(width,height);window.webContents.setZoomFactor(1);
        const id=`simulated-speed-${theme}-${size}`;
        const fixture={id,direction:'receive',peer:'Simulated speed display',status:'waiting',total:50000000,transferred:0,progress:0,createdAt:Date.now(),files:[{id:'simulated-file',name:'UI fixture - no file transferred.bin',size:50000000,transferred:0,status:'waiting'}]};
        service.transfers=[fixture,...savedTransfers];service.history=savedHistory;service.changed(true);
        await click('[data-action="navigate"][data-page="history"]');
        const card=`#transfer-${id}`;
        assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card)}).querySelector('[data-transfer-rate]')===null`),true,'Waiting for approval must not display a speed');
        assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card)}).querySelector('.progress-caption').innerText.includes('MB/s')`),false);
        fixture.status='transferring';fixture.files[0].status='transferring';service.changed(true);await pause();
        await evaluate(`(()=>{const card=document.querySelector(${JSON.stringify(card)});card.scrollIntoView({block:'center'});window.__speedCancel=card.querySelector('[data-action="cancel-transfer"]');window.__speedCancel.focus();})()`);
        await new Promise(resolve=>setTimeout(resolve,1000));
        fixture.transferred=25000000;fixture.files[0].transferred=25000000;fixture.progress=0.5;service.changed(true);await pause();
        const liveLabel=await evaluate(`document.querySelector(${JSON.stringify(card)}).querySelector('[data-transfer-rate]').innerText`);
        assert.match(liveLabel,/\d+(?:[.,]\d+)? MB\/s/,'Measured progress should render an MB/s value');
        assert.ok(Number.parseFloat(liveLabel.replace(',','.'))>0,'Simulated increasing bytes should produce a positive observed rate');
        assert.equal(await evaluate(`document.activeElement===window.__speedCancel&&window.__speedCancel===document.querySelector(${JSON.stringify(card)}).querySelector('[data-action="cancel-transfer"]')`),true,'Progress must preserve the focused cancel button');
        const checkLayout=async phase=>{
          const layout=await evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(card)}),r=c.getBoundingClientRect(),p=document.querySelector('#page');return {width:innerWidth,body:document.documentElement.scrollWidth,left:r.left,right:r.right,card:c.scrollWidth,cardClient:c.clientWidth,page:p.scrollWidth,pageClient:p.clientWidth};})()`);
          assert.ok(layout.body<=layout.width+1&&layout.left>=0&&layout.right<=layout.width+1&&layout.card<=layout.cardClient+1&&layout.page<=layout.pageClient+1,`${theme}/${size}/${phase}: ${JSON.stringify(layout)}`);
        };
        await checkLayout('live');await capture(`${id}-live`);
        fixture.status='completed';fixture.transferred=50000000;fixture.progress=1;fixture.files[0].transferred=50000000;fixture.files[0].status='completed';service.changed(true);await pause();
        const averageLabel=await evaluate(`document.querySelector(${JSON.stringify(card)}).querySelector('.transfer-subtitle').innerText`);
        assert.match(averageLabel,/\d+(?:[.,]\d+)? MB\/s avg/,'A transfer witnessed by this window should retain its observed average');
        assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card)}).querySelector('[data-transfer-rate]')===null`),true,'Completed transfers must stop live rate updates');
        await checkLayout('completed');await capture(`${id}-completed`);
        speedChecks.push({theme,size,liveLabel,averageLabel,passed:true,evidence:'Simulated byte progress over a real one-second wait; rendering validation only, not measured file throughput'});
      }
    }
    checks.push('Observed MB/s and final averages render in both themes and two sizes; approval has no speed, progress preserves focus, cards do not overflow');
  }finally{
    service.transfers=savedTransfers;service.history=savedHistory;service.updateSettings({theme:savedTheme});service.changed(true);
    window.webContents.setZoomFactor(1);window.setSize(1160,790);await click('[data-action="navigate"][data-page="receive"]');
    await evaluate('delete window.__speedCancel');
  }
  service.network.reverseReady=false;service.network.reversePeers=[];service.changed(true);
  await require('./ui-smoke').run(window,service,path.join(output,'workflow'));checks.push('Complete real send, receive, approval and history workflow passes in the branded UI');
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks,layouts,speedChecks,scope:'Real packaged UI; connection-status and simulated speed-display fixtures, no Windows firewall calls; full real loopback workflow. Simulated speed labels are not throughput benchmark results.'},null,2));
  console.log(`Super Send UI passed: ${checks.length} scenarios, ${layouts.length} theme/connection/page/size cases and ${speedChecks.length} simulated speed-display cases.`);
}
module.exports={run};
