const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const MSA = require('../web/core.js');
const dumps = process.argv[2], shots = process.argv[3];
const P = f => path.join(dumps, f);
const ORIG = '831-832_2473.Original', TUNED = '831-832_E995.Stage2';
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-'));
  const srv = spawn('/tmp/msa15-linux', [], { env: { ...process.env, MSA15_NO_BROWSER: '1' } });
  let exited = false; srv.on('exit', () => (exited = true));
  const url = await new Promise(r => srv.stdout.once('data', d => r(String(d).trim())));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url + '?dl=1');
  await page.screenshot({ path: path.join(shots, '0-empty.png') });

  // 1. combined file
  await page.setInputFiles('#fOpen', P(TUNED));
  await page.waitForSelector('#list .it');
  const ecu = await page.textContent('#ecu');
  assert.ok(ecu.includes('028906021GK') && ecu.includes('0281001654') && ecu.includes('SG 1445 / AG 1445') && ecu.includes('E995') && ecu.includes('234'), ecu);
  assert.strictEqual(await page.locator('#list .it.id').count(), 37);
  assert.strictEqual(await page.locator('#list .it').count(), 117);
  await page.click('#list .it:has-text("Drivers wish")');
  assert.ok((await page.textContent('#mhead h2')).includes('Drivers wish'));
  assert.ok((await page.textContent('#mhead .sub')).includes('data 0x019CC') && (await page.textContent('#list .it.sel')).includes('019CC') && (await page.textContent('#list .it.sel')).includes('8x16'));
  assert.strictEqual(await page.locator('table.map tbody tr').count(), 16);
  await page.screenshot({ path: path.join(shots, '1-map.png') });
  await page.click('#segUnit button[data-p="1"]');
  assert.strictEqual((await page.textContent('table.map tbody tr:first-child th')).trim(), '0');
  assert.strictEqual((await page.textContent('table.map thead th:last-child')).trim(), '100');

  // 2. compare with the original
  await page.setInputFiles('#fCmp', P(ORIG));
  await page.waitForSelector('#p-changes table.plain tr.click');
  const o = new Uint8Array(fs.readFileSync(P(ORIG))), t = new Uint8Array(fs.readFileSync(P(TUNED)));
  let diff = 0; for (let i = 0; i < o.length; i++) if (o[i] !== t[i]) diff++;
  assert.ok((await page.textContent('#p-changes h4')).startsWith(diff + ' bytes differ'));
  await page.screenshot({ path: path.join(shots, '2-changes.png') });
  await page.click('#p-changes tr.click:has-text("Torque limiter")');
  assert.ok((await page.textContent('#mhead h2')).includes('Torque limiter'));
  await page.screenshot({ path: path.join(shots, '3-diff.png') });
  await page.click('#onlyChg');
  const nChanged = await page.locator('#list .it').count();
  assert.ok(nChanged > 5 && nChanged < 40, 'changed filter ' + nChanged);
  await page.click('#views button[data-v="chips"]');
  await page.screenshot({ path: path.join(shots, '4-chips.png') });

  // 3. split to LLL + HHH and check the bytes that land on disk
  const got = []; page.on('download', d => got.push(d));
  await page.click('#bSaveChips');
  for (let i = 0; i < 50 && got.length < 2; i++) await page.waitForTimeout(100);
  assert.strictEqual(got.length, 2);
  const saved = {};
  for (const d of got) { const p = path.join(tmp, d.suggestedFilename()); await d.saveAs(p); saved[d.suggestedFilename()] = new Uint8Array(fs.readFileSync(p)); }
  const names = Object.keys(saved).sort(); assert.deepStrictEqual(names, ['831-832_E995_HHH.bin', '831-832_E995_LLL.bin']);
  const sp = MSA.split(t);
  assert.ok(MSA.equal(saved[names[1]], sp.L) && MSA.equal(saved[names[0]], sp.H), 'chip bytes');
  assert.ok((await page.textContent('#banner')).includes('Verified'));

  // 4. open the two chip files in the WRONG order -> merged image must equal the tuned bin
  got.length = 0;
  await page.setInputFiles('#fOpen', [path.join(tmp, names[0]), path.join(tmp, names[1])]);
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('Merged'));
  const b = await page.textContent('#banner'); assert.ok(/Merged 831-832_E995_LLL\.bin \(LLL.*chip tags/.test(b), b);
  await page.click('#bSaveBin');
  for (let i = 0; i < 50 && got.length < 1; i++) await page.waitForTimeout(100);
  const mp = path.join(tmp, 'merged.bin'); await got[0].saveAs(mp);
  assert.strictEqual(got[0].suggestedFilename(), '831-832_E995_merged.bin');
  assert.ok(MSA.equal(new Uint8Array(fs.readFileSync(mp)), t), 'merged image equals source');

  // 5. one chip at a time
  await page.setInputFiles('#fOpen', path.join(tmp, names[0]));
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('single chip dump'));
  assert.ok((await page.textContent('#banner')).includes('tagged H'));
  await page.setInputFiles('#fOpen', path.join(tmp, names[1]));
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('Merged'));
  assert.ok((await page.textContent('#ecu')).includes('E995'));
  // same chip twice, and a non-ECU file
  await page.setInputFiles('#fOpen', [path.join(tmp, names[0]), path.join(tmp, names[0])]);
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('same chip twice'));
  fs.writeFileSync(path.join(tmp, 'junk.bin'), Buffer.alloc(5000, 7));
  await page.setInputFiles('#fOpen', path.join(tmp, 'junk.bin'));
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('No map data block'));
  // csv
  await page.setInputFiles('#fOpen', P(ORIG)); await page.waitForSelector('#list .it'); got.length = 0;
  await page.click('#bCsv'); for (let i = 0; i < 50 && got.length < 1; i++) await page.waitForTimeout(100);
  const cp = path.join(tmp, 'm.csv'); await got[0].saveAs(cp);
  assert.ok(fs.readFileSync(cp, 'utf8').includes('CB2 · Manual (SG);0x019CC;Drivers wish;8;16;C1D0;E08A;0x01994'), fs.readFileSync(cp, 'utf8').slice(0, 600));
  // automatic gearbox block + keyboard
  await page.click('#blocks button[data-b="1"]'); await page.click('#views button[data-v="map"]');
  assert.ok((await page.textContent('#mhead h2')).includes('Starting torque characteristic') && (await page.textContent('#mhead .sub')).includes('data 0x394DC'));
  await page.keyboard.press('ArrowDown'); assert.ok((await page.textContent('#mhead h2')).includes('MAF correction by temp'));
  // reference bin with three code blocks: tabs scroll sideways, map pack file names the maps
  await page.setInputFiles('#fOpen', path.join(process.argv[4], '0281001656_357830_merged.bin')); await page.waitForSelector('#list .it');
  assert.deepStrictEqual(await page.locator('#blocks button').allTextContents(), ['CB2 · Manual (SG)', 'CB3 · Manual (SG)', 'CB1 · Automatic (AG)']);
  const sc = await page.evaluate(() => { const b = document.getElementById('blocks'); const lastBtn = b.lastElementChild; return { sw: b.scrollWidth, cw: b.clientWidth, wrap: lastBtn.offsetHeight < 45 && lastBtn.offsetWidth >= lastBtn.scrollWidth }; });
  assert.ok(sc.sw > sc.cw && sc.wrap, JSON.stringify(sc));
  await page.screenshot({ path: path.join(shots, '5-three-blocks.png') });
  await page.click('#blocks button[data-b="2"]');
  const vis = await page.evaluate(() => { const b = document.getElementById('blocks'), r = b.lastElementChild.getBoundingClientRect(), c = b.getBoundingClientRect(); return r.right <= c.right + 1 && r.left >= c.left - 1; });
  assert.ok(vis, 'selected tab scrolled into view');
  assert.strictEqual(await page.locator('#list .it.id').count(), 37);
  await page.click('#list .it:has-text("EGR")'); assert.ok((await page.textContent('#mhead .sub')).includes('data 0x39D6E') && (await page.textContent('#mhead .sub')).includes('13x16'));
  await page.setInputFiles('#fPack', path.join(process.argv[4], 'mappack.txt'));
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('49 maps named from 50 lines'));
  assert.ok(!(await page.textContent('#banner')).includes('No map found') && !(await page.textContent('#banner')).includes('Size differs'));
  assert.ok((await page.textContent('#list')).includes('N146 Pump Voltage Map CB1'));
  await page.screenshot({ path: path.join(shots, '6-mappack.png') });

  // 038906018P: forum map list, constants tab, engine coding, edited-constant compare
  const pbin = path.join(process.argv[4], '..', 'ref2', 'dump_ori.bin');
  await page.setInputFiles('#fOpen', pbin); await page.waitForSelector('#list .it');
  assert.ok((await page.textContent('#ecu')).includes('038906018P') && (await page.textContent('#ecu')).includes('CB2=2  CB3=3  CB1=1'));
  assert.strictEqual(await page.locator('#list .it.id').count(), 38);
  assert.ok((await page.getAttribute('#blocks button[data-b="1"]', 'title')).includes('engine coding ends in 3'));
  await page.click('#list .it:has-text("Desired boost correction (LDR)")');
  assert.ok((await page.textContent('#mhead .sub')).includes('data 0x0575E') && (await page.textContent('#mhead .sub')).includes('9x9'));
  await page.click('#views button[data-v="consts"]');
  const ct = await page.textContent('#p-consts');
  assert.ok(ct.includes('Max IQ limit') && ct.includes('5100 (51.00 mg)') && ct.includes('1990 mbar') && ct.includes('Engine coding digit') && ct.includes('862 rpm') && ct.includes('820 rpm'));
  await page.screenshot({ path: path.join(shots, '7-constants.png') });
  const edited = new Uint8Array(fs.readFileSync(pbin)); edited[0x2D95] = 80; edited[0x38000 + 0x1242] = 0xB0; edited[0x38000 + 0x1243] = 0x1D; // CB2 max IQ 80, CB1 PBM 7600
  const ep = path.join(tmp, 'edited.bin'); fs.writeFileSync(ep, edited);
  await page.setInputFiles('#fOpen', ep); await page.waitForSelector('#list .it');
  await page.setInputFiles('#fCmp', pbin); await page.waitForSelector('#p-changes table.plain tr');
  const ch = await page.textContent('#p-changes'); assert.ok(ch.includes('Constant: Max IQ limit (CB2') && ch.includes('Constant: PBM data set intervention quantity (CB1'), ch.slice(0, 700));
  await page.click('#views button[data-v="consts"]');
  const ct2 = await page.textContent('#p-consts'); assert.ok(ct2.includes('80 mg') && ct2.includes('was 51 mg') && ct2.includes('7600 (76.00 mg)') && ct2.includes('was 5100 (51.00 mg)'), ct2.slice(0, 900));
  await page.screenshot({ path: path.join(shots, '8-constants-edited.png') });
  // other software: constants table for GL and a note for unknown software
  await page.setInputFiles('#fOpen', path.join(process.argv[4], '0281001656_357830_merged.bin')); await page.waitForSelector('#list .it');
  await page.click('#views button[data-v="consts"]'); assert.ok((await page.textContent('#p-consts')).includes('028906021GK / GL') && (await page.textContent('#p-consts')).includes('Single-value boost limiter'));
  assert.deepStrictEqual(errors, []);
  // 6. closing the window stops the launcher
  await page.close(); await browser.close();
  for (let i = 0; i < 80 && !exited; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(exited, 'launcher exits after the window closes');
  console.log('ui tests passed');
})().catch(e => { console.error(e); process.exit(1); });
