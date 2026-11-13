const fs = require('fs'), path = require('path'), assert = require('assert');
const MSA = require('../web/core.js');
const dir = process.argv[2];
const files = fs.readdirSync(dir).sort();
const load = f => new Uint8Array(fs.readFileSync(path.join(dir, f)));
const PACK = ['MAF correction by temp', 'Drivers wish', 'EGR', 'Start IQ', 'Torque limiter', 'Smoke limiter', 'N146 Pump voltage map', 'Boost target map (1)', 'Boost target map (2)', 'Boost limit', 'N75 duty (1)', 'N75 duty (2)', 'Air Mass conversion Raw value', 'Map linearization', 'SOI limiter temp', 'Start of injection', 'IQ to Airmass'];
let checks = 0; const ok = (c, msg) => { assert.ok(c, msg); checks++; };
for (const f of files) {
  const bin = load(f), info = MSA.analyze(bin);
  // split -> merge round trip is byte exact
  const { L, H } = MSA.split(bin);
  ok(L.length === 131072 && H.length === 131072, 'chip size');
  ok(MSA.equal(MSA.merge(L, H), bin), 'round trip ' + f);
  ok(MSA.chipMarker(L) === 'L' && MSA.chipMarker(H) === 'H', 'chip tags ' + f);
  // auto order: right both ways round, with and without the chip tags, with useless names
  for (const [a, b] of [[L, H], [H, L]]) { const r = MSA.autoMerge(a, b, 'a.bin', 'b.bin'); ok(r.sure && MSA.equal(r.bin, bin), 'autoMerge ' + f); }
  const L2 = L.slice(), H2 = H.slice(); L2[0x8019] = 0; H2[0x8019] = 0;   // wipe the tags -> must fall back to map structure
  ok(MSA.chipMarker(L2) === null, 'tag wiped');
  const ref = MSA.merge(L2, H2);
  for (const [a, b] of [[L2, H2], [H2, L2]]) { const r = MSA.autoMerge(a, b, 'x', 'y'); ok(r.sure && /map structure/.test(r.reason) && MSA.equal(r.bin, ref), 'autoMerge by structure ' + f); }
  // file name suffix is the 16-bit byte sum
  const suffix = f.match(/_([0-9A-F]{4})\./)[1];
  ok(info.sums.file === suffix, 'byte sum ' + f + ' ' + info.sums.file);
  ok(info.blocks.length === 2 && info.blocks[0].start === 0 && info.blocks[1].start === 0x38000, 'blocks ' + f);
  ok(info.blocks[0].ident.gear === 'SG' && info.blocks[1].ident.gear === 'AG', 'gearbox ident');
  ok(info.ident.part === '028906021GK' && info.ident.bosch === '0281001654', 'ident');
  ok(info.warnings.length === 0, 'no warnings ' + info.warnings);
  for (const blk of info.blocks) {
    ok(blk.maps.length === 117, 'map count ' + blk.maps.length);
    const names = blk.maps.filter(m => m.identified).map(m => m.name);
    for (const want of PACK)
      ok(names.filter(n => n === want).length === 1, f + ' ' + blk.label + ' missing/duplicate ' + want + ' in ' + names.join(' | '));
    ok(names.length === 37 && new Set(names).size === 37, 'identified maps: ' + names.length + ' ' + names.join(' | '));
    let prev = 0; for (const m of blk.maps) { ok(m.addr >= prev && m.end <= blk.end, 'maps do not overlap'); prev = m.end; }
  }
  const sw = info.ident.sw; ok(sw === (f.includes('1414') ? '1414' : '1445'), 'sw ' + sw);
  ok(MSA.looksLikeSingleChip(bin) === null && MSA.looksLikeSingleChip(L) === 'L' && MSA.looksLikeSingleChip(H) === 'H', 'single chip detection');
  // swapped merge is detected
  ok(MSA.analyze(MSA.merge(H, L)).warnings.length > 0, 'swapped merge warns');
}
// known cells, checked by hand against the hex dump
const o = load('831-832_2473.Original'), io = MSA.analyze(o);
const dw = io.blocks[0].maps.find(m => m.name === 'Drivers wish');
ok(dw.addr === 0x1994 && dw.dataAddr === 0x19CC && MSA.dims(dw) === '8x16', 'driver wish location');
const v = MSA.values(o, dw); ok(v[0][0] === 1720 && v[0][7] === 5100 && v[15][7] === 2820 && dw.ax2[7] === 10000 && dw.ax1[15] === 5355, 'driver wish cells');
const tl = io.blocks[0].maps.find(m => m.name === 'Torque limiter'); ok(tl.addr === 0x3EDC && MSA.values(o, tl)[0][7] === 3560, 'torque limiter');
const soi = io.blocks[0].maps.find(m => m.name.startsWith('Start of injection')); ok(soi.signed && MSA.values(o, soi)[4][0] === -276, 'signed SOI');
// compare original vs tuned
const t = load('831-832_E995.Stage2'), it = MSA.analyze(t), c = MSA.compare(t, o, it);
let diff = 0; for (let i = 0; i < o.length; i++) if (o[i] !== t[i]) diff++;
ok(c.changedBytes === diff, 'changed bytes');
const cn = c.changedMaps.filter(m => m.block === 0).map(m => m.name);
for (const want of ['Drivers wish', 'Torque limiter', 'Smoke limiter', 'Boost target map (1)', 'Boost limit', 'EGR']) ok(cn.includes(want), 'changed: ' + want);
ok(c.outside.some(r => /checksum/.test(r.note) && r.start === 0x7FFC) && c.outside.some(r => r.start === 0x3D42), 'outside regions');
let inMaps = 0; for (const m of c.changedMaps) for (let i = m.addr; i < m.end; i++) if (o[i] !== t[i]) inMaps++;
let outB = 0; for (const r of c.outside) for (let i = r.start; i < r.end; i++) if (o[i] !== t[i]) outB++;
ok(inMaps + outB === diff, 'every changed byte is accounted for');
ok(MSA.compare(o, o, io).changedBytes === 0, 'identical');
ok(MSA.mapListCsv(io).split('\r\n').length === 236, 'csv rows');
try { MSA.merge(new Uint8Array(4), new Uint8Array(6)); ok(false); } catch (e) { ok(/different sizes/.test(e.message), 'size mismatch'); }
// ---- reference bin 0281001656 / 028906021GL with the user's map pack: three code blocks ----
const refDir = process.argv[3];
const rb = new Uint8Array(fs.readFileSync(path.join(refDir, '0281001656_357830_merged.bin'))), ri = MSA.analyze(rb);
ok(ri.warnings.length === 0 && ri.blocks.length === 3, 'ref blocks');
ok(ri.blocks.map(b => b.label).join('|') === 'CB2 · Manual (SG)|CB3 · Manual (SG)|CB1 · Automatic (AG)', ri.blocks.map(b => b.label).join('|'));
ok(ri.ident.part === '028906021GL' && ri.ident.bosch === '0281001656' && ri.ident.sw === '1446', 'ref ident');
const entries = MSA.parseMapPack(fs.readFileSync(path.join(refDir, 'mappack.txt'), 'utf8'));
ok(entries.length === 50, 'map pack lines ' + entries.length);
const norm = s => s.toLowerCase().replace(/cb ?\d/, '').replace(/\(\d\)/, '').replace(/[^a-z0-9]/g, '');
const alias = { soilimiter: 'soilimitertemp' };
for (const e of entries) {
  let m = null; for (const b of ri.blocks) m = m || b.maps.find(x => x.dataAddr === e.addr);
  ok(m && m.identified, 'map pack entry found by the built-in finder: ' + e.name);
  ok(MSA.dims(m) === e.cols + 'x' + e.rows, 'size ' + e.name + ' ' + MSA.dims(m));
  const a = norm(m.name), b = norm(e.name); ok(a === b || alias[b] === a, 'name ' + m.name + ' vs ' + e.name);
}
for (const b of ri.blocks) { const n = b.maps.filter(m => m.identified).map(m => m.name); ok(PACK.every(x => n.includes(x)) && n.length === 37, 'all pack maps in ' + b.label); }
const ri2 = MSA.analyze(rb), ap = MSA.applyMapPack(ri2, entries);
ok(ap.total === 50 && ap.matched === 49 && ap.missing.length === 0 && ap.sizeMismatch.length === 0, 'applyMapPack ' + JSON.stringify([ap.matched, ap.missing, ap.sizeMismatch]));
ok(ri2.blocks[2].maps.find(m => m.dataAddr === 0x3CFB0).name === 'N146 Pump Voltage Map CB1', 'pack name applied');
// constants: stock values in every block of every GK/GL/SG dump, tuned or not
for (const f of files) { const b = load(f), i = MSA.analyze(b), c = MSA.constants(b, i); ok(c && c.family === '028906021GK / GL' && c.rows.length === 19, 'G constants ' + f); ok(!c.rows.some(r => r.changed), 'stock constants ' + f + ' ' + c.rows.filter(r => r.changed).map(r => r.name)); ok(i.blocks.map(x => x.coding).join() === '2,1', 'coding ' + f); }
{ const c = MSA.constants(rb, ri), g = k => c.rows.find(r => r.key === k); ok(ri.blocks.map(x => x.coding).join() === '2,3,1', 'GL coding'); ok(g('iqmax').text.join() === '51 mg,51 mg,51 mg' && g('pbm').text[0] === '5100 (51.00 mg)' && g('boostlim').vals[0] === 1990 && g('pcfg2').text[0] === '18 / 255' && g('mapfac').vals[2] === 980, 'GL constants'); }
ok(MSA.applyMapPack(MSA.analyze(rb), [{ addr: 0x12345, name: 'x', cols: 1, rows: 1 }, { addr: 0x19CC, name: 'dw', cols: 9, rows: 16 }]).missing.length === 1, 'missing reported');
const txt = MSA.mapPackText(ri); ok(txt.includes('019CC Drivers wish CB2 8x16') && txt.includes('3F3A8 Map linearization CB1 2x1') && MSA.parseMapPack(txt).length === 111, 'map pack export');
{ const { L, H } = MSA.split(rb); const r = MSA.autoMerge(H, L, 'a', 'b'); ok(r.sure && MSA.equal(r.bin, rb), 'ref merge'); }
// ---- 038906018P / 0281001720 (dump_ori.bin) with the forum map lists ----
const pb = new Uint8Array(fs.readFileSync(path.join(refDir, '..', 'ref2', 'dump_ori.bin'))), pi = MSA.analyze(pb);
ok(pi.warnings.length === 0 && pi.blocks.length === 3 && pi.ident.part === '038906018P' && pi.ident.bosch === '0281001720' && pi.ident.sw === '1629', 'P ident');
ok(pi.blocks.map(b => b.label).join('|') === 'CB2 · Manual (SG)|CB3 · Manual (SG)|CB1 · Automatic (AG)' && pi.blocks.map(b => b.coding).join() === '2,3,1', 'P blocks / coding digits 2,3,1');
const forum = MSA.parseMapPack(fs.readFileSync(path.join(refDir, '..', 'ref2', 'forum_cb2.txt'), 'utf8'));
ok(forum.length === 38, 'forum lines ' + forum.length);
const wrongSize = { 0x6050: '2x2', 0x5E94: '5x2', 0x5E76: '4x1' };   // the forum's size guess differs from the real table in the dump
for (const e of forum) {
  const m = pi.blocks[0].maps.find(x => x.dataAddr === e.addr);
  ok(m, 'forum address has a map: ' + e.name + ' ' + e.addr.toString(16));
  const want = wrongSize[e.addr] || e.cols + 'x' + e.rows; ok(MSA.dims(m) === want, 'forum size ' + e.name + ' ' + MSA.dims(m) + ' vs ' + want);
  if (e.addr !== 0x6050) {
    ok(m.identified, 'forum map identified: ' + e.name);
    for (const [k, base] of [[1, 0x8000], [2, 0x38000]]) { const x = pi.blocks[k].maps.find(y => y.dataAddr === e.addr + base); ok(x && x.name === m.name && MSA.dims(x) === MSA.dims(m), 'same name in block ' + k + ' ' + e.name); }
  }
}
ok(pi.blocks[0].maps.filter(m => m.identified).length === 38, 'P identified count');
const pn = a => pi.blocks[0].maps.find(m => m.dataAddr === a).name;
ok(pn(0x5476) === 'Boost target map (1)' && pn(0x55F2) === 'Boost target map (2)' && pn(0x575E) === 'Desired boost correction (LDR)' && pn(0x730C) === 'SOI limiter temp' && pn(0x3F34) === 'Smoke limiter' && pn(0x4294) === 'MAP smoke limiter' && pn(0x6C26) === 'Map linearization', 'P names');
ok(!pi.blocks[0].maps.find(m => m.dataAddr === 0x218E).identified, 'look-alike boost map at 0x218E not named');
{ const c = MSA.constants(pb, pi), g = k => c.rows.find(r => r.key === k); ok(c.family === '038906018P / 0281001720' && c.rows.length === 29 && !c.rows.some(r => r.changed), 'P constants stock');
  ok(g('coding').vals.join() === '2,3,1' && g('boostlim').vals.join() === '1990,1990,1990' && g('pbm').vals[2] === 5100 && g('sigaper').vals[0] === 62500 && g('tqmax').vals[1] === 51 && g('pcfg3').vals[0] === '18,255' && g('idleac').vals.join() === '862,820,820' && g('idle1').vals[0] === 861, 'P constants values'); }
