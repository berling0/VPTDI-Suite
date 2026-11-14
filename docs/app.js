/* VAG VPTDI - user interface. All file handling happens in this window; nothing is uploaded anywhere. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hex = MSA.hex;
  const FORCE_DOWNLOAD = /[?&]dl=1/.test(location.search);

  const S = { cur: null, ref: null, pending: null, block: 0, sel: null, mode: 'val', phys: true, cmp: null, view: 'map', viz: '2d', opv: '', cells: new Set(), anchor: null, _lastSel: null, foldOther: {}, userOriginal: false, autoStage1Done: false, autoStage1Summary: '', autoStage1Pending: false, rot: { az: -0.7, el: 0.9 }, hoverRow: null, hover3d: null };

  // ---------- helpers ----------
  function banner(msg, kind) {
    const b = $('banner');
    if (!msg) { b.style.display = 'none'; return; }
    b.className = kind || ''; b.innerHTML = '<button id="bx">✕</button>' + msg; b.style.display = 'block';
    $('bx').onclick = () => banner(null);
  }
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = 'none'), 4500); }
  const readFile = f => f.arrayBuffer().then(b => ({ name: f.name, buf: new Uint8Array(b) }));
  const baseName = n => n.replace(/\.[^.\\/]*$/, '');
  function commonBase(a, b) {
    a = baseName(a); b = baseName(b); let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const c = a.slice(0, i).replace(/[\s_\-.(]+$/, '');
    return c.length >= 3 ? c : a;
  }
  const kb = n => (n % 1024 === 0 ? n / 1024 + ' KB' : n + ' bytes');

  // ---------- opening ----------
  // Turns 1 or 2 picked files into one combined image. Returns null when it only stored a lone chip.
  async function buildImage(fileList, forCompare) {
    const files = await Promise.all([...fileList].map(readFile));
    if (!files.length) return null;
    if (files.length > 2) throw new Error('Pick one combined file, or exactly two chip files (LLL and HHH).');
    if (files.length === 2) return mergeTwo(files[0], files[1]);
    const f = files[0];
    const chip = MSA.looksLikeSingleChip(f.buf);
    if (S.pending && !forCompare && chip && chip !== 'MSA15.1' && S.pending.buf.length === f.buf.length) { const p = S.pending; S.pending = null; return mergeTwo(p, f); }
    if (chip) {
      if (chip === 'MSA15.1') return { name: f.name, bin: f.buf, msg: '<b>' + esc(f.name) + '</b> is a 64 KiB EDC MSA12 / EDC1.3.3 image. The detected 8-bit maps are editable; checksum correction is not available for this older format.', kind: '' };
      if (forCompare) throw new Error(esc(f.name) + ' is a single chip dump. To compare, select both chip files (LLL and HHH) together, or a combined bin.');
      S.pending = f;
      if (chip === 'MSA15.1') banner('<b>' + esc(f.name) + '</b> is a 64 KiB MSA15.1/older ROM image. This editor supports 128 KiB MSA15.5 chip files or a combined 256 KiB dump.', 'err');
      else banner('<b>' + esc(f.name) + '</b> is a single chip dump (' + kb(f.buf.length) + (chip === '?' ? '' : ', tagged <b>' + chip + '</b>') + '). Now open the other chip file and the two are merged automatically.', '');
      return null;
    }
    return { name: f.name, bin: f.buf, msg: null };
  }
  function mergeTwo(a, b) {
    const r = MSA.autoMerge(a.buf, b.buf, a.name, b.name);
    const L = r.lFirst ? a : b, H = r.lFirst ? b : a;
    let msg = 'Merged <b>' + esc(L.name) + '</b> (LLL, even bytes) + <b>' + esc(H.name) + '</b> (HHH, odd bytes). Order decided by ' + esc(r.reason) + '.';
    let kind = 'ok';
    if (r.same) { msg = 'Both files are identical - you picked the same chip twice. ' + msg; kind = 'err'; }
    else if (!r.sure) kind = '';
    return { name: commonBase(a.name, b.name) + '_merged.bin', bin: r.bin, msg, kind };
  }
  async function openFiles(fileList) {
    try {
      const img = await buildImage(fileList, false);
      if (!img) return;
      const info = MSA.analyze(img.bin);
      // Some early 64 KiB images have the ID fields split by filler bytes;
      // recover the VAG/Bosch numbers from the supplied filename when needed.
      if (!info.ident) {
        const m = img.name.match(/Bosch_(0281\d{6})_(028906021[A-Z]{0,2})/i);
        if (m) info.ident = { addr: 0, text: m[2].toUpperCase(), part: m[2].toUpperCase(), bosch: m[1], gear: '', sw: '', engine: '' };
        if (info.ident && /^028906021/.test(info.ident.part)) info.ecuType = img.bin.length === 0x10000 ? 'EDC MSA12 / EDC1.3.3' : 'MSA15.5';
      }
      S.userOriginal = window.confirm('Is this an Original file?\n\nChoose Yes only for an untouched factory/original BIN. This enables Auto Stage 1.');
      S.cur = { name: img.name, bin: img.bin, orig: img.bin.slice(), info }; S.autoStage1Done = false; S.autoStage1Summary = '';
      S.ref = null; S.cmp = null; S.block = 0; S.sel = null; S.mode = 'val'; S.cells = new Set(); S.anchor = null; S._lastSel = null;
      const w = S.cur.info.warnings;
      if (w.length) banner((img.msg ? img.msg + '<br>' : '') + w.map(esc).join('<br>'), 'err'); else banner(img.msg, img.kind);
      render();
    } catch (e) { banner(e.message, 'err'); }
  }
  async function openCompare(fileList) {
    try {
      const img = await buildImage(fileList, true);
      if (!img) return;
      S.ref = { name: img.name, bin: img.bin };
      S.cmp = MSA.compare(S.cur.bin, S.ref.bin, S.cur.info);
      S.mode = 'diff';
      if (!S.cmp.changedBytes && S.cmp.sameSize) banner('<b>' + esc(S.ref.name) + '</b> is byte-for-byte identical to the open file.', 'ok');
      else banner((S.cmp.sameSize ? '' : 'The files have different sizes. ') + 'Comparing against <b>' + esc(S.ref.name) + '</b>: ' + S.cmp.changedBytes + ' bytes differ, ' + S.cmp.changedMaps.length + ' maps changed.', S.cmp.sameSize ? 'ok' : 'err');
      setView('changes'); render();
    } catch (e) { banner(e.message, 'err'); }
  }

  // ---------- saving ----------
  function download(name, bytes) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function saveOne(name, bytes) {
    if (window.showSaveFilePicker && !FORCE_DOWNLOAD) {
      let h;
      try { h = await window.showSaveFilePicker({ suggestedName: name }); } catch (e) { if (e.name === 'AbortError') return null; throw e; }
      const w = await h.createWritable(); await w.write(bytes); await w.close();
      return h.name;
    }
    download(name, bytes); return name + ' (Downloads folder)';
  }
  async function saveBin() {
    try {
      const fixed = checksumSupported() ? applyCorrection() : 0;
      if (fixed) render();
      const n = await saveOne(baseName(S.cur.name) + '.bin', S.cur.bin);
      if (n) toast('Saved ' + n + ' - ' + S.cur.bin.length + ' bytes' + (fixed ? ', ' + fixed + ' checksum' + (fixed > 1 ? 's' : '') + ' corrected' : '') + ', byte sum ' + S.cur.info.sums.file);
    } catch (e) { banner('Could not save: ' + esc(e.message), 'err'); }
  }
  async function saveChips() {
    try {
      const fixed = checksumSupported() ? applyCorrection() : 0;
      if (fixed) render();
      const { L, H } = MSA.split(S.cur.bin);
      if (!MSA.equal(MSA.merge(L, H), S.cur.bin)) throw new Error('Internal check failed: the split files do not merge back to the same image. Nothing was written.');
      const base = baseName(S.cur.name).replace(/_merged$/, ''), nL = base + '.LLL', nH = base + '.HHH';
      let where;
      if (window.showDirectoryPicker && !FORCE_DOWNLOAD) {
        let dir;
        try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
        for (const [n, d] of [[nL, L], [nH, H]]) { const h = await dir.getFileHandle(n, { create: true }); const w = await h.createWritable(); await w.write(d); await w.close(); }
        where = 'folder "' + dir.name + '"';
      } else { download(nL, L); await new Promise(r => setTimeout(r, 400)); download(nH, H); where = 'the Downloads folder'; }
      banner((fixed ? '<b>' + fixed + ' block checksum' + (fixed > 1 ? 's' : '') + ' corrected.</b> ' : '') + 'Saved <b>' + esc(nL) + '</b> (byte sum ' + S.cur.info.sums.L + ') and <b>' + esc(nH) + '</b> (byte sum ' + S.cur.info.sums.H + ') to ' + esc(where) + ' - ' + kb(L.length) + ' each. Verified: they merge back to exactly the open image.', 'ok');
    } catch (e) { banner('Could not save: ' + esc(e.message), 'err'); }
  }

  // ---------- rendering ----------
  function setView(v) { S.view = v; document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'p-' + v)); if (v === 'map') drawChart(); }
  function render() {
    const has = !!S.cur;
    $('empty').style.display = has ? 'none' : 'flex';
    $('side').style.display = has ? 'flex' : 'none';
    $('work').style.display = has ? 'flex' : 'none';
    for (const id of ['bCmp', 'bSaveBin', 'bSaveChips', 'bFix']) $(id).disabled = !has;
    $('bSaveBin').textContent = has && S.cur.info.ecuType === 'MSA15.5' ? 'Save combined .bin' : 'Save .bin';
    $('bSaveBin').title = has && S.cur.info.ecuType === 'MSA15.5'
      ? 'Save the combined (interleaved) file (checksums corrected automatically)'
      : 'Save the edited BIN file (checksums corrected automatically)';
    // Only the dual-chip MSA15.5 format has a meaningful LLL/HHH export.
    // EDC15V is a single-flash image, so avoid presenting a misleading split
    // save action for it (and for the older single-image MSA12 format).
    $('bSaveChips').style.display = has && S.cur.info.ecuType === 'MSA15.5' ? '' : 'none';
    $('fname').textContent = has ? S.cur.name + (S.ref ? '   vs   ' + S.ref.name : '') : '';
    renderCk(); renderTune();
    if (!has) return;
    const info = S.cur.info, id = info.ident;
    $('ecu').innerHTML = [
      ['VAG part no.', id ? id.part : '-'], ['Bosch no.', id ? id.bosch || '-' : '-'], ['Engine', id ? id.engine || '-' : '-'],
      ['ECU type', info.ecuType || 'Unknown'],
      ['Software', info.blocks.map(b => (b.ident ? b.ident.gear + ' ' + b.ident.sw : '?')).join(' / ') || '-'],
      [info.blocks.some(b => b.coding !== null) ? 'Engine coding' : 'Code blocks', info.blocks.map(b => b.cb + (b.coding !== null ? '=' + b.coding : '')).join('  ')],
      ['Size', kb(info.size)], ['Maps found', info.mapCount], ['Byte sum', info.sums.file]
    ].map(([k, v]) => '<span>' + k + '</span><span title="' + esc(v) + '">' + esc(v) + '</span>').join('');
    $('blocks').innerHTML = info.blocks.map((b, i) => '<button data-b="' + i + '" class="' + (i === S.block ? 'on' : '') + '" title="0x' + hex(b.start, 5) + ' - 0x' + hex(b.end - 1, 5) + (b.coding !== null ? '  ·  used when the engine coding ends in ' + b.coding : '') + (b.ident ? '  ·  ' + b.ident.text : '') + '">' + esc(b.label) + '</button>').join('');
    $('chgWrap').style.display = S.cmp ? 'flex' : 'none';
    if (!S.cmp) $('onlyChg').checked = false;
    renderList(); renderMap(); renderChanges(); renderChips(); renderConsts();
    const on = $('blocks').querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // ---------- map pack file ----------
  async function loadPack(fileList) {
    try {
      if (!fileList.length) return;
      const entries = MSA.parseMapPack(await fileList[0].text());
      if (!entries.length) throw new Error('No map lines found in ' + esc(fileList[0].name) + '. Expected lines like: <b>019CC Drivers wish 8x16</b> (data address, name, columns x rows).');
      const r = MSA.applyMapPack(S.cur.info, entries);
      let msg = 'Map pack <b>' + esc(fileList[0].name) + '</b>: ' + r.matched + ' maps named from ' + r.total + ' lines.';
      if (r.missing.length) msg += '<br>No map found at: ' + r.missing.map(e => esc(hex(e.addr, 5) + ' ' + e.name)).join(', ') + '.';
      if (r.sizeMismatch.length) msg += '<br>Size differs from the map pack at: ' + r.sizeMismatch.map(x => esc(hex(x.entry.addr, 5) + ' ' + x.entry.name + ' (pack ' + x.entry.cols + 'x' + x.entry.rows + ', file ' + x.cols + 'x' + x.rows + ')')).join(', ') + '.';
      banner(msg, r.missing.length || r.sizeMismatch.length ? '' : 'ok');
      if (S.ref) S.cmp = MSA.compare(S.cur.bin, S.ref.bin, S.cur.info);
      render();
    } catch (e) { banner(e.message, 'err'); }
  }
  function renderList() {
    const blk = S.cur.info.blocks[S.block], el = $('list');
    if (!blk) { el.innerHTML = '<div class="grp">No maps found</div>'; return; }
    const q = $('q').value.trim().toLowerCase(), only = $('onlyChg').checked;
    const match = m => (!only || m.changed) && (!q || (m.name + ' ' + hex(m.dataAddr, 5) + ' ' + hex(m.addr, 5) + ' ' + MSA.dims(m)).toLowerCase().includes(q));
    const row = m => '<div class="it' + (m.identified ? ' id' : '') + (m.flat ? ' flat' : '') + (m === S.sel ? ' sel' : '') + '" data-i="' + m.index + '">' +
      (S.cmp ? '<span class="chg' + (m.changed ? '' : ' no') + '" title="changed vs reference"></span>' : '') +
      '<span class="a">' + hex(m.dataAddr, 5) + '</span><span class="n" title="' + esc(m.name) + '">' + esc(m.name) + '</span><span class="d">' + MSA.dims(m) + '</span></div>';
    const idd = blk.maps.filter(m => m.identified && match(m)), rest = blk.maps.filter(m => !m.identified && match(m));
    const folded = !!S.foldOther[S.block] && !q;
    el.innerHTML = (idd.length ? '<div class="grp">Identified (' + idd.length + ')</div>' + idd.map(row).join('') : '') +
      '<button class="grp fold" data-fold="other">' + (folded ? '▸ ' : '▾ ') + 'All other maps by address (' + rest.length + ')</button>' + (folded ? '' : rest.map(row).join(''));
    if (!S.sel || S.sel.block !== S.block) { S.sel = idd[0] || rest[0] || null; if (S.sel) { const n = el.querySelector('[data-i="' + S.sel.index + '"]'); if (n) n.classList.add('sel'); } }
  }
  const fmtQ = (v, q) => (S.phys && q ? (v * MSA.Q[q].f + MSA.Q[q].off).toFixed(MSA.Q[q].dec) : String(v));
  const axisLabel = (q, id) => (q ? MSA.Q[q].name + (S.phys ? ' [' + MSA.Q[q].unit + ']' : '') : 'variable ' + hex(id));
  function heat(t) { const h = 215 - 215 * t; return 'hsla(' + h.toFixed(0) + ',55%,' + (26 + 8 * t).toFixed(0) + '%,.9)'; }
  function renderMap() {
    const m = S.sel;
    if (!m) { $('mhead').innerHTML = '<h2>No map selected</h2>'; $('mnote').textContent = ''; $('tablewrap').innerHTML = ''; return; }
    const sid = m.block + '_' + m.index;
    if (S._lastSel !== sid) { S.cells = new Set(); S.anchor = null; S._lastSel = sid; }
    const cur = MSA.values(S.cur.bin, m);
    const canCmp = !!S.ref && m.end <= S.ref.bin.length;
    const ref = canCmp ? MSA.values(S.ref.bin, m) : null;
    const mode = canCmp ? S.mode : 'val';
    const orig = (!canCmp && S.cur.orig) ? MSA.values(S.cur.orig, m) : null;  // show edits even without a compare file
    const cmp = ref || orig;
    const editable = mode === 'val';
    const hasUnits = m.q1 || m.q2 || m.dq;
    $('mhead').innerHTML = '<div><h2>' + esc(m.name) + '</h2><div class="sub">data 0x' + hex(m.dataAddr, 5) + '-0x' + hex(m.end - 1, 5) + ' · ' + MSA.dims(m) + ' (columns x rows) · axis header 0x' + hex(m.addr, 5) + ' · 16-bit ' + (m.signed ? 'signed' : 'unsigned') + ' · raw ' + m.min + '…' + m.max + '</div></div><span class="grow"></span>' +
      (canCmp ? '<span class="seg" id="segMode">' + [['val', 'This file'], ['diff', 'Difference'], ['ref', 'Reference']].map(([k, t]) => '<button data-m="' + k + '" class="' + (mode === k ? 'on' : '') + '">' + t + '</button>').join('') + '</span>' : '') +
      '<button data-rename="1" title="Give this map a custom name">Rename</button><span class="seg" id="segUnit"><button data-p="0" class="' + (S.phys ? '' : 'on') + '">Raw</button><button data-p="1" class="' + (S.phys ? 'on' : '') + '"' + (hasUnits ? '' : ' disabled title="No unit known for this map"') + '>Units</button></span>' +
      (editable ? '<span id="segEdit"><input id="opv" type="text" inputmode="numeric" autocomplete="off" placeholder="value" value="' + esc(S.opv) + '"><button data-op="set" title="Set the selected cells to this value">Set</button><button data-op="add" title="Add this value to the selected cells">+</button><button data-op="sub" title="Subtract this value from the selected cells">−</button></span><span id="selcount"></span>' : '');
    const rowsLbl = axisLabel(m.q1, m.id1), colsLbl = m.id2 !== null ? axisLabel(m.q2, m.id2) : null;
    $('mnote').className = 'note';
    $('mnote').innerHTML = 'Rows: <b>' + esc(rowsLbl) + '</b>' + (colsLbl ? ' &nbsp;·&nbsp; Columns: <b>' + esc(colsLbl) + '</b>' : '') +
      (m.dq ? ' &nbsp;·&nbsp; Values: <b>' + esc(MSA.Q[m.dq].name) + (S.phys ? ' [' + MSA.Q[m.dq].unit + ']' : '') + '</b>' : '') +
      (S.ref && m.changed ? ' &nbsp;·&nbsp; <span style="color:var(--acc)">changed vs reference</span>' : '');
    const show = mode === 'ref' ? ref : cur, span = (m.max - m.min) || 1;
    let maxD = 0;
    if (ref) for (let r = 0; r < m.n1; r++) for (let c = 0; c < m.n2; c++) maxD = Math.max(maxD, Math.abs(cur[r][c] - ref[r][c]));
    let h = '<table class="map"><thead><tr><th class="corner">' + (colsLbl ? '↓ rows / cols →' : '') + '</th>';
    if (m.id2 !== null) m.ax2.forEach((x, i) => h += '<th' + (editable ? ' class="axh" data-axis="col" data-k="' + i + '"' : '') + '>' + fmtQ(x, m.q2) + '</th>'); else h += '<th>value</th>';
    h += '</tr></thead><tbody>';
    for (let r = 0; r < m.n1; r++) {
      h += '<tr><th data-r="' + r + '"' + (editable ? ' class="axh" data-axis="row" data-k="' + r + '"' : '') + '>' + fmtQ(m.ax1[r], m.q1) + '</th>';
      for (let c = 0; c < m.n2; c++) {
        const v = show[r][c], d = cmp ? cur[r][c] - cmp[r][c] : 0;
        let bg, txt = fmtQ(v, m.dq), tip = 'raw ' + v + ' (0x' + hex(v & 0xFFFF) + ') @ 0x' + hex(m.dataAddr + 2 * (r * m.n2 + c), 5) + boostNote(m.dq, v);
        if (mode === 'diff') {
          if (d === 0) bg = 'transparent';
          else { const a = (0.25 + 0.6 * Math.abs(d) / maxD).toFixed(2); bg = d > 0 ? 'rgba(63,191,127,' + a + ')' : 'rgba(229,96,77,' + a + ')'; }
          if (d !== 0) { const f = m.dq && S.phys ? MSA.Q[m.dq] : null; txt = (d > 0 ? '+' : '') + (f ? (d * f.f).toFixed(f.dec) : d); }
          else txt = '<span style="color:var(--dim)">' + txt + '</span>';
        } else bg = m.flat ? 'transparent' : heat(Math.min(1, Math.max(0, (v - m.min) / span)));
        if (ref) tip += '\nreference ' + ref[r][c] + ' → this file ' + cur[r][c] + (d ? ' (' + (d > 0 ? '+' : '') + d + (ref[r][c] ? ', ' + (d * 100 / Math.abs(ref[r][c])).toFixed(1) + '%' : '') + ')' : '');
        const cls = [editable ? 'ed' : '', editable && S.cells.has(r * m.n2 + c) ? 'msel' : '', d && mode !== 'diff' ? 'chg' : ''].filter(Boolean).join(' ');
        h += '<td style="background:' + bg + '"' + (cls ? ' class="' + cls + '"' : '') + ' data-r="' + r + '" data-c="' + c + '" title="' + esc(tip) + '">' + txt + '</td>';
      }
      h += '</tr>';
    }
    $('tablewrap').innerHTML = h + '</tbody></table>';
    if (editable) updateSelCount();
    drawChart();
  }
  function boostNote(dq, raw) {
    if (dq !== 'boost' && dq !== 'mbar') return '';
    const rel = (raw - 1013) / 1000;
    return '\n= ' + (raw / 1000).toFixed(2) + ' bar absolute (' + (rel >= 0 ? '+' : '') + rel.toFixed(2) + ' bar over ambient)';
  }
  // ---------- chart hover / highlight ----------
  let chartHit = null;
  function clearHl() { if (S.cur) $('tablewrap').querySelectorAll('.hl').forEach(e => e.classList.remove('hl')); }
  function hlRow(r) { clearHl(); $('tablewrap').querySelectorAll('[data-r="' + r + '"]').forEach(e => e.classList.add('hl')); }
  function hlCell(r, c) { clearHl(); const el = $('tablewrap').querySelector('td[data-r="' + r + '"][data-c="' + c + '"]'); if (el) el.classList.add('hl'); }
  const chartXY = e => { const r = $('chart').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function ptSeg(px, py, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1; let t = ((px - a[0]) * dx + (py - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)); }
  function nearestSeries2D(mx, my) { if (!chartHit || chartHit.type !== '2d' || !chartHit.is3d) return null; let best = 18, bi = null; chartHit.sp.forEach((pts, i) => { for (let k = 1; k < pts.length; k++) { const d = ptSeg(mx, my, pts[k - 1], pts[k]); if (d < best) { best = d; bi = i; } } }); return bi; }
  function nearestVert3D(mx, my) { if (!chartHit || chartHit.type !== '3d') return null; let best = 24, bv = null; for (const v of chartHit.verts) { const d = Math.hypot(v.sx - mx, v.sy - my); if (d < best) { best = d; bv = v; } } return bv; }
  function drawChart() {
    const m = S.sel, cv = $('chart');
    if (!m || !S.cur || S.view !== 'map' || !cv.clientWidth) return;
    const can3d = m.id2 !== null && m.n1 > 1 && m.n2 > 1, segv = $('segViz');
    if (segv) segv.querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.z === (can3d ? S.viz : '2d')); if (b.dataset.z === '3d') b.disabled = !can3d; });
    if (S.viz === '3d' && can3d) draw3D(m, cv); else draw2D(m, cv);
  }
  function draw3D(m, cv) {
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const vals = MSA.values(S.cur.bin, m), n1 = m.n1, n2 = m.n2;
    let lo = Infinity, hi = -Infinity; for (const row of vals) for (const v of row) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = (hi - lo) || 1, ca = Math.cos(S.rot.az), sa = Math.sin(S.rot.az), ce = Math.cos(S.rot.el), se = Math.sin(S.rot.el);
    const scale = Math.min(W, H) * 0.44, cx = W / 2, cy = H * 0.60, hF = 0.62;
    const z = (c, r) => (vals[r][c] - lo) / span;
    const proj = (c, r, h) => { const x = c / Math.max(1, n2 - 1) - 0.5, y = r / Math.max(1, n1 - 1) - 0.5, hh = h * hF, x1 = x * ca - y * sa, y1 = x * sa + y * ca; return { sx: cx + x1 * scale, sy: cy - (y1 * se + hh * ce) * scale, d: y1 }; };
    const quads = [];
    for (let r = 0; r < n1 - 1; r++) for (let c = 0; c < n2 - 1; c++) {
      const P = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]].map(([x, y]) => proj(x, y, z(x, y)));
      quads.push({ d: (P[0].d + P[2].d) / 2, P, avg: (z(c, r) + z(c + 1, r) + z(c + 1, r + 1) + z(c, r + 1)) / 4 });
    }
    quads.sort((a, b) => b.d - a.d);                 // far first
    for (const q of quads) { g.beginPath(); q.P.forEach((p, i) => i ? g.lineTo(p.sx, p.sy) : g.moveTo(p.sx, p.sy)); g.closePath(); g.fillStyle = heat(q.avg); g.fill(); g.strokeStyle = 'rgba(14,17,22,.55)'; g.lineWidth = 0.5; g.stroke(); }
    // axes from the (col0,row0,bottom) corner
    g.font = '11px Consolas, monospace'; g.textBaseline = 'middle'; g.lineWidth = 1.5;
    const o = proj(0, 0, 0), axisLn = (b, col, lbl, ta) => { g.strokeStyle = col; g.beginPath(); g.moveTo(o.sx, o.sy); g.lineTo(b.sx, b.sy); g.stroke(); g.fillStyle = col; g.textAlign = ta; g.fillText(lbl, b.sx + (ta === 'right' ? -5 : 5), b.sy); };
    axisLn(proj(n2 - 1, 0, 0), '#4fb3d9', (m.q2 ? MSA.Q[m.q2].name : 'cols'), 'left');
    axisLn(proj(0, n1 - 1, 0), '#f0a437', (m.q1 ? MSA.Q[m.q1].name : 'rows'), 'right');
    axisLn(proj(0, 0, 1), '#a6e8c0', (m.dq ? MSA.Q[m.dq].unit : 'raw'), 'left');
    if (S.hover3d) { const p = proj(S.hover3d.c, S.hover3d.r, z(S.hover3d.c, S.hover3d.r)); g.fillStyle = '#fff'; g.beginPath(); g.arc(p.sx, p.sy, 5, 0, 7); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke(); }
    const verts = []; for (let r = 0; r < n1; r++) for (let c = 0; c < n2; c++) { const p = proj(c, r, z(c, r)); verts.push({ r, c, sx: p.sx, sy: p.sy }); }
    chartHit = { type: '3d', verts };
    $('legend').textContent = 'Drag to rotate · ' + axisLabel(m.q2, m.id2) + ' (blue) × ' + axisLabel(m.q1, m.id1) + ' (orange), height = ' + (m.dq ? MSA.Q[m.dq].name : 'value') + ' (green) · hover highlights the cell';
  }
  function draw2D(m, cv) {
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const cur = MSA.values(S.cur.bin, m), ref = S.ref && m.changed ? MSA.values(S.ref.bin, m) : null;
    const is3d = m.id2 !== null, xs = is3d ? m.ax2 : m.ax1, xq = is3d ? m.q2 : m.q1;
    const series = is3d ? cur : [cur.map(r => r[0])], rseries = ref ? (is3d ? ref : [ref.map(r => r[0])]) : null;
    let lo = Infinity, hi = -Infinity;
    for (const s of series.concat(rseries || [])) for (const v of s) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = { l: 58, r: 30, t: 12, b: 26 }, x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
    const X = x => pad.l + (W - pad.l - pad.r) * (x - x0) / (x1 - x0), Y = v => H - pad.b - (H - pad.t - pad.b) * (v - lo) / (hi - lo);
    g.font = '11px Consolas, monospace'; g.strokeStyle = '#2e343f'; g.fillStyle = '#8b95a3'; g.lineWidth = 1;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, y = Y(v); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke(); g.fillText(fmtQ(Math.round(v), m.dq), pad.l - 6, y); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    const step = Math.ceil(xs.length / 12);
    xs.forEach((x, i) => { if (i % step === 0 || i === xs.length - 1) g.fillText(fmtQ(x, xq), X(x), H - pad.b + 6); });
    const line = (s, style, dash, w) => { g.strokeStyle = style; g.setLineDash(dash); g.lineWidth = w; g.beginPath(); s.forEach((v, i) => (i ? g.lineTo(X(xs[i]), Y(v)) : g.moveTo(X(xs[i]), Y(v)))); g.stroke(); };
    if (rseries) rseries.forEach(s => line(s, 'rgba(160,170,185,.45)', [4, 3], 1));
    const sp = [];
    series.forEach((s, i) => { const hov = is3d && i === S.hoverRow; line(s, hov ? '#fff' : 'hsl(' + (200 - 170 * (series.length > 1 ? i / (series.length - 1) : 0.5)).toFixed(0) + ',70%,60%)', [], hov ? 3 : 1.6); sp.push(s.map((v, j) => [X(xs[j]), Y(v)])); });
    g.setLineDash([]);
    chartHit = { type: '2d', is3d, sp };
    $('legend').textContent = (is3d ? 'One line per row — hover a line to highlight its row. (' + axisLabel(m.q1, m.id1) + ': ' + fmtQ(m.ax1[0], m.q1) + ' = blue … ' + fmtQ(m.ax1[m.n1 - 1], m.q1) + ' = orange) over ' + axisLabel(m.q2, m.id2) + '.' : 'Curve over ' + axisLabel(m.q1, m.id1) + '.') + (rseries ? ' Dashed grey = reference file.' : '');
  }
  function renderChanges() {
    const el = $('p-changes');
    if (!S.cmp) { el.innerHTML = '<p class="note">Use <b>Compare with…</b> to load a second file (for example the original dump). You then get every changed map here and can step through the differences cell by cell.</p>'; return; }
    const c = S.cmp, info = S.cur.info;
    let h = '<h4>' + c.changedBytes + ' bytes differ from ' + esc(S.ref.name) + '</h4>';
    h += '<table class="plain"><tr><th>Block</th><th>Data address</th><th>Map</th><th>Size</th><th>Cells changed</th><th>Largest change</th></tr>';
    for (const m of c.changedMaps) {
      const a = MSA.values(S.cur.bin, m), b = MSA.values(S.ref.bin, m); let n = 0, big = 0, ax = 0;
      for (let r = 0; r < m.n1; r++) for (let k = 0; k < m.n2; k++) { const d = a[r][k] - b[r][k]; if (d) { n++; if (Math.abs(d) > Math.abs(big)) big = d; } }
      for (let i = m.addr; i < m.dataAddr; i++) if (S.cur.bin[i] !== S.ref.bin[i]) ax++;
      h += '<tr class="click" data-b="' + m.block + '" data-i="' + m.index + '"><td>' + esc(info.blocks[m.block].label) + '</td><td class="m">0x' + hex(m.dataAddr, 5) + '</td><td>' + esc(m.name) + '</td><td class="m">' + MSA.dims(m) + '</td><td class="m">' + n + ' / ' + m.n1 * m.n2 + (ax ? ' + axis' : '') + '</td><td class="m">' + (big > 0 ? '+' : '') + big + '</td></tr>';
    }
    h += '</table>';
    if (!c.changedMaps.length) h += '<p class="note">No found map differs.</p>';
    if (c.outside.length) {
      h += '<h4>Changes outside the found maps</h4><table class="plain"><tr><th>Address</th><th>Bytes</th><th>What</th><th>Reference → this file (first words)</th></tr>';
      for (const r of c.outside) {
        const s = r.start & ~1, words = b => { const o = []; for (let i = s; i < Math.min(r.end, s + 8); i += 2) o.push(hex(MSA.w16(b, i))); return o.join(' '); };
        h += '<tr><td class="m">0x' + hex(r.start, 5) + '-0x' + hex(r.end - 1, 5) + '</td><td class="m">' + (r.end - r.start) + '</td><td>' + esc(r.note) + '</td><td class="m">' + words(S.ref.bin) + ' → ' + words(S.cur.bin) + '</td></tr>';
      }
      h += '</table>';
    }
    el.innerHTML = h;
  }
  function renderConsts() {
    const el = $('p-consts'), info = S.cur.info, c = MSA.constants(S.cur.bin, info);
    if (!c) { el.innerHTML = '<p class="note">No constants table for this software' + (info.ident ? ' (' + esc(info.ident.part) + ')' : '') + '. Tables exist for 038906018P / 0281001720 and 028906021GK / GL.</p>'; return; }
    const ref = S.ref && S.ref.bin.length === S.cur.bin.length ? MSA.constants(S.ref.bin, info) : null;
    let h = '<h4>Single-value constants - ' + esc(c.family) + '</h4><p class="note">Each row is one value stored once per code block (offset is inside the block). Amber = differs from the stock value' + (ref ? '; the second line shows the value in the reference file' : '') + '. ? = position inferred, not verified. These are shown as read; this program does not edit them.</p>' +
      '<table class="plain"><tr><th>Constant</th><th>Offset</th>' + info.blocks.map(b => '<th>' + esc(b.cb) + '<br><span style="text-transform:none;letter-spacing:0;color:var(--dim)">0x' + hex(b.start, 5) + '</span></th>').join('') + '<th>Meaning</th></tr>';
    c.rows.forEach((r, i) => {
      h += '<tr><td>' + esc(r.name) + (r.inferred ? ' <span title="position inferred, not verified" style="color:var(--acc)">?</span>' : '') + '</td><td class="m">0x' + hex(r.off, 4) + '</td>';
      r.vals.forEach((v, k) => {
        const rv = ref ? ref.rows[i].vals[k] : null, diff = ref && String(rv) !== String(v), stock = r.def !== undefined && String(v) !== String(r.def);
        h += '<td class="m" title="' + esc('0x' + hex(info.blocks[k].start + r.off, 5)) + '" style="' + (diff || stock ? 'color:var(--acc)' : '') + '">' + esc(r.text[k]) + (diff ? '<br><span style="color:var(--dim)">was ' + esc(ref.rows[i].text[k]) + '</span>' : '') + '</td>';
      });
      h += '<td style="color:var(--dim)">' + esc(r.note) + '</td></tr>';
    });
    el.innerHTML = h + '</table>';
  }
  function renderChips() {
    const info = S.cur.info, { L, H } = MSA.split(S.cur.bin), base = baseName(S.cur.name).replace(/_merged$/, '');
    const tag = c => MSA.chipMarker(c) || 'none';
    let h = '<h4>Chip files</h4><p class="note">The combined file holds 16-bit words. <b>LLL</b> is every even byte (low half of each word), <b>HHH</b> every odd byte (high half). Compare the byte sums below with the checksum your programmer shows after loading each file.</p>' +
      '<table class="plain"><tr><th>File</th><th>Bytes</th><th>Size</th><th>Chip tag in data</th><th>Byte sum (16-bit)</th><th>Byte sum (full)</th></tr>' +
      [[base + '.LLL', 'even (0, 2, 4…)', L, tag(L)], [base + '.HHH', 'odd (1, 3, 5…)', H, tag(H)], [baseName(S.cur.name) + '.bin', 'all', S.cur.bin, '-']].map(([n, w, d, t]) =>
        '<tr><td class="m">' + esc(n) + '</td><td>' + w + '</td><td class="m">' + kb(d.length) + '</td><td class="m">' + t + '</td><td class="m">' + hex(MSA.sum(d, 0xFFFF)) + '</td><td class="m">' + hex(MSA.sum(d), 8) + '</td></tr>').join('') + '</table>';
    const ck = MSA.checksumStatus(S.cur.bin, info);
    const famLabel = ck.family === 'sum8' ? '8-bit sum' : ck.family === 'dual16' ? 'family 1 (dual 16-bit)' : null;
    h += '<h4>Data blocks &amp; checksums' + (famLabel ? ' <span class="note" style="font-weight:400">· ' + famLabel + '</span>' : '') + '</h4><table class="plain"><tr><th>Block</th><th>Range</th><th>Maps</th><th>Stored checksum</th><th>Computed</th><th>Status</th></tr>' +
      (ck.blocks.length ? ck.blocks.map(s => {
        const maps = info.blocks.filter(b => b.start >= s.start && b.end <= s.end).reduce((t, b) => t + b.maps.length, 0);
        return '<tr><td>' + esc(s.label) + '</td><td class="m">0x' + hex(s.start, 4) + '-0x' + hex(s.store + s.width - 1, 4) + '</td><td class="m">' + maps + '</td><td class="m">' + s.stored + '</td><td class="m">' + (ck.supported ? s.computed : '-') + '</td><td class="m" style="color:' + (!ck.supported ? 'var(--dim)' : s.ok ? 'var(--up)' : 'var(--acc)') + '">' + (!ck.supported ? '-' : s.ok ? '✓ OK' : '✗ needs fix') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="m" style="color:var(--dim)">' + esc(ck.note || 'No checksum blocks found.') + '</td></tr>') + '</table>';
    if (ck.supported) h += '<p class="note"' + (ck.bad ? ' style="color:#ffd58a"' : '') + '>' + (ck.bad ? '<b>' + ck.bad + ' block checksum' + (ck.bad > 1 ? 's' : '') + ' need correcting.</b> Click <b>Correct checksums</b> at the top, or just save - the file is checksum-corrected automatically on save.' : 'All block checksums are valid. Editing a map marks the affected block for correction; saving rewrites the checksums automatically.') + '</p>';
    else h += '<p class="note warn" style="margin-top:14px">' + esc(ck.note || 'This file is not a recognised MSA checksum family, so automatic checksum correction is disabled - the stored value is shown exactly as read, and nothing is altered.') + '</p>';
    $('p-chips').innerHTML = h;
  }
  // ---------- checksums ----------
  const familySupported = () => !!(S.cur && S.cur.info && S.cur.info.family);
  const checksumSupported = () => !!(S.cur && MSA.checksumStatus(S.cur.bin, S.cur.info).supported);
  function refreshCaches() {   // after bytes change: block.stored + byte sums (maps are unaffected by checksum bytes)
    for (const blk of S.cur.info.blocks) blk.stored = hex(MSA.w16(S.cur.bin, blk.end - 2), 4) + hex(MSA.w16(S.cur.bin, blk.end - 4), 4);
    const chips = S.cur.bin.length % 2 === 0 ? MSA.split(S.cur.bin) : null;
    S.cur.info.sums = { file: hex(MSA.sum(S.cur.bin, 0xFFFF), 4), L: chips ? hex(MSA.sum(chips.L, 0xFFFF), 4) : '', H: chips ? hex(MSA.sum(chips.H, 0xFFFF), 4) : '' };
  }
  function applyCorrection() {   // recompute + write every block checksum into S.cur.bin
    const r = MSA.correctChecksums(S.cur.bin, S.cur.info);
    if (r.fixed) { S.cur.bin = r.out; refreshCaches(); if (S.ref) S.cmp = MSA.compare(S.cur.bin, S.ref.bin, S.cur.info); }
    return r.fixed;
  }
  function fixChecksums() { const f = applyCorrection(); render(); toast(f ? 'Corrected ' + f + ' block checksum' + (f > 1 ? 's' : '') + '.' : 'All block checksums were already correct.'); }
  function renderCk() {
    const bar = $('ckbar');
    if (!S.cur) { bar.style.display = 'none'; $('bFix').disabled = true; return; }
    const st = MSA.checksumStatus(S.cur.bin, S.cur.info); S.cur.ck = st;
    bar.style.display = 'flex';
    $('bFix').disabled = !st.supported || st.bad === 0;
    if (!st.supported) {
      bar.className = 'na';
      bar.innerHTML = '<span class="dot"></span><span>Checksum: <b>not a recognised MSA checksum family</b> — automatic correction is disabled so an unknown file is never altered.' + (st.note ? ' <span class="note">' + esc(st.note) + '</span>' : '') + '</span>';
    } else if (st.bad === 0) {
      bar.className = 'ok';
      bar.innerHTML = '<span class="dot"></span><span><b>Block checksums valid</b> — all ' + st.total + ' match.</span>';
    } else {
      bar.className = 'bad';
      const list = st.blocks.filter(b => !b.ok).map(b => esc(b.label)).join(', ');
      bar.innerHTML = '<span class="dot"></span><span><b>' + st.bad + ' of ' + st.total + ' block checksum' + (st.total > 1 ? 's' : '') + ' need correcting</b> &nbsp;<span class="mono">' + esc(list) + '</span></span><button id="ckfix">Correct now</button>';
      $('ckfix').onclick = fixChecksums;
    }
  }
  // ---------- one-click tuning ----------
  function renderTune() {
    const bar = $('tunebar');
    if (!S.cur || !S.cur.info.blocks.length) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const hasIQ = MSA.hasConst(S.cur.info, 'iqmax');
    const iq = hasIQ ? MSA.readConstValue(S.cur.bin, S.cur.info, 'iqmax') : null;
    if (document.activeElement !== $('tIQ')) $('tIQ').value = iq != null ? iq : '';
    $('tIQ').disabled = $('tIQset').disabled = !hasIQ;
    $('tIQ').title = hasIQ ? 'Maximum injection quantity limit' : 'No verified IQ-limit constant profile for this software';
    const rpm = MSA.revLimitValue(S.cur.info), hasRev = rpm != null;
    if (document.activeElement !== $('tRPM')) $('tRPM').value = hasRev ? rpm : '';
    $('tRPM').disabled = $('tRPMset').disabled = !hasRev;
    $('tRPMset').title = hasRev ? 'Raise the engine-speed axis top on every RPM map (torque limiter, driver\'s wish, smoke limiter, ...): last = value, the one before = value-20' : 'No engine-speed axis map found';
    $('tEGR').disabled = !S.cur.info.blocks.some(b => b.maps.some(m => /^EGR\b/.test(m.name || '')));
    $('t3bar').disabled = !MSA.hasConst(S.cur.info, 'mapfac');
    const original = S.userOriginal;
    $('tAuto').style.display = original ? '' : 'none';
    $('tAuto').disabled = !!S.autoStage1Done;
    const eligible = [...new Set(S.cur.info.blocks.flatMap(b => b.maps).filter(m => !m.flat && /^(Boost target map|Boost limit|Torque limiter|Drivers wish|Smoke limiter\b|Start of injection|N146 Pump voltage map|N75 duty)/.test(m.name || '')).map(m => m.name.replace(/ \(\d+\)$/, '').replace(/ \?$/, '')))];
    $('tAuto').title = S.autoStage1Done ? 'Changed maps: ' + (S.autoStage1Summary || 'none') : 'Changeable maps: ' + (eligible.length ? eligible.join(', ') : 'none detected');
  }
  function autoStage1() {
    if (!S.cur || S.autoStage1Done || !S.userOriginal) return;
    S.autoStage1Done = true;
    const deltas = [
      [/^Boost target map/, 180], [/^Boost limit/, 180], [/^Torque limiter/, 1400],
      [/^Drivers wish/, 330], [/^Smoke limiter\b/, 290], [/^Start of injection/, 80],
      [/^N146 Pump voltage map/, 150], [/^N75 duty/, 195]
    ];
    let changed = 0, maps = 0; const changedNames = new Set();
    for (const blk of S.cur.info.blocks) for (const m of blk.maps) {
      const hit = deltas.find(([re]) => re.test(m.name || '')); if (!hit || m.flat) continue;
      const delta = hit[1]; let mapChanged = false;
      for (let k = 0; k < m.n1 * m.n2; k++) {
        const raw = MSA.rawData(S.cur.bin, m)[k];
        const current = m.signed ? MSA.s16(raw) : raw;
        // Pair-derived Stage 1 changes scale with existing fueling/command
        // values. Preserve zero cells and signed negative correction cells;
        // this is essential for low-pedal Drivers Wish cutout areas.
        if (current === 0 || (m.signed && current < 0)) continue;
        const scaled = Math.max(1, Math.round(delta * current / Math.max(1, m.max)));
        const lo = m.signed ? -32768 : 0, next = Math.max(lo, Math.min(m.signed ? 32767 : 65535, current + scaled));
        if (next !== current) { MSA.setValue(S.cur.bin, m, Math.floor(k / m.n2), k % m.n2, next & 0xFFFF); changed++; mapChanged = true; }
      }
      if (mapChanged) { maps++; changedNames.add(m.name.replace(/ \(\d+\)$/, '').replace(/ \?$/, '')); }
    }
    S.autoStage1Summary = [...changedNames].join(', ');
    afterTune('Auto Stage 1 changed: ' + (S.autoStage1Summary || 'no recognized maps'), changed);
  }
  function afterTune(label, count) {
    if (!count) { toast(label + ': nothing changed (already set, or target not found).'); return; }
    refreshCaches();                               // byte sums changed; axis/const caches are updated in-place
    for (const blk of S.cur.info.blocks) for (const m of blk.maps) {   // refresh cached min/max (EGR changes data)
      const vals = MSA.values(S.cur.bin, m); let mn = Infinity, mx = -Infinity;
      for (const row of vals) for (const v of row) { if (v < mn) mn = v; if (v > mx) mx = v; }
      m.min = mn; m.max = mx; m.flat = mn === mx;
    }
    if (S.ref) S.cmp = MSA.compare(S.cur.bin, S.ref.bin, S.cur.info);
    render();                                      // S.sel stays valid (no re-analyze)
    toast(label + ' applied to ' + count + ' location' + (count > 1 ? 's' : '') + '. Save to write corrected checksums.');
  }

  // ---------- map value editing ----------
  function editApplied(m) {
    const vals = MSA.values(S.cur.bin, m); let mn = Infinity, mx = -Infinity;
    for (const row of vals) for (const v of row) { if (v < mn) mn = v; if (v > mx) mx = v; }
    m.min = mn; m.max = mx; m.flat = mn === mx;
    if (S.ref) S.cmp = MSA.compare(S.cur.bin, S.ref.bin, S.cur.info);
    renderCk(); renderList();
  }
  // ---------- cell selection + box operations ----------
  const flat = (m, r, c) => r * m.n2 + c;
  function rect(r0, c0, r1, c1) { const s = new Set(); for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) s.add(flat(S.sel, r, c)); return s; }
  function paintSel() { const m = S.sel; if (!m) return; $('tablewrap').querySelectorAll('td.ed').forEach(td => td.classList.toggle('msel', S.cells.has(flat(m, +td.dataset.r, +td.dataset.c)))); updateSelCount(); }
  function updateSelCount() { const el = $('selcount'); if (el) el.textContent = S.cells.size ? S.cells.size + ' cell' + (S.cells.size > 1 ? 's' : '') + ' selected' : 'no cells selected'; }
  function recompMinMax(m) { const vals = MSA.values(S.cur.bin, m); let mn = Infinity, mx = -Infinity; for (const row of vals) for (const v of row) { if (v < mn) mn = v; if (v > mx) mx = v; } m.min = mn; m.max = mx; m.flat = mn === mx; }
  function afterEdit(maps) { maps.forEach(recompMinMax); if (S.ref) S.cmp = MSA.compare(S.cur.bin, S.ref.bin, S.cur.info); renderCk(); renderList(); renderMap(); }
  // Parse a typed value (physical units when in Units mode and a quantity is known, else raw) into a raw 16-bit int.
  function typedToRaw(qkey, s) {
    const v = parseFloat(s); if (isNaN(v)) return null;
    if (S.phys && qkey) { const q = MSA.Q[qkey]; return Math.round((v - q.off) / q.f) & 0xFFFF; }
    return Math.round(v) & 0xFFFF;
  }
  function applyOp(op) {
    if (!S.sel) return;
    const val = parseFloat($('opv').value);
    if (isNaN(val)) return toast('Type a number in the box first.');
    if (!S.cells.size) return toast('Select cells first - click, drag, or ctrl / shift-click.');
    const maps = [S.sel];
    for (const m of maps) {
      const q = (S.phys && m.dq) ? MSA.Q[m.dq] : null;   // operate in the displayed unit
      const lo = m.signed ? -32768 : 0, hi = m.signed ? 32767 : 65535, clamp = v => Math.max(lo, Math.min(hi, Math.round(v)));
      for (const idx of S.cells) {
        const r = Math.floor(idx / m.n2), c = idx % m.n2, raw = MSA.w16(S.cur.bin, m.dataAddr + 2 * idx), cur = m.signed ? MSA.s16(raw) : raw;
        const nv = op === 'set' ? (q ? (val - q.off) / q.f : val) : op === 'add' ? cur + (q ? val / q.f : val) : cur - (q ? val / q.f : val);
        MSA.setValue(S.cur.bin, m, r, c, clamp(nv) & 0xFFFF);
      }
    }
    afterEdit(maps);
  }
  function inlineEdit(cell, startVal, write) {
    // Freeze the cell's measured width before replacing its text. Without
    // this, the input's intrinsic width can make the whole map table expand
    // dramatically while editing a value.
    const width = cell.getBoundingClientRect().width;
    cell.classList.add('editing');
    cell.style.width = width + 'px'; cell.style.minWidth = width + 'px'; cell.style.maxWidth = width + 'px';
    const inp = document.createElement('input'); inp.value = startVal; inp.autocomplete = 'off';
    inp.style.width = '76px'; inp.style.minWidth = '76px'; inp.style.maxWidth = '76px';
    cell.textContent = ''; cell.appendChild(inp); inp.focus(); inp.select();
    let done = false;
    const commit = keep => { if (done) return; done = true; if (keep) write(inp.value); else renderMap(); };
    inp.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); } };
    inp.onblur = () => commit(true);
  }
  function editCell(td) {
    const m0 = S.sel, r = +td.dataset.r, c = +td.dataset.c, raw = MSA.w16(S.cur.bin, m0.dataAddr + 2 * flat(m0, r, c)), cur = m0.signed ? MSA.s16(raw) : raw;
    inlineEdit(td, fmtQ(cur, m0.dq), v => { const rw = typedToRaw(m0.dq, v); if (rw == null) return renderMap(); MSA.setValue(S.cur.bin, m0, r, c, rw); afterEdit([m0]); });
  }
  function editAxis(th) {
    const m0 = S.sel, axis = th.dataset.axis, k = +th.dataset.k, qkey = axis === 'col' ? m0.q2 : m0.q1, cur = axis === 'col' ? m0.ax2[k] : m0.ax1[k];
    inlineEdit(th, fmtQ(cur, qkey), v => { const rw = typedToRaw(qkey, v); if (rw == null) return renderMap(); MSA.setAxisValue(S.cur.bin, m0, axis, k, rw); renderCk(); renderMap(); });
  }
  function renameSelected() {
    if (!S.sel) return;
    const name = window.prompt('Map name:', S.sel.name);
    if (name === null) return;
    const clean = name.trim(); if (!clean) return toast('Enter a map name.');
    S.sel.name = clean; S.sel.identified = true; S.sel.sure = true; S.sel.source = 'user';
    renderList(); renderMap();
  }
  function correspondingMap(prev, bi) { const maps = S.cur.info.blocks[bi].maps; if (!maps.length) return null; if (prev) { const byName = maps.find(x => x.name === prev.name); if (byName) return byName; if (maps[prev.index]) return maps[prev.index]; } return maps[0]; }

  function select(block, index) {
    S.block = block; S.sel = S.cur.info.blocks[block].maps[index];
    setView('map'); render();
    const n = $('list').querySelector('.sel'); if (n) n.scrollIntoView({ block: 'nearest' });
  }

  // ---------- events ----------
  $('bOpen').onclick = $('bOpen2').onclick = () => $('fOpen').click();
  $('bCmp').onclick = () => $('fCmp').click();
  $('fOpen').onchange = e => { const f = [...e.target.files]; e.target.value = ''; openFiles(f); };
  $('fCmp').onchange = e => { const f = [...e.target.files]; e.target.value = ''; openCompare(f); };
  $('tIQset').onclick = () => { const v = parseInt($('tIQ').value, 10); if (isNaN(v) || v <= 0) return toast('Enter a Max IQ value in mg.'); afterTune('Max IQ ' + v + ' mg', MSA.setMaxIQ(S.cur.bin, S.cur.info, v, scopeBlocks())); };
  $('tRPMset').onclick = () => { const v = parseInt($('tRPM').value, 10); if (isNaN(v) || v <= 0) return toast('Enter a hard-cut RPM.'); afterTune('Hard-cut ' + v + ' rpm', MSA.setRevLimit(S.cur.bin, S.cur.info, v, scopeBlocks())); };
  $('tEGR').onclick = () => afterTune('EGR off (850 mg)', MSA.egrOff(S.cur.bin, S.cur.info, 850, scopeBlocks()));
  $('t3bar').onclick = () => afterTune('3-bar mod', MSA.set3bar(S.cur.bin, S.cur.info, scopeBlocks()));
  $('tAuto').onclick = autoStage1;
    // ---------- scope (All code blocks checkbox) ----------
  const allBlocks = () => { const cb = $('allCB'); return !!cb && cb.checked; };
  function scopeBlocks() { return allBlocks() ? S.cur.info.blocks : [S.cur.info.blocks[S.block]].filter(Boolean); }
  const tKey = e => { if (e.key === 'Enter') e.target.nextElementSibling.nextElementSibling.click(); };
  $('tIQ').onkeydown = $('tRPM').onkeydown = tKey;
  $('blocks').addEventListener('wheel', e => { if (e.deltaY && !e.shiftKey) { $('blocks').scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  $('bSaveBin').onclick = saveBin; $('bSaveChips').onclick = saveChips; $('bFix').onclick = fixChecksums;
  // Cell selection (drag / ctrl / shift) + double-click to type. The #tablewrap element persists across renders.
  let selDrag = null;
  $('tablewrap').addEventListener('mousedown', e => {
    const td = e.target.closest('td.ed'); if (!td || td.querySelector('input') || !S.sel) return;
    e.preventDefault();
    const m = S.sel, r = +td.dataset.r, c = +td.dataset.c, k = flat(m, r, c);
    if (e.ctrlKey || e.metaKey) { S.cells.has(k) ? S.cells.delete(k) : S.cells.add(k); S.anchor = { r, c }; }
    else if (e.shiftKey && S.anchor) { S.cells = rect(S.anchor.r, S.anchor.c, r, c); }
    else { S.anchor = { r, c }; S.cells = new Set([k]); selDrag = { r, c }; }
    paintSel();
  });
  $('tablewrap').addEventListener('mouseover', e => {
    if (!selDrag || !S.sel) return;
    const td = e.target.closest('td.ed'); if (!td) return;
    S.cells = rect(selDrag.r, selDrag.c, +td.dataset.r, +td.dataset.c); paintSel();
  });
  window.addEventListener('mouseup', () => { selDrag = null; });
  $('tablewrap').addEventListener('dblclick', e => {
    const td = e.target.closest('td.ed'), th = e.target.closest('th.axh');
    if (td) editCell(td); else if (th) editAxis(th);
  });
  $('mhead').addEventListener('keydown', e => { if (e.target.id === 'opv' && e.key === 'Enter') { e.preventDefault(); applyOp('set'); } });
  $('blocks').onclick = e => { const b = e.target.closest('button'); if (b) { const prev = S.sel; S.block = +b.dataset.b; S.sel = correspondingMap(prev, S.block); render(); } };
  $('views').onclick = e => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); };
  $('list').onclick = e => {
    const fold = e.target.closest('[data-fold]');
    if (fold) { S.foldOther[S.block] = !S.foldOther[S.block]; renderList(); return; }
    const it = e.target.closest('.it'); if (it) select(S.block, +it.dataset.i);
  };
  $('q').oninput = renderList; $('onlyChg').onchange = renderList;
  $('mhead').onclick = e => { const b = e.target.closest('button'); if (!b || b.disabled) return; if (b.dataset.rename) { renameSelected(); return; } if (b.dataset.op) { applyOp(b.dataset.op); return; } if (b.dataset.m) S.mode = b.dataset.m; if (b.dataset.p) S.phys = b.dataset.p === '1'; renderMap(); };
  $('p-changes').onclick = e => { const r = e.target.closest('tr.click'); if (r) select(+r.dataset.b, +r.dataset.i); };
  window.addEventListener('resize', drawChart);
  $('segViz').onclick = e => { const b = e.target.closest('button'); if (b && !b.disabled) { S.viz = b.dataset.z; S.hoverRow = null; S.hover3d = null; clearHl(); drawChart(); } };
  $('mhead').addEventListener('input', e => { if (e.target.id === 'opv') S.opv = e.target.value; });
  window.addEventListener('contextmenu', e => e.preventDefault());
  let rotDrag = null;
  $('chart').addEventListener('mousemove', e => {
    if (!S.sel || S.view !== 'map') return;
    if (rotDrag) { S.rot.az = rotDrag.az + (e.clientX - rotDrag.x) * 0.01; S.rot.el = Math.max(0.12, Math.min(1.45, rotDrag.el - (e.clientY - rotDrag.y) * 0.01)); drawChart(); return; }
    const [mx, my] = chartXY(e);
    if (S.viz === '3d' && chartHit && chartHit.type === '3d') {
      const v = nearestVert3D(mx, my), key = v ? v.r + '_' + v.c : null, had = S.hover3d ? S.hover3d.r + '_' + S.hover3d.c : null;
      if (key !== had) { S.hover3d = v ? { r: v.r, c: v.c } : null; v ? hlCell(v.r, v.c) : clearHl(); drawChart(); }
    } else if (chartHit && chartHit.type === '2d') {
      const i = nearestSeries2D(mx, my);
      if (i !== S.hoverRow) { S.hoverRow = i; i != null ? hlRow(i) : clearHl(); drawChart(); }
    }
  });
  $('chart').addEventListener('mousedown', e => { if (S.viz === '3d') { rotDrag = { x: e.clientX, y: e.clientY, az: S.rot.az, el: S.rot.el }; e.preventDefault(); } });
  window.addEventListener('mouseup', () => { rotDrag = null; });
  $('chart').addEventListener('mouseleave', () => { if (rotDrag) return; S.hoverRow = null; S.hover3d = null; clearHl(); drawChart(); });
  document.addEventListener('keydown', e => {
    if (!S.cur || !S.sel || e.target.tagName === 'INPUT' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const items = [...$('list').querySelectorAll('.it')], i = items.findIndex(n => n.classList.contains('sel')), n = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (n) { e.preventDefault(); select(S.block, +n.dataset.i); }
  });
  let drag = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); drag++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--drag <= 0) { drag = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); drag = 0; document.body.classList.remove('dragging'); if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files); });

  // Keep the launcher alive while this window is open, and let it exit when the window closes.
  if (location.protocol.startsWith('http')) {
    const ping = () => fetch('/ping', { cache: 'no-store' }).catch(() => {});
    ping(); setInterval(ping, 5000);
    window.addEventListener('pagehide', () => navigator.sendBeacon && navigator.sendBeacon('/bye'));
  }
  render();
})();
