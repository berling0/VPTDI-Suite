const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { spawn } = require('child_process');const assert=require('assert');
(async()=>{
 const srv=spawn('/tmp/msa15-linux',[],{env:{...process.env,MSA15_NO_BROWSER:'1'}});
 const url=await new Promise(r=>srv.stdout.once('data',d=>r(String(d).trim())));
 const b=await chromium.launch(),p=await b.newPage({viewport:{width:1350,height:900}});
 const errs=[];p.on('console',m=>m.type()==='error'&&errs.push(m.text()));p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(url);await p.setInputFiles('#fOpen',require('path').join(process.argv[2],'0281001656_357830_merged.bin'));await p.waitForSelector('#list .it');
 await p.fill('#q','Drivers');await p.click('#list .it');
 const cell=p.locator('#tablewrap td[data-r="1"][data-c="2"]');const before=await cell.innerText();
 await cell.dblclick();await p.keyboard.type('2222');await p.keyboard.press('Enter');await p.waitForTimeout(150);
 assert.strictEqual(await p.locator('#tablewrap td[data-r="1"][data-c="2"]').innerText(),'2222');
 assert.ok((await p.innerText('#fname')).includes('edited (1)'));
 assert.deepStrictEqual(errs,[]);
 // bulk scale
 await p.locator('#tablewrap td[data-r="0"][data-c="0"]').click();await p.locator('#tablewrap td[data-r="1"][data-c="1"]').click({modifiers:['Shift']});
 await p.fill('#bulkv','10');await p.click('#medit button[data-k="pct"]');
 assert.ok((await p.innerText('#fname')).includes('edited (2)'));
 await p.click('#bUndo');await p.click('#bUndo');assert.strictEqual(await p.locator('#tablewrap td[data-r="1"][data-c="2"]').innerText(),before);
 // tools: iq limit
 await p.click('#views button[data-v="tools"]');await p.fill('#tIq','70');await p.click('button[data-t="iq"]');
 await p.click('#views button[data-v="consts"]');
 const txt=await p.innerText('#p-consts');assert.ok(/70 mg/.test(txt),txt.slice(0,400));
 await p.click('#views button[data-v="tools"]');await p.fill('#tRpm','5200');await p.click('button[data-t="cut"]');
 assert.ok((await p.innerText('#p-tools')).includes('5200 rpm'));
 
 // const cell edit
 await p.click('#views button[data-v="consts"]');await p.locator('td.ced[data-key="iqmax"][data-b="0"]').dblclick();await p.keyboard.press('Control+a');await p.keyboard.type('80');await p.keyboard.press('Enter');
 assert.ok((await p.locator('td.ced[data-key="iqmax"][data-b="0"]').innerText()).includes('80'));
 await p.click('#bRevert');assert.ok(!(await p.innerText('#fname')).includes('edited'));
 assert.deepStrictEqual(errs,[]);console.log('UI edit tests passed');await b.close();srv.kill();})().catch(e=>{console.error(e);process.exit(1)});