// editing a constant is reported by name in compare, and flagged against the stock value
{ const t = pb.slice(); t[0x38000 + 0x2D95] = 80; t[0x4DDC] = 0x80; const ti = MSA.analyze(t), c = MSA.compare(t, pb, ti), tc = MSA.constants(t, ti);
  ok(c.outside.some(r => /Constant: Max IQ limit \(CB1/.test(r.note)) && c.outside.some(r => /Constant: ARD maximum quantity \(CB2/.test(r.note)), 'compare names constants: ' + c.outside.map(r => r.note));
  ok(tc.rows.filter(r => r.changed).map(r => r.key).join() === 'iqmax,ard', 'changed constants flagged'); }
{ const { L, H } = MSA.split(pb); ok(MSA.chipMarker(L) === 'L' && MSA.chipMarker(H) === 'H', 'P chip tags'); for (const [a, b] of [[L, H], [H, L]]) { const r = MSA.autoMerge(a, b, 'x', 'y'); ok(r.sure && MSA.equal(r.bin, pb), 'P merge'); } }
// every identified map has named row/column axes and a value unit (no 'variable XXXX' left)
for (const [bin, info] of [[pb, pi]]) for (const bl of info.blocks) for (const m of bl.maps) if (m.identified) {
  ok(m.q1 && (m.id2 === null || m.q2) && m.dq, 'axes named: ' + m.name + ' @' + MSA.hex(m.dataAddr, 5)); }
{ const m = pi.blocks[0].maps.find(x => x.name === 'EGR'), t = pi.blocks[0].maps.find(x => x.name === 'Torque limiter'), s = pi.blocks[0].maps.find(x => x.name === 'MAP smoke limiter');
  ok(m.q1 === 'rpm' && m.q2 === 'iq' && m.dq === 'maf', 'EGR: rpm x injection quantity -> air mass');
  ok(t.q1 === 'atm' && t.q2 === 'rpm' && t.dq === 'iq', 'Torque limiter axes');
  ok(s.q2 === 'boost' && s.dq === 'iq', 'MAP smoke limiter columns are boost pressure'); }
console.log('core tests passed:', checks, 'checks on', files.length, 'dumps');
