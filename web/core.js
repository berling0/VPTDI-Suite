// MSA15.5 core logic: chip merge/split, identification, automatic map finder, compare.
// Runs in the browser (window.MSA) and in Node (module.exports) so it can be tested headless.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MSA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLOCK = 0x8000;        // MSA15.5 data blocks are 32 KB
  const MIN_BLOCK_MAPS = 15;   // a 32 KB block with at least this many maps is a data block
  const MIN_BLOCK_COVER = 0x800; // ...covering at least 2 KB
  const MAX_AXIS = 40;

  const w16 = (b, o) => b[o] | (b[o + 1] << 8);
  const s16 = v => (v >= 0x8000 ? v - 0x10000 : v);
  const hex = (v, n) => v.toString(16).toUpperCase().padStart(n || 4, '0');

  // ---------- chips ----------
  // Combined file = 16-bit little-endian words: even offsets come from the L chip, odd from the H chip.
  function merge(L, H) {
    if (L.length !== H.length) throw new Error('Chip files have different sizes (' + L.length + ' and ' + H.length + ' bytes).');
    const out = new Uint8Array(L.length * 2);
    for (let i = 0; i < L.length; i++) { out[2 * i] = L[i]; out[2 * i + 1] = H[i]; }
    return out;
  }
  function split(bin) {
    if (bin.length % 2) throw new Error('File has an odd size, cannot split into two chips.');
    const n = bin.length / 2, L = new Uint8Array(n), H = new Uint8Array(n);
    for (let i = 0; i < n; i++) { L[i] = bin[2 * i]; H[i] = bin[2 * i + 1]; }
    return { L, H };
  }
  function equal(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // Bosch stamps each chip with its own tag: "...<8 chars>L" / "...<8 chars>H" framed by AA55 words.
  // In a single chip this is a run of 8 printable chars followed by 'L' or 'H' right after a 55/AA byte.
  function chipMarker(chip) {
    const lim = Math.min(chip.length, 0x10000) - 12;
    for (let i = 0x4000; i < lim; i++) {
      if ((chip[i] === 0x55 || chip[i] === 0xAA) && chip[i + 1] === 0x41) {
        let ok = true;
        for (let k = 1; k <= 8; k++) { const c = chip[i + k]; if (c < 0x30 || c > 0x5A) { ok = false; break; } }
        const t = chip[i + 9];
        if (ok && (t === 0x4C || t === 0x48)) return t === 0x4C ? 'L' : 'H';
      }
    }
    return null;
  }
  function nameHint(name) {
    const n = (name || '').toUpperCase();
    if (/LLL|LOW|EVEN|(^|[^A-Z])L([^A-Z]|$)/.test(n)) return 'L';
    if (/HHH|HIGH|ODD|(^|[^A-Z])H([^A-Z]|$)/.test(n)) return 'H';
    return null;
  }
  // Decide which of two chip dumps is L and which is H, then merge.
  function autoMerge(a, b, nameA, nameB) {
    if (a.length !== b.length) throw new Error('The two chip files must be the same size (got ' + a.length + ' and ' + b.length + ' bytes).');
    const ma = chipMarker(a), mb = chipMarker(b);
    let lFirst = null, reason = '';
    if (ma && mb && ma !== mb) { lFirst = ma === 'L'; reason = 'chip tags inside the dumps (L / H)'; }
    if (lFirst === null) {
      const s1 = countMaps(merge(a, b)), s2 = countMaps(merge(b, a));
      if (s1 !== s2 && Math.max(s1, s2) >= MIN_BLOCK_MAPS) { lFirst = s1 > s2; reason = 'map structure (' + Math.max(s1, s2) + ' maps found in this order, ' + Math.min(s1, s2) + ' in the other)'; }
    }
    if (lFirst === null) {
      const ha = nameHint(nameA), hb = nameHint(nameB);
      if (ha && hb && ha !== hb) { lFirst = ha === 'L'; reason = 'file names'; }
    }
    const sure = lFirst !== null;
    if (!sure) { lFirst = true; reason = 'could not verify the order - used the order the files were given'; }
    const bin = lFirst ? merge(a, b) : merge(b, a);
    return { bin, lFirst, sure, reason, same: equal(a, b) };
  }

  // ---------- map finder ----------
  // A map is stored as:  [axis id][count][axis values...]  ( [axis id][count][axis values...] )  [data...]
  // axis id = RAM address of the input variable (>= 0xC000), axis values strictly increasing.
  function axisAt(b, o, lim, ids, minN) {
    if (o + 4 > lim) return null;
    const id = w16(b, o), n = w16(b, o + 2);
    if (id < 0xC000) return null;
    if (ids && !ids.has(id)) return null;
    if (n < minN || n > MAX_AXIS || o + 4 + 2 * n > lim) return null;
    const v = new Array(n);
    let prev = -Infinity;
    for (let k = 0; k < n; k++) { const x = s16(w16(b, o + 4 + 2 * k)); if (x <= prev) return null; v[k] = x; prev = x; }
    return { id, n, v, end: o + 4 + 2 * n };
  }
  function findInRange(b, start, end) {
    const ids = new Map();
    for (let o = start; o < end - 8; o += 2) { const a = axisAt(b, o, end, null, 3); if (a) ids.set(a.id, (ids.get(a.id) || 0) + 1); }
    const maps = [];
    let o = start;
    while (o < end - 8) {
      const a = axisAt(b, o, end, ids, 2);
      if (!a) { o += 2; continue; }
      const a2 = axisAt(b, a.end, end, ids, 1);
      let m;
      if (a2 && a2.end + 2 * a.n * a2.n <= end) m = { addr: o, id1: a.id, n1: a.n, ax1: a.v, id2: a2.id, n2: a2.n, ax2: a2.v, dataAddr: a2.end, end: a2.end + 2 * a.n * a2.n };
      else if (a.end + 2 * a.n <= end) m = { addr: o, id1: a.id, n1: a.n, ax1: a.v, id2: null, n2: 1, ax2: [], dataAddr: a.end, end: a.end + 2 * a.n };
      else { o += 2; continue; }
      maps.push(m); o = m.end;
    }
    fillGaps(b, start, end, maps);
    return { maps, ids };
  }
  // Small curves whose axis variable is used nowhere else (e.g. the 2-point sensor linearisation) are missed above,
  // because their id cannot be confirmed statistically. Accept them when they sit exactly against the next found map.
  function fillGaps(b, start, end, maps) {
    for (let i = maps.length; i >= 1; i--) {
      const ge = maps[i - 1].addr;
      let gs = i >= 2 ? maps[i - 2].end : start, limit = ge, added = true;
      while (added) {
        added = false;
        for (let o = limit - 12; o >= gs; o -= 2) {
          const a = axisAt(b, o, limit, null, 2);
          if (!a || a.end + 2 * a.n !== limit) continue;
          maps.splice(i - 1, 0, { addr: o, id1: a.id, n1: a.n, ax1: a.v, id2: null, n2: 1, ax2: [], dataAddr: a.end, end: limit });
          limit = o; added = true; break;
        }
      }
    }
  }
  // Program code throws up a few short false hits, so a data block needs both enough maps and enough bytes covered by them.
  function isDataBlock(maps) {
    let cover = 0; for (const m of maps) cover += m.end - m.addr;
    return maps.length >= MIN_BLOCK_MAPS && cover >= MIN_BLOCK_COVER;
  }
  function countMaps(bin) {
    let t = 0;
    for (let s = 0; s + BLOCK <= bin.length; s += BLOCK) { const maps = findInRange(bin, s, s + BLOCK).maps; if (isDataBlock(maps)) t += maps.length; }
    return t;
  }
  function rawData(bin, m) {
    const n = m.n1 * m.n2, d = new Array(n);
    for (let k = 0; k < n; k++) {
      if (m.byte) d[k] = bin[m.dataAddr + k];
      else { const o = m.dataAddr + 2 * k; d[k] = m.be ? ((bin[o] << 8) | bin[o + 1]) : w16(bin, o); }
    }
    return d;
  }
  function values(bin, m) {      // rows = axis 1, columns = axis 2
    const raw = rawData(bin, m), rows = [];
    for (let r = 0; r < m.n1; r++) { const row = []; for (let c = 0; c < m.n2; c++) { const v = raw[r * m.n2 + c]; row.push(m.signed ? s16(v) : v); } rows.push(row); }
    return rows;
  }

  // Early EDC1.3.3/MSA12 calibration tables are byte-packed and do not have
  // the MSA15 RAM-axis headers. These are the common 1Z/90 hp table locations
  // documented for the 64 KiB family; only add a table when its full byte
  // range is present and it is not an erased/filler region.
  const MSA12_MAPS = [
    { addr: 0x659A, name: 'MAP sensor linearisation', n1: 1, n2: 16, q1: 'mv', dq: 'mbar' },
    { addr: 0x6996, name: 'Torque limiter', n1: 19, n2: 1, q1: 'rpm', dq: 'iq12' },
    { addr: 0x6D26, name: 'MAP correction', n1: 16, n2: 1, q1: 'boost', dq: 'factor' },
    { addr: 0x6E12, name: 'Start of injection (1)', n1: 8, n2: 8, q1: 'temp', q2: 'iq12', dq: 'soi' },
    { addr: 0x6F22, name: 'Start of injection (2)', n1: 8, n2: 8, q1: 'temp', q2: 'iq12', dq: 'soi' },
    { addr: 0x7224, name: 'N146 Pump voltage map', n1: 14, n2: 16, q1: 'rpm', q2: 'iq12', dq: 'pump' },
    { addr: 0x741A, name: 'Drivers wish', n1: 8, n2: 12, q1: 'rpm', q2: 'pedal', dq: 'iq12' },
    { addr: 0x7620, name: 'Smoke limiter', n1: 10, n2: 16, q1: 'rpm', q2: 'maf', dq: 'iq12' },
    { addr: 0x7716, name: 'Start IQ', n1: 8, n2: 8, q1: 'temp', q2: 'iq12', dq: 'iq12' },
    { addr: 0x7822, name: 'Inverse driver wish', n1: 8, n2: 12, q1: 'rpm', q2: 'iq12', dq: 'pedal' }
  ];
  function findMSA12Maps(bin) {
    const maps = [];
    for (const s of MSA12_MAPS) {
      const end = s.addr + s.n1 * s.n2;
      if (end > bin.length) continue;
      const d = bin.slice(s.addr, end);
      let same = true; for (let i = 1; i < d.length; i++) if (d[i] !== d[0]) { same = false; break; }
      if (same || d.every(v => v === 0xFF)) continue;
      const m = Object.assign({ addr: s.addr, dataAddr: s.addr, end, id1: null, id2: null, n1: s.n1, n2: s.n2, ax1: [], ax2: [], byte: true, identified: true, sure: true, source: 'MSA12 map references' }, s);
      m.min = Math.min(...d); m.max = Math.max(...d); m.flat = m.min === m.max; m.dq = s.dq || null;
      maps.push(m);
    }
    return maps;
  }

  // ---------- naming ----------
  const Q = {
    rpm: { name: 'Engine speed', unit: 'rpm', f: 1, off: 0, dec: 0 },
    temp: { name: 'Temperature', unit: '°C', f: 0.1, off: -273.1, dec: 0 },
    pedal: { name: 'Pedal position', unit: '%', f: 0.01, off: 0, dec: 0 },
    atm: { name: 'Atmospheric pressure', unit: 'mbar', f: 1, off: 0, dec: 0 },
    maf: { name: 'Air mass', unit: 'mg/stroke', f: 0.1, off: 0, dec: 0 },
    iq: { name: 'Injection quantity', unit: 'mg/stroke', f: 0.01, off: 0, dec: 1 },
    iq12: { name: 'Injection quantity (MSA12)', unit: 'mg/stroke', f: 0.2, off: 0, dec: 1 },
    mbar: { name: 'Pressure', unit: 'mbar', f: 1, off: 0, dec: 0 },
    boost: { name: 'Boost pressure', unit: 'mbar', f: 1, off: 0, dec: 0 },
    dev: { name: 'Boost control deviation ?', unit: 'mbar', f: 1, off: 0, dec: 0 },
    mv: { name: 'MAP sensor voltage', unit: 'mV', f: 1, off: 0, dec: 0 },
    volt: { name: 'Battery voltage ?', unit: 'V', f: 0.01, off: 0, dec: 2 },
    duty: { name: 'N75 duty cycle', unit: '%', f: 0.01, off: 0, dec: 1 },
    factor: { name: 'Factor', unit: '%', f: 0.01, off: 0, dec: 1 },
    mafraw: { name: 'MAF sensor signal', unit: 'raw', f: 1, off: 0, dec: 0 },
    soi: { name: 'Start of injection', unit: 'raw', f: 1, off: 0, dec: 0 },
    // N146 pump-voltage tables store an ADC/DAC command in raw units. The
    // verified software variants use approximately 1.221 mV per count.
    pump: { name: 'N146 pump voltage', unit: 'mV', f: 1.221, off: 0, dec: 0 },
    gain: { name: 'Controller gain', unit: 'raw', f: 1, off: 0, dec: 0 },
    corr: { name: 'Correction', unit: 'raw', f: 1, off: 0, dec: 0 },
    time: { name: 'Time', unit: 'raw', f: 1, off: 0, dec: 0 },
    torq: { name: 'Torque', unit: 'raw', f: 1, off: 0, dec: 0 }
  };
  // Axis variables identified on the 028906021GK / GL software. Other software falls back to heuristics.
  const KNOWN_IDS = {
    0xC1D0: 'pedal', 0xC22E: 'atm', 0xDC18: 'maf', 0xC2D0: 'iq', 0xDEDC: 'iq', 0xC222: 'iq', 0xDD30: 'iq', 0xDDD8: 'iq',
    0xDC16: 'boost', 0xDC14: 'boost', 0xDF4A: 'mv', 0xDE10: 'mafraw', 0xC210: 'dev', 0xC00A: 'volt'
  };
  function axisQuantity(id, v, rpmId) {
    if (id === null) return null;
    if (id === rpmId) return 'rpm';
    if (v.length >= 2 && v[0] >= 2231 && v[v.length - 1] <= 4231) return 'temp';
    const known = KNOWN_IDS[ALIAS[id] || id];
    if (known) return known;
    // Axis addresses move between the early MSA15 software generations.  The
    // physical ranges are stable, however, and are a safer fallback than
    // displaying every shifted address as "var Cxxx".
    if (v.length >= 6 && v[0] === 0 && v[v.length - 1] === 10000) return 'pedal';
    if (v.length >= 8 && v[0] >= 0 && v[v.length - 1] <= 5200) return 'iq';
    if (v.length >= 8 && v[0] >= 700 && v[v.length - 1] <= 2800) return 'boost';
    if (v.length >= 8 && v[0] >= 2000 && v[v.length - 1] <= 12000) return 'maf';
    return null;
  }
  // Built-in map list. Sources: the user's map pack for 0281001656 / 028906021GL, and the forum map lists for
  // 038906018P / 0281001720 (checked against dump_ori.bin). A map is recognised by its two axis variables, its
  // size and its position among maps with the same axes, so it is found again in every code block and in other
  // software versions, even when the addresses move.   id1 = row axis (n1 points), id2 = column axis (n2 points).
  const E = 0xE08A, C22E = 0xC22E, T = 0xC002, T2 = 0xC004;
  const SIGS = [
    { name: 'MAF correction by temp', id1: E, id2: T, n1: 8, n2: 8, ord: 1, q1: 'rpm', q2: 'temp', dq: 'corr' },
    { name: 'Drivers wish', id1: E, id2: 0xC1D0, n1: 16, ord: 1, q2: 'pedal', dq: 'iq' },
    { name: 'EGR', id1: E, id2: 0xDD30, n1: 16, ord: 1, q2: 'iq', dq: 'maf' },
    { name: 'Start IQ', id1: E, id2: T, n1: 8, n2: 9, ord: 1, q2: 'temp', dq: 'iq' },
    { name: 'Torque limiter', id1: C22E, id2: E, n1: 3, ord: 1, q1: 'atm', dq: 'iq' },
    { name: 'Smoke limiter', id1: E, id2: 0xDC18, n1: 16, ord: 1, q2: 'maf', dq: 'iq' },
    { name: 'MAP smoke limiter', id1: E, id2: 0xDC16, n1: 16, n2: 13, ord: 1, q2: 'boost', dq: 'iq' },
    { name: 'MAP smoke limiter correction', id1: 0xDC14, id2: 0xDC12, n1: 16, ord: 1, q1: 'boost', q2: 'temp', dq: 'factor' },
    { name: 'N146 Pump voltage map', id1: E, id2: 0xC222, n1: 16, ord: 1, q2: 'iq', dq: 'pump' },
    { name: 'Boost target map (1)', id1: E, id2: 0xC2D0, n1: 16, n2: 10, ord: 1, q2: 'iq', dq: 'boost' },
    { name: 'Boost target map (2)', id1: E, id2: 0xC2D0, n1: 16, n2: 10, ord: 2, q2: 'iq', dq: 'boost' },
    { name: 'Boost limit', id1: C22E, id2: E, n1: 10, ord: 1, q1: 'atm', dq: 'boost' },
    { name: 'Desired boost correction (LDR)', id1: C22E, id2: 0xC2D0, n1: 9, n2: 9, ord: 1, q1: 'atm', q2: 'iq', dq: 'boost' },
    { name: 'Desired boost correction factor', id1: T2, id2: null, n1: 7, ord: 2, q1: 'temp', dq: 'factor' },
    { name: 'N75 duty (1)', id1: E, id2: 0xDDD8, n1: 16, ord: 1, q2: 'iq', dq: 'duty' },
    { name: 'N75 duty (2)', id1: E, id2: 0xDDD8, n1: 16, ord: 2, q2: 'iq', dq: 'duty' },
    { name: 'N75 PID P', id1: 0xC210, id2: null, n1: 16, ord: 1, q1: 'dev', dq: 'gain' },
    { name: 'N75 PID I', id1: 0xC210, id2: null, n1: 16, ord: 2, q1: 'dev', dq: 'gain' },
    { name: 'N75 PID D', id1: 0xC210, id2: null, n1: 16, ord: 3, q1: 'dev', dq: 'gain' },
    { name: 'N75 PID Dt1', id1: 0xC210, id2: null, n1: 16, ord: 4, q1: 'dev', dq: 'time' },
    { name: 'N75 lower limit', id1: E, id2: null, n1: 16, ord: 2, q1: 'rpm', dq: 'duty' },
    { name: 'N75 upper limit', id1: E, id2: null, n1: 16, ord: 3, q1: 'rpm', dq: 'duty' },
    { name: 'Air Mass conversion Raw value', id1: E, id2: 0xDE10, n1: 10, n2: 14, ord: 2, q1: 'rpm', q2: 'mafraw', dq: 'maf' },
    { name: 'Map linearization', id1: 0xDF4A, id2: null, n1: 2, ord: 1, q1: 'mv', dq: 'boost' },
    { name: 'Starting torque characteristic', id1: E, id2: null, n1: 11, ord: 1, q1: 'rpm', dq: 'iq' },
    { name: 'Start RPM', id1: T, id2: null, n1: 2, ord: 1, v: [500, 2000], q1: 'temp', dq: 'rpm' },
    { name: 'Idle RPM', id1: T, id2: null, n1: 2, ord: 2, v: [500, 2000], q1: 'temp', dq: 'rpm' },
    { name: 'Glow plug preheating', id1: 0xC00A, id2: 0xDD96, n1: 2, ord: 1, q1: 'volt', q2: 'temp', dq: 'time' },
    { name: 'Glow plug post heating', id1: T, id2: null, n1: 4, ord: 1, q1: 'temp', dq: 'time' },
    { name: 'SOI limiter temp', id1: E, id2: 0xC2A0, n1: 13, n2: 7, ord: 1, q1: 'rpm', q2: 'temp', dq: 'corr' },
    { name: 'SOI related curve (1)', id1: 0xC2A0, id2: null, n1: 8, ord: 1, q1: 'temp', dq: 'soi' },
    { name: 'SOI related curve (2)', id1: 0xC2A0, id2: null, n1: 8, ord: 2, q1: 'temp', dq: 'soi' },
    { name: 'SOI correction map 1', id1: E, id2: 0xDEDC, n1: 10, n2: 10, ord: 1, q2: 'iq', dq: 'soi' },
    { name: 'SOI correction map 2', id1: E, id2: 0xDEDC, n1: 14, n2: 7, ord: 1, q2: 'iq', dq: 'soi' },
    { name: 'SOI correction map 3', id1: E, id2: 0xDEDC, n1: 14, n2: 7, ord: 2, q2: 'iq', dq: 'soi' },
    { name: 'SOI correction 2 factor', id1: T2, id2: null, n1: 5, ord: 1, q1: 'temp', dq: 'factor' },
    { name: 'SOI correction 3 factor', id1: C22E, id2: null, n1: 5, ord: 1, q1: 'atm', dq: 'factor' },
    { name: 'Start of injection', id1: E, id2: 0xDEDC, n1: 16, n2: 13, ord: 1, q2: 'iq', dq: 'soi' },
    { name: 'IQ to Airmass', id1: E, id2: 0xDEDC, n1: 16, n2: 10, ord: 1, q2: 'iq', dq: 'maf' }
  ];
  // The same variable carries a different id in some software versions (P-family vs G-family).
  // Known relocations of the same logical RAM variables.  The first two are
  // used by the P/AS and GH/GS generations; the others occur in the older
  // BF/BD and later BL/BM images supplied with the project.  Unknown IDs are
  // still handled by the range-based axis classifier above.
  const ALIAS = {
    0xC2A2: 0xC2A0, 0xC2D4: 0xC2D0,
    0xC2AC: 0xC2A0, 0xC2D8: 0xC2D0, 0xC2F0: 0xC2D0,
    0xC2BE: 0xC2A0, 0xC2FE: 0xC2A0,
    0xC2AE: 0xC2A0, 0xC2FA: 0xC2A0,
    0xC238: 0xC22E, 0xC264: 0xC22E,
    0xC1F2: 0xC1D0, 0xC1F4: 0xC1D0,
    0xC21C: 0xC210, 0xC244: 0xC210,
    0xC262: 0xDC16
  };
  const nid = id => (id === null ? null : ALIAS[id] || id);
  const sigMatch = (m, sg) => nid(m.id1) === sg.id1 && nid(m.id2) === sg.id2 && m.n1 === sg.n1 && (!sg.n2 || m.n2 === sg.n2) && (!sg.v || (m.min >= sg.v[0] && m.max <= sg.v[1]));
  const within = (a, lo, hi) => a.length > 0 && a[0] >= lo && a[a.length - 1] <= hi;
  function nameMaps(bin, maps, rpmId) {
    for (const m of maps) {
      const raw = rawData(bin, m);
      m.signed = raw.some(v => v >= 0xC000);
      const d = raw.map(v => (m.signed ? s16(v) : v));
      let min = Infinity, max = -Infinity; for (const v of d) { if (v < min) min = v; if (v > max) max = v; }
      m.min = min; m.max = max; m.flat = min === max; m.d = d;
      m.q1 = axisQuantity(m.id1, m.ax1, rpmId); m.q2 = axisQuantity(m.id2, m.ax2, rpmId);
      m.dq = null; m.name = null; m.sure = false; m.source = null;
    }
    let hits = 0;
    for (const sg of SIGS) {
      const m = maps.filter(x => sigMatch(x, sg))[sg.ord - 1];
      if (!m || m.name) continue;
      m.name = sg.name; m.sure = true; m.source = 'pack'; m.dq = sg.dq || null; if (sg.q1) m.q1 = sg.q1; if (sg.q2) m.q2 = sg.q2; hits++;
    }
    // Keep the signature names, but also run the shape recogniser for every
    // dump.  A partial signature match is normal in the other MSA15
    // generations and must not suppress recognition of the remaining maps.
    heuristicNames(maps);
    for (const m of maps) {
      delete m.d;
      m.identified = !!m.name;
      if (m.name) continue;
      const ax = (q, id) => (q ? Q[q].name : 'var ' + hex(id));
      m.name = m.id2 !== null ? 'Map ' + m.n2 + 'x' + m.n1 + '  (' + ax(m.q1, m.id1) + ' × ' + ax(m.q2, m.id2) + ')' : 'Curve ' + m.n1 + 'x1  (' + ax(m.q1, m.id1) + ')';
    }
  }
  function heuristicNames(maps) {
    const count = {};
    for (const m of maps) {
      if (m.name) continue; // signature names are more specific than shape guesses
      const is3d = m.id2 !== null, a1 = m.ax1, a2 = m.ax2, min = m.min, max = m.max;
      let name = null;
      // Torque limiter identification is value/axis based.  Some early
      // MSA15.5 files use a 16x16 RPM x IQ table instead of the later
      // 3x25-style table.  The limiter output has a high torque-value range,
      // while its first RPM rows contain a lower plateau followed by a higher
      // plateau.  Empty zero-filled tables (for example in BD originals) do
      // not pass this test and must not be offered as a hardcut target.
      const torque16 = is3d && m.q1 === 'rpm' && m.q2 === 'iq' && m.n1 === 16 && m.n2 === 16 &&
        a1[a1.length - 1] >= 4000 && a2[a2.length - 1] >= 3000 && min >= 2500 && max >= 6500 && max <= 9000 &&
        m.d.slice(0, m.n2).some(v => v >= 3000 && v <= 5000) &&
        m.d.slice(m.n2, Math.min(m.d.length, 5 * m.n2)).some(v => v >= 6500);
      if (torque16) {
        name = 'Torque limiter'; m.dq = 'iq'; m.sure = true;
      } else if (is3d && m.q1 === 'rpm' && m.n1 >= 12 && m.n2 >= 6 && m.n2 <= 10 && a2[a2.length - 1] === 10000 && a2[0] >= 0 && max >= 3000 && max <= 6500) {
        name = 'Drivers wish'; m.q2 = 'pedal'; m.dq = 'iq'; m.sure = true;
      } else if (is3d && m.n1 <= 4 && within(a1, 400, 1200) && m.q2 === 'rpm' && m.n2 >= 12 && max >= 2000 && max <= 6000) {
        name = 'Torque limiter'; m.q1 = 'atm'; m.dq = 'iq'; m.sure = true;
      } else if (is3d && m.q1 === 'rpm' && m.n1 >= 12 && m.n2 >= 8 && within(a2, 2000, 12000) && min >= 0 && max >= 2000 && max <= 6000) {
        name = 'Smoke limiter'; m.q2 = 'maf'; m.dq = 'iq'; m.sure = true;
      } else if (is3d && m.n1 >= 8 && within(a1, 500, 1600) && m.q2 === 'rpm' && m.n2 >= 8 && min >= 1500 && max <= 3200) {
        name = 'Boost limit'; m.q1 = 'atm'; m.dq = 'mbar'; m.sure = true;
      } else if (is3d && m.q1 === 'rpm' && m.n1 >= 12 && m.n2 >= 8 && m.n2 <= 12 && within(a2, 0, 5200) && min >= 100 && max >= 1200 && max <= 2700) {
        name = 'Boost target map'; m.q2 = m.q2 || 'iq'; m.dq = 'mbar'; m.sure = true;
      } else if (is3d && m.q1 === 'rpm' && m.n1 >= 14 && m.n2 >= 10 && within(a2, 0, 5200) && m.signed && min < 0 && max > 0 && max < 4000) {
        name = 'Start of injection'; m.q2 = m.q2 || 'iq';
      } else if (is3d && m.q1 === 'rpm' && m.n1 >= 14 && m.n2 >= 12 && within(a2, 0, 5200) && max >= 2500 && max <= 4800 && mostlyRising(m.d, m.n1, m.n2)) {
        name = 'N146 Pump voltage map'; m.q2 = m.q2 || 'iq';
      }
      if (name) { m.name = name; m.source = 'shape'; count[name] = (count[name] || 0) + 1; m.ord = count[name]; }
    }
    for (const m of maps) if (m.name) { if (count[m.name] > 1) m.name += ' (' + m.ord + ')'; if (!m.sure) m.name += ' ?'; }
  }
  function mostlyRising(d, n1, n2) {
    let ok = 0, tot = 0;
    for (let r = 0; r < n1; r++) for (let c = 1; c < n2; c++) { tot++; if (d[r * n2 + c] >= d[r * n2 + c - 1]) ok++; }
    return tot > 0 && ok / tot > 0.95;
  }


  // ---------- single-value constants ----------
  // Offsets are relative to the start of each code block (so the same row applies to CB2, CB3 and CB1).
  // P-family = 038906018P / 0281001720 (forum lists, every default value verified in dump_ori.bin).
  // G-family = 028906021GK / GL (same constants found by value in all code blocks of every dump; shifted offsets).
  // def = stock value, shown highlighted when a file differs.  fmt: u16 | u8 | pair (two bytes).  unit: iq100 | iq | mbar | rpm | rpmv.
  const C_NOTE = {
    coding: 'Last digit of the engine coding that selects this map set',
    sw: 'Smoke limiter source: 0x0000 = MAF based, 0x0101 = MAP based',
    boostlim: 'Single-value boost limiter',
    mapfac: 'MAP sensor multiplication factor',
    diagfac: 'Correction factor for fuel-quantity diagnostic data',
    pcfg: 'Pressure configuration, 2 bytes',
    iqmax: 'Max IQ limit (51 mg stock)', smokemax: 'Smoke limiter max IQ limit', wishmax: 'Driver wish max IQ limit', tqmax: 'Torque limiter max IQ limit',
    pbm: 'PBM-Datensatz-Eingriffsmenge: one of three limiters behind the 51 mg cap',
    siga: 'SIG-A upper M_E limit for the consumption signal to the dash',
    sigaconv: 'SIG-A conversion constant M_E/pulse for the consumption signal',
    sigaper: 'SIG-A averaging period of the consumption signal (62500)',
    sigamax: 'SIG-A maximum period of the TQ signal',
    sigadisp: 'Maximum consumption / display',
    ard: 'ARD (cruise control) maximum quantity, leading factor + difference',
    revlim: 'Engine overspeed fuel-cut threshold. Same value (5355) on the 66 kW and 81 kW software. Verify on your own car before flashing.'
  };
  const mk = (key, name, off, fmt, unit, def, inferred) => ({ key, name, off, fmt, unit, def, note: C_NOTE[key.replace(/\d+$/, '')] || '', inferred: !!inferred });
  const FAMILIES = [
    // These offsets are verified for the P/N software layout only.  Other
    // 038906018 variants (notably J/BM) have different constant locations.
    { id: 'P', name: '038906018P / 0281001720', re: /^038906018(?:P|N|AS)$/, consts: [
      mk('coding', 'Engine coding digit (map set)', 0x11E4, 'u16', 'raw'), mk('sw', 'MAF/MAP smoke limiter switch', 0x11DC, 'u16', 'hex', 0),
      mk('iqmax', 'Max IQ limit', 0x2D95, 'u8', 'iq', 51), mk('smokemax', 'Smoke limiter max IQ', 0x2E01, 'u8', 'iq', 51),
      mk('wishmax', 'Driver wish max IQ', 0x2DC1, 'u8', 'iq', 51), mk('tqmax', 'Torque limiter max IQ', 0x2E19, 'u8', 'iq', 51),
      mk('pbm', 'PBM data set intervention quantity', 0x1242, 'u16', 'iq100', 5100), mk('ard', 'ARD maximum quantity', 0x4DDC, 'u16', 'iq100', 5100),
      mk('siga', 'SIG-A upper M_E limit', 0x195C, 'u16', 'iq100', 5100), mk('sigaconv', 'SIG-A conversion M_E/pulse', 0x195E, 'u16', 'raw', 5448),
      mk('sigaper', 'SIG-A averaging period', 0x1960, 'u16', 'raw', 62500), mk('sigamax', 'SIG-A max period TQ signal', 0x1962, 'u16', 'raw', 9441),
      mk('sigadisp', 'Max consumption / display', 0x1964, 'u16', 'raw', 6231), mk('diagfac', 'Diagnostic fuel-quantity factor', 0x2C24, 'u16', 'raw', 500),
      mk('mapfac', 'MAP sensor factor', 0x2C18, 'u16', 'raw', 980), mk('pcfg1', 'Pressure configuration 1', 0x2DA4, 'pair', 'raw', '18,255'),
      mk('pcfg2', 'Pressure configuration 2', 0x2DA8, 'pair', 'raw', '18,255'), mk('pcfg3', 'Pressure configuration 3', 0x2DD0, 'pair', 'raw', '18,255'),
      mk('boostlim', 'Single-value boost limiter', 0x5234, 'u16', 'mbar', 1990),
      { key: 'idle1', name: 'Idle RPM, hot (candidate)', off: 0x4BC4, fmt: 'u16', unit: 'rpm', note: 'Idle speed candidate (0x4BC4/4BC6/4BC8)', inferred: true },
      { key: 'idle2', name: 'Idle RPM, candidate 2', off: 0x4BC6, fmt: 'u16', unit: 'rpm', note: 'see above', inferred: true },
      { key: 'idle3', name: 'Idle RPM, candidate 3', off: 0x4BC8, fmt: 'u16', unit: 'rpm', note: 'see above', inferred: true },
      { key: 'idle4', name: 'Defective-idle RPM', off: 0x4BE2, fmt: 'u16', unit: 'rpm', note: 'Defective idle RPM (0x4BE2)' },
      { key: 'idleac', name: 'Idle RPM with A/C on', off: 0x5212, fmt: 'u16', unit: 'rpm', note: 'Idle with climate control on' },
      { key: 'idleht', name: 'Idle RPM, cold antifreeze heating', off: 0x600E, fmt: 'u16', unit: 'rpm', note: 'Idle with cold-antifreeze heating on' },
      { key: 'idlea', name: 'RPM constant (0x64C4)', off: 0x64C4, fmt: 'u16', unit: 'rpm', note: 'One of four further RPM constants' },
      { key: 'idleb', name: 'RPM constant (0x64CA)', off: 0x64CA, fmt: 'u16', unit: 'rpm', note: 'One of four further RPM constants' },
      { key: 'idlec', name: 'RPM constant (0x64D0)', off: 0x64D0, fmt: 'u16', unit: 'rpm', note: 'One of four further RPM constants' },
      { key: 'idled', name: 'RPM constant (0x6516)', off: 0x6516, fmt: 'u16', unit: 'rpm', note: 'One of four further RPM constants' }
    ] },
    // GH/JG share the verified G-family constant layout; GS/FS/FQ do not.
    { id: 'G', name: '028906021GK / GL', re: /^028906021(?:GK|GL|GH|JG)$/, consts: [
      mk('coding', 'Engine coding digit (map set)', 0x11D6, 'u16', 'raw'), mk('sw', 'MAF/MAP smoke limiter switch', 0x11CE, 'u16', 'hex', 0, true),
      mk('iqmax', 'Max IQ limit', 0x2E4F, 'u8', 'iq', 51), mk('smokemax', 'Smoke limiter max IQ', 0x2EBB, 'u8', 'iq', 51),
      mk('wishmax', 'Driver wish max IQ', 0x2E7B, 'u8', 'iq', 51), mk('tqmax', 'Torque limiter max IQ', 0x2ED3, 'u8', 'iq', 51),
      mk('pbm', 'PBM data set intervention quantity', 0x1234, 'u16', 'iq100', 5100), mk('ard', 'ARD maximum quantity', 0x4E64, 'u16', 'iq100', 5100),
      mk('siga', 'SIG-A upper M_E limit', 0x194C, 'u16', 'iq100', 5100), mk('sigaconv', 'SIG-A conversion M_E/pulse', 0x194E, 'u16', 'raw', 5448),
      mk('sigaper', 'SIG-A averaging period', 0x1950, 'u16', 'raw', 62500), mk('sigamax', 'SIG-A max period TQ signal', 0x1952, 'u16', 'raw', 9441),
      mk('sigadisp', 'Max consumption / display', 0x1954, 'u16', 'raw', 6231), mk('diagfac', 'Diagnostic fuel-quantity factor', 0x2CDE, 'u16', 'raw', 500),
      mk('mapfac', 'MAP sensor factor', 0x2CD2, 'u16', 'raw', 980), mk('pcfg1', 'Pressure configuration 1', 0x2E5E, 'pair', 'raw', '18,255'),
      mk('pcfg2', 'Pressure configuration 2', 0x2E62, 'pair', 'raw', '18,255'), mk('pcfg3', 'Pressure configuration 3', 0x2E8A, 'pair', 'raw', '18,255'),
      mk('boostlim', 'Single-value boost limiter', 0x52BC, 'u16', 'mbar')
    ] }
  ];
  // BM and J use the same four one-byte IQ caps and MAP configuration
  // meanings, but their code-generation offsets are different from P.  Keep
  // this profile deliberately narrow until the remaining single-value
  // locations are verified; this enables Max IQ and 3-bar safely without
  // inventing values for unrelated constants.
  const pConst = FAMILIES[0].consts;
  const profile = (id, name, re, offsets) => ({
    id, name, re,
    consts: Object.keys(offsets).map(key => {
      const base = pConst.find(c => c.key === key);
      return Object.assign({}, base, { off: offsets[key] });
    })
  });
  FAMILIES.push(
    profile('BM', '038906018BM', /^038906018BM$/, {
      iqmax: 0x2FBB, smokemax: 0x3027, wishmax: 0x2FE7, tqmax: 0x303F,
      mapfac: 0x2E28, pcfg1: 0x2FCA, pcfg2: 0x2FCE, pcfg3: 0x2FF6
    }),
    profile('BT', '038906018BT', /^038906018BT$/, {
      iqmax: 0x2FBB, smokemax: 0x3027, wishmax: 0x2FE7, tqmax: 0x303F,
      mapfac: 0x2E28, pcfg1: 0x2FCA, pcfg2: 0x2FCE, pcfg3: 0x2FF6
    }),
    profile('J', '038906018J', /^038906018J$/, {
      iqmax: 0x2D7B, smokemax: 0x2DE7, wishmax: 0x2DA7, tqmax: 0x2DFF,
      mapfac: 0x2C16, pcfg1: 0x2D8A, pcfg2: 0x2D8E, pcfg3: 0x2DB6
    }),
    profile('AN', '038906018AN', /^038906018AN$/, {
      iqmax: 0x2D7B, smokemax: 0x2DE7, wishmax: 0x2DA7, tqmax: 0x2DFF,
      mapfac: 0x2C16, pcfg1: 0x2D8A, pcfg2: 0x2D8E, pcfg3: 0x2DB6
    }),
    profile('AE', '038906018AE', /^038906018AE$/, {
      iqmax: 0x2FBB, smokemax: 0x3027, wishmax: 0x2FE7, tqmax: 0x303F,
      mapfac: 0x2E28, pcfg1: 0x2FCA, pcfg2: 0x2FCE, pcfg3: 0x2FF6
    }),
    profile('D', '038906018D', /^038906018D$/, {
      iqmax: 0x2D7B, smokemax: 0x2DE7, wishmax: 0x2DA7, tqmax: 0x2DFF,
      pbm: 0x1276, siga: 0x1994, sigaconv: 0x1996, sigaper: 0x1998,
      sigamax: 0x199A, sigadisp: 0x199C, diagfac: 0x2C22,
      mapfac: 0x2C16, pcfg1: 0x2D8A, pcfg2: 0x2D8E, pcfg3: 0x2DB6
    }),
    profile('BL', '038906018BL', /^038906018BL$/, {
      iqmax: 0x2FBB, smokemax: 0x3027, wishmax: 0x2FE7, tqmax: 0x303F,
      siga: 0x1A2E, sigaconv: 0x1A30, sigaper: 0x1A32, sigamax: 0x1A34,
      sigadisp: 0x1A36, diagfac: 0x2E34,
      mapfac: 0x2E28, pcfg1: 0x2FCA, pcfg2: 0x2FCE, pcfg3: 0x2FF6
    }),
  profile('BD', '028906021BD', /^028906021BD$/, {
      iqmax: 0x3043, smokemax: 0x30AF, wishmax: 0x306F, tqmax: 0x30C7,
      mapfac: 0x2EC6, pcfg1: 0x3052, pcfg2: 0x3056, pcfg3: 0x307E
    }),
    profile('EM', '028906021EM', /^028906021EM$/, {
      iqmax: 0x3043, smokemax: 0x30AF, wishmax: 0x306F, tqmax: 0x30C7,
      mapfac: 0x2EC6, pcfg1: 0x3052, pcfg2: 0x3056, pcfg3: 0x307E
    }),
    profile('GM', '028906021GM', /^028906021GM$/, {
      iqmax: 0x2E4F, smokemax: 0x2EBB, wishmax: 0x2E7B, tqmax: 0x2ED3,
      mapfac: 0x2CD2, pcfg1: 0x2E5E, pcfg2: 0x2E62, pcfg3: 0x2E8A
    })
  );
  function familyOf(info) {
    const part = info && info.ident ? info.ident.part : '';
    return FAMILIES.find(f => f.re.test(part)) || null;
  }
  function readConst(bin, base, c) {
    const o = base + c.off;
    if (o + (c.fmt === 'u8' ? 1 : 2) > bin.length) return null;
    return c.fmt === 'u8' ? bin[o] : c.fmt === 'pair' ? bin[o] + ',' + bin[o + 1] : w16(bin, o);
  }
  function fmtConst(c, v) {
    if (v === null || v === undefined) return '-';
    if (c.fmt === 'pair') return String(v).replace(',', ' / ');
    if (c.unit === 'iq100') return v + ' (' + (v / 100).toFixed(2) + ' mg)';
    if (c.unit === 'iq') return v + ' mg';
    if (c.unit === 'mbar') return v + ' mbar';
    if (c.unit === 'rpm') return v + ' rpm';
    if (c.unit === 'hex') return '0x' + hex(v, 4);
    return String(v);
  }
  // Values of every constant in every code block. `info` supplies the layout; `bin` may be a second file of the same layout.
  function constants(bin, info) {
    const fam = familyOf(info);
    if (!fam) return null;
    return {
      family: fam.name,
      rows: fam.consts.map(c => {
        const vals = info.blocks.map(b => readConst(bin, b.start, c));
        return { key: c.key, name: c.name, off: c.off, fmt: c.fmt, size: c.fmt === 'u8' ? 1 : 2, note: c.note, inferred: c.inferred, def: c.def, vals, text: vals.map(v => fmtConst(c, v)), changed: c.def !== undefined && vals.some(v => v !== null && String(v) !== String(c.def)) };
      })
    };
  }
  function constAt(info, addr) {
    const fam = familyOf(info);
    if (!fam) return null;
    for (const b of info.blocks) if (addr >= b.start && addr < b.end) { const rel = addr - b.start; const c = fam.consts.find(k => rel >= k.off && rel < k.off + (k.fmt === 'u8' ? 1 : 2)); return c ? c.name : null; }
    return null;
  }

  // ---------- identification ----------
  function strings(bin, start, end, minLen) {
    const out = []; let s = -1;
    for (let i = start; i <= end; i++) {
      const c = i < end ? bin[i] : 0, p = c >= 0x20 && c < 0x7F;
      if (p && s < 0) s = i;
      if (!p && s >= 0) { if (i - s >= minLen) out.push({ addr: s, text: String.fromCharCode.apply(null, bin.subarray(s, i)) }); s = -1; }
    }
    return out;
  }
  function identOf(bin, start, end) {
    for (const s of strings(bin, start, end, 20)) {
      if (/EDC|MSA/.test(s.text) && /\d{3}906\d{3}/.test(s.text)) {
        const t = s.text.replace(/^[^0-9]+/, '');
        const part = (t.match(/\d{3}906\d{3}[A-Z]{0,2}/) || [''])[0];
        const bosch = (t.match(/0281\d{6}/) || [''])[0];
        const gear = (t.match(/\b(SG|AG)\b/) || [null, ''])[1];
        const sw = (t.match(/\b(?:SG|AG)\s+(\d{4})\b/) || [null, ''])[1];
        const engine = (t.match(/\d,\dl\s+\S+/) || [''])[0];
        return { addr: s.addr, text: t.trim(), part, bosch, gear, sw, engine };
      }
    }
    // Early 64 KiB EDC1.3.3/MSA12 images store the identification fields as
    // short ASCII fragments separated by 0x00/0xFF bytes, so the normal long
    // printable-string scan cannot see them as one string.
    if (end - start <= 0x10000) {
      let text = '';
      for (let i = start; i < end; i++) text += bin[i] >= 0x20 && bin[i] < 0x7F ? String.fromCharCode(bin[i]) : ' ';
      const pm = text.match(/(\d{3}906\d{3}[A-Z]{0,2})/);
      if (pm) {
        const at = text.indexOf(pm[1]);
        const around = text.slice(Math.max(0, at - 16), at + 180).replace(/\s+/g, ' ').trim();
        const gear = (around.match(/\b(SG|AG)\b/) || [null, ''])[1];
        const sw = (around.match(/\b(?:SG|AG)\s+(\d{4})\b/) || [null, ''])[1];
        const engine = (around.match(/\d,\dl\s+\S+/) || [''])[0];
        return { addr: start + at, text: around, part: pm[1], bosch: '', gear, sw, engine };
      }
    }
    return null;
  }
  function ecuTypeOf(info) {
    const part = info && info.ident ? info.ident.part : '';
    if (info && info.size === 0x10000 && /^028906021/.test(part)) return 'EDC MSA12 / EDC1.3.3';
    if (/^03890601(?:3|8)/.test(part)) return 'EDC15V';
    if (info && info.size === 0x40000 && /^028906021/.test(part)) return 'MSA15.5';
    if (info && info.size === 0x40000 && /^03890601(?:3|8)/.test(part)) return 'EDC15V';
    return null;
  }
  const sum = (b, mask) => { let s = 0; for (let i = 0; i < b.length; i++) s = (s + b[i]) >>> 0; return mask ? s & mask : s; };

  function analyzeCore(bin) {
    const blocks = [];
    for (let s = 0; s + BLOCK <= bin.length; s += BLOCK) {
      const r = findInRange(bin, s, s + BLOCK);
      if (!isDataBlock(r.maps)) continue;
      let rpmId = null, best = 0;
      const c1 = new Map();
      for (const m of r.maps) for (const id of [m.id1, m.id2]) if (id !== null) c1.set(id, (c1.get(id) || 0) + 1);
      for (const [id, n] of c1) if (n > best) { best = n; rpmId = id; }
      nameMaps(bin, r.maps, rpmId);
      const ident = identOf(bin, s, s + BLOCK);
      const gear = ident && ident.gear;
      // Code block numbering as used by map packs for this ECU: CB1 at 0x38000, CB2 at 0x00000, CB3 at 0x08000.
      const cb = s === 0x38000 ? 'CB1' : s === 0 ? 'CB2' : s === 0x8000 ? 'CB3' : 'Block ' + hex(s, 5);
      const label = cb + (gear === 'SG' ? ' · Manual (SG)' : gear === 'AG' ? ' · Automatic (AG)' : '');
      r.maps.forEach((m, i) => { m.block = blocks.length; m.index = i; });
      blocks.push({
        start: s, end: s + BLOCK, label, cb, ident, maps: r.maps, rpmId,
        stored: hex(w16(bin, s + BLOCK - 2), 4) + hex(w16(bin, s + BLOCK - 4), 4)
      });
    }
    const chips = bin.length % 2 === 0 ? split(bin) : null;
    const ident = blocks.map(b => b.ident).find(Boolean) || identOf(bin, 0, bin.length);
    if (!blocks.length && bin.length === 0x10000 && (!ident || /^028906021/.test(ident.part))) {
      const maps = findMSA12Maps(bin);
      if (maps.length) {
        maps.forEach((m, i) => { m.block = 0; m.index = i; });
        blocks.push({ start: 0, end: bin.length, label: 'MSA12 · 8-bit calibration', cb: 'MSA12', ident, maps, rpmId: null, coding: null, stored: '' });
      }
    }
    const fam = FAMILIES.find(f => f.re.test(ident ? ident.part : ''));
    const cc = fam && fam.consts.find(c => c.key === 'coding');
    for (const b of blocks) b.coding = cc ? readConst(bin, b.start, cc) : null;
    const warnings = [];
    if (bin.length !== 0x40000) warnings.push('File is ' + bin.length + ' bytes. A full MSA15.5 dump (2 × 128 KB chips) is 262144 bytes.');
    if (bin.length === 0x10000 && ident && /^028906021/.test(ident.part)) warnings.push('This is a 64 KiB EDC MSA12 / EDC1.3.3 image; its byte-packed maps are shown with the MSA12 decoder.');
    if (!blocks.length) warnings.push('No map data block was found. This does not look like a combined (interleaved) MSA15.5 file.');
    if (chips && chipMarker(chips.L) === 'H' && chipMarker(chips.H) === 'L') warnings.push('The chip tags are swapped: this file looks like it was merged with HHH and LLL the wrong way round.');
    return {
      size: bin.length, blocks, ident, ecuType: ecuTypeOf({ size: bin.length, ident }), warnings, family: fam ? fam.name : null,
      sums: { file: hex(sum(bin, 0xFFFF), 4), L: chips ? hex(sum(chips.L, 0xFFFF), 4) : '', H: chips ? hex(sum(chips.H, 0xFFFF), 4) : '' },
      mapCount: blocks.reduce((t, b) => t + b.maps.length, 0)
    };
  }
  function endianScore(bin, be) {
    const ids = [0xE08A, 0xC002, 0xC022, 0xC252, 0xDC18, 0xC30C, 0xDD78];
    let n = 0;
    for (let i = 0; i + 1 < bin.length; i += 2) {
      const v = be ? (bin[i] << 8) | bin[i + 1] : bin[i] | (bin[i + 1] << 8);
      if (ids.includes(v)) n++;
    }
    return n;
  }
  function swap16(bin) {
    const out = bin.slice();
    for (let i = 0; i + 1 < out.length; i += 2) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; }
    return out;
  }
  function analyze(bin) {
    const be = endianScore(bin, true) > endianScore(bin, false) * 2 && endianScore(bin, true) >= 8;
    const info = analyzeCore(be ? swap16(bin) : bin);
    if (be) {
      for (const blk of info.blocks) for (const m of blk.maps) m.be = true;
      info.endian = 'big';
      info.warnings.push('This dump uses big-endian MSA15.5 word storage; map values are decoded and written back with that byte order.');
    } else info.endian = 'little';
    return info;
  }
  // A lone chip dump (half of the words) - used to tell the user the second chip is still missing.
  function looksLikeSingleChip(bin) {
    if (countMaps(bin) >= MIN_BLOCK_MAPS) return null;
    if (bin.length === 0x40000 && endianScore(bin, true) > endianScore(bin, false) * 2 && endianScore(bin, true) >= 8) return null;
    if (bin.length === 0x10000) return 'MSA15.1';
    return chipMarker(bin) || (bin.length === 0x20000 ? '?' : null);
  }

  // ---------- compare ----------
  function diffRegions(a, b, gap) {
    const n = Math.min(a.length, b.length), out = []; let s = -1, last = -1;
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) { if (s < 0) s = i; else if (i - last > (gap || 2)) { out.push({ start: s, end: last + 1 }); s = i; } last = i; }
    }
    if (s >= 0) out.push({ start: s, end: last + 1 });
    return out;
  }
  function mapChanged(a, b, m) { for (let i = m.addr; i < m.end; i++) if (a[i] !== b[i]) return true; return false; }
  // Changes in `cur` relative to `ref`: which maps differ, and which changed bytes sit outside every found map.
  function compare(cur, ref, info) {
    const res = { sameSize: cur.length === ref.length, changedBytes: 0, changedMaps: [], outside: [] };
    const all = [];
    for (const blk of info.blocks) for (const m of blk.maps) { m.changed = m.end <= ref.length && mapChanged(cur, ref, m); if (m.changed) res.changedMaps.push(m); all.push(m); }
    all.sort((x, y) => x.addr - y.addr);
    const n = Math.min(cur.length, ref.length);
    let mi = 0, s = -1, last = -1;
    const flush = () => { if (s >= 0) { res.outside.push({ start: s, end: last + 1 }); s = -1; } };
    for (let i = 0; i < n; i++) {
      if (cur[i] === ref[i]) continue;
      res.changedBytes++;
      while (mi < all.length && all[mi].end <= i) mi++;
      if (mi < all.length && all[mi].addr <= i) { flush(); continue; }
      if (s >= 0 && i - last > 8) flush();
      if (s < 0) s = i; last = i;
    }
    flush();
    for (const r of res.outside) {
      const blk = info.blocks.find(b => r.start >= b.start && r.start < b.end);
      const cn = constAt(info, r.start);
      r.note = blk && r.start >= blk.end - 4 ? 'Block checksum (' + blk.label + ')' : cn ? 'Constant: ' + cn + ' (' + (blk ? blk.label : '') + ')' : blk ? 'Data without axis header (' + blk.label + ')' : 'Outside the data blocks (program code)';
    }
    return res;
  }

  // ---------- block checksum (MSA15.5 / EDC15-P, family 1) ----------
  // Each 0x8000 code block ends with a 4-byte checksum at block_end-4, stored big-endian.
  // It is NOT a CRC: a custom dual 16-bit algorithm over [base+0x0B80, base+0x7FFB], two
  // accumulators (subtract-with-borrow, XOR, position-add, 16-bit rotations). The two 16-bit
  // results are byte-swapped and concatenated. Verified byte-exact against the Alientech
  // EcmAlgoDLL engine and against factory + tuned dumps for 028906021G* and 038906018*.
  const CK_SEED = { a: 0x8631, b: 0xEFCD, sub: 0x8631, rol: 0xEFCD };
  const CK_START = 0x0B80, CK_END = 0x7FFB; // relative to the block base
  const rol16 = (v, s) => { s &= 15; v &= 0xFFFF; return ((v << s) | (v >>> ((16 - s) & 31))) & 0xFFFF; };
  const ror16 = (v, s) => { s &= 15; v &= 0xFFFF; return ((v >>> s) | (v << ((16 - s) & 31))) & 0xFFFF; };
  // Returns the two 16-bit accumulators for the block starting at `base`.
  function blockChecksum(bin, base) {
    const start = base + CK_START, endIncl = base + CK_END, end = endIncl + 1;
    let a = CK_SEED.a, b = CK_SEED.b, borrow = 1, p = start, cnt = 0;
    while (p <= end) {
      if (cnt === 0x400) cnt = 0;
      a = (a ^ w16(bin, p)) & 0xFFFF;                         // A ^= word[p]
      { const e = rol16(a, b & 15); borrow = ((b & 15) !== 0 && a !== 0) ? (e & 1) : 0; a = e; }
      { const word = w16(bin, p + 2), oc = borrow;            // B = (B - word[p+2]) - borrow
        borrow = b < word ? 1 : (b !== word ? 0 : borrow);
        b = (b - word - oc) & 0xFFFF; }
      b = (b ^ a) & 0xFFFF;
      borrow = 1; p += 4; cnt += 2;
      if (p === end) break;
      if (cnt === 0x400) { cnt = 0; }
      else {
        const word = w16(bin, p), oc = borrow;                // A = (A - word[p]) - borrow
        borrow = a < word ? 1 : (a !== word ? 0 : borrow);
        a = (a - word - oc) & 0xFFFF;
        a = (a + ((p + 2) & 0x7FFF)) & 0xFFFF;                 // A += (p+2) & 0x7FFF
        b = (b ^ w16(bin, p + 2)) & 0xFFFF;                    // B ^= word[p+2]
        { const e = ror16(b, a & 15); borrow = a !== 0 ? ((e >>> 15) & 1) : 0; b = e; }
        cnt += 2;
      }
      p += 4;
    }
    a = (a - CK_SEED.sub) & 0xFFFF;
    a = (((end + 1) & 0xFFF) + a + 0x7000) & 0xFFFF;
    b = (b ^ rol16(CK_SEED.rol, CK_SEED.sub & 15)) & 0xFFFF;
    return { a, b };
  }
  // The 4 stored bytes for a block (big-endian, two byte-swapped halves).
  function checksumBytes(bin, base) {
    const { a, b } = blockChecksum(bin, base);
    return [a & 0xFF, (a >> 8) & 0xFF, b & 0xFF, (b >> 8) & 0xFF];
  }
  const ckHex = bytes => hex(bytes[3], 2) + hex(bytes[2], 2) + hex(bytes[0], 2) + hex(bytes[1], 2); // same layout as block.stored
  // Per-block status: stored vs. recomputed checksum. `info` comes from analyze().
  // A block's stored checksum matches what family-1 computes over `src`.
  function blockOk(src, blk) { const o = blk.end - 4, w = checksumBytes(src, blk.start); return src[o] === w[0] && src[o + 1] === w[1] && src[o + 2] === w[2] && src[o + 3] === w[3]; }
  function checksumStatus(bin, info, orig) {
    const blocks = info.blocks.map(blk => {
      const store = blk.end - 4, want = checksumBytes(bin, blk.start);
      const have = [bin[store], bin[store + 1], bin[store + 2], bin[store + 3]];
      return { label: blk.label, start: blk.start, store, ok: blockOk(bin, blk), stored: ckHex(have), computed: ckHex(want) };
    });
    // Support is determined from the immutable dump layout, not from whether
    // the current bytes still have a valid checksum. Editing a map naturally
    // makes the current checksum invalid; that must produce "needs fix", not
    // make the file become an unknown ECU. The 256 KiB size plus detected
    // 0x8000 data blocks also rejects the supplied older ROM formats.
    const supported = info.size === 0x40000 && blocks.length > 0 && info.endian !== 'big';
    return { supported, blocks, bad: blocks.filter(b => !b.ok).length, total: blocks.length };
  }
  // Returns a new image with every block checksum recomputed and written. Only touches the 4 bytes per block.
  function correctChecksums(bin, info) {
    const out = bin.slice(), st = { fixed: 0 };
    for (const blk of info.blocks) {
      const store = blk.end - 4, b = checksumBytes(out, blk.start);
      if (out[store] !== b[0] || out[store + 1] !== b[1] || out[store + 2] !== b[2] || out[store + 3] !== b[3]) st.fixed++;
      out[store] = b[0]; out[store + 1] = b[1]; out[store + 2] = b[2]; out[store + 3] = b[3];
    }
    return { out, fixed: st.fixed };
  }
  // Write one raw 16-bit value into a map cell (row r, column c). Mutates `bin`.
  function setValue(bin, m, r, c, raw) {
    const o = m.dataAddr + (m.byte ? (r * m.n2 + c) : 2 * (r * m.n2 + c)), v = raw & 0xFFFF;
    if (m.be && !m.byte) { bin[o] = (v >> 8) & 0xFF; bin[o + 1] = v & 0xFF; }
    else { bin[o] = v & 0xFF; if (!m.byte) bin[o + 1] = (v >> 8) & 0xFF; }
  }

  // ---------- one-click tuning ----------
  const famConst = (info, key) => { const f = familyOf(info); return f ? f.consts.find(c => c.key === key) || null : null; };
  // Write a named constant (see FAMILIES) into every code block. Returns number of blocks changed.
  function writeConst(bin, info, key, value, blocks) {
    const c = famConst(info, key); if (!c) return 0;
    let n = 0;
    for (const b of (blocks || info.blocks)) {
      const o = b.start + c.off;
      if (c.fmt === 'u8') { const v = value & 0xFF; if (bin[o] !== v) { bin[o] = v; n++; } }
      else if (c.fmt === 'pair') { const p = String(value).split(',').map(x => parseInt(x, 10) & 0xFF); if (bin[o] !== p[0] || bin[o + 1] !== p[1]) { bin[o] = p[0]; bin[o + 1] = p[1]; n++; } }
      else { const v = value & 0xFFFF; if (w16(bin, o) !== v) { bin[o] = v & 0xFF; bin[o + 1] = (v >> 8) & 0xFF; n++; } }
    }
    return n;
  }
  // Current value of a named constant (for prefilling the editors), read from the first block.
  function readConstValue(bin, info, key) {
    const c = famConst(info, key); return c && info.blocks.length ? readConst(bin, info.blocks[0].start, c) : null;
  }
  const hasConst = (info, key) => !!famConst(info, key);
  // Raise the injection-quantity caps (all default 51 mg / 5100) to `mg`.
  function setMaxIQ(bin, info, mg, blocks) {
    let n = 0;
    for (const k of ['iqmax', 'smokemax', 'wishmax', 'tqmax']) n += writeConst(bin, info, k, mg, blocks);  // u8, mg
    n += writeConst(bin, info, 'pbm', Math.round(mg * 100), blocks);                                        // u16, mg x 100
    return n;
  }
  // Hard-cut: on the Torque limiter map (the one that caps fuelling vs RPM), set the top of its engine-speed
  // axis to `rpm` and the breakpoint before it to rpm-20 (abrupt cut). Done in every code block.
  const isRevMap = m => /^Torque limiter/.test(m.name || '');
  function revAxisOf(m) {
    if (m.id2 === null) return null;
    if (m.q1 === 'rpm' && m.n1 >= 2) return { axis: 'row', n: m.n1 };
    if (m.q2 === 'rpm' && m.n2 >= 2) return { axis: 'col', n: m.n2 };
    return m.n2 >= 2 ? { axis: 'col', n: m.n2 } : m.n1 >= 2 ? { axis: 'row', n: m.n1 } : null;
  }
  function setRevLimit(bin, info, rpm, blocks) {
    let n = 0;
    for (const blk of (blocks || info.blocks)) for (const m of blk.maps) if (isRevMap(m)) {
      const a = revAxisOf(m); if (!a) continue;
      setAxisValue(bin, m, a.axis, a.n - 1, rpm); setAxisValue(bin, m, a.axis, a.n - 2, rpm - 20); n++;
    }
    return n;
  }
  // Current hard-cut RPM = the top of the Torque limiter's engine-speed axis (for prefilling the editor).
  function revLimitValue(info) {
    for (const blk of info.blocks) for (const m of blk.maps) if (isRevMap(m)) {
      const a = revAxisOf(m); if (a) return a.axis === 'col' ? m.ax2[a.n - 1] : m.ax1[a.n - 1];
    }
    return null;
  }
  // Write an axis breakpoint value ('row' = first axis, 'col' = second axis). Mutates bin and the cached map.
  function setAxisValue(bin, m, axis, k, raw) {
    const o = axis === 'col' ? (m.dataAddr - 2 * m.n2 + 2 * k) : (m.addr + 4 + 2 * k), v = raw & 0xFFFF;
    if (m.be) { bin[o] = (v >> 8) & 0xFF; bin[o + 1] = v & 0xFF; }
    else { bin[o] = v & 0xFF; bin[o + 1] = (v >> 8) & 0xFF; }
    if (axis === 'col') m.ax2[k] = s16(v); else m.ax1[k] = s16(v);
  }
  // 3-bar MAP sensor conversion (forum values for a 3 bar sensor).
  function set3bar(bin, info, blocks) {
    return writeConst(bin, info, 'mapfac', 851, blocks) + writeConst(bin, info, 'pcfg1', '8,118', blocks) + writeConst(bin, info, 'pcfg2', '8,118', blocks) + writeConst(bin, info, 'pcfg3', '8,118', blocks);
  }
  // EGR off: set the EGR map (requested air mass) to `val` in every block that has it. Returns maps changed.
  // `val` is in the map's displayed units (e.g. 850 mg air mass); converted to the raw stored value per map.
  function egrOff(bin, info, val, blocks) {
    let n = 0;
    for (const blk of (blocks || info.blocks)) for (const m of blk.maps) if (/^EGR\b/.test(m.name || '')) {
      const q = m.dq ? Q[m.dq] : null, raw = (q ? Math.round((val - q.off) / q.f) : val) & 0xFFFF;
      for (let r = 0; r < m.n1; r++) for (let c = 0; c < m.n2; c++) setValue(bin, m, r, c, raw);
      n++;
    }
    return n;
  }

  // Map pack text: one map per line,  "<data address hex> <name> <columns>x<rows>".
  function parseMapPack(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:0x)?([0-9A-Fa-f]{3,6})\s+(.+?)\s+(\d+)\s*[xX×]\s*(\d+)\s*$/);
      if (m) out.push({ addr: parseInt(m[1], 16), name: m[2].trim(), cols: +m[3], rows: +m[4] });
    }
    return out;
  }
  // Names the found maps after a user map pack. An entry matches a map by its data address (or header address).
  function applyMapPack(info, entries) {
    const res = { total: entries.length, matched: 0, sizeMismatch: [], missing: [] }, done = new Set();
    for (const e of entries) {
      let hit = null;
      for (const blk of info.blocks) { hit = blk.maps.find(m => m.dataAddr === e.addr) || blk.maps.find(m => m.addr === e.addr); if (hit) break; }
      if (!hit) { res.missing.push(e); continue; }
      if (!done.has(hit)) { res.matched++; done.add(hit); }
      hit.name = e.name; hit.identified = true; hit.sure = true; hit.source = 'file';
      const cols = hit.id2 !== null ? hit.n2 : hit.n1, rows = hit.id2 !== null ? hit.n1 : 1;
      if (cols !== e.cols || rows !== e.rows) res.sizeMismatch.push({ entry: e, cols, rows });
    }
    return res;
  }
  const dims = m => (m.id2 !== null ? m.n2 + 'x' + m.n1 : m.n1 + 'x1');   // columns x rows, as map packs write it
  function mapPackText(info) {
    const rows = [];
    for (const blk of info.blocks) for (const m of blk.maps) if (m.identified) rows.push(hex(m.dataAddr, 5) + ' ' + m.name.replace(/ \?$/, '') + ' ' + blk.cb + ' ' + dims(m));
    return rows.join('\r\n') + '\r\n';
  }
  function mapListCsv(info) {
    const rows = ['Block;Data address;Name;Columns;Rows;Column axis ID;Row axis ID;Header address;Min;Max'];
    for (const blk of info.blocks) for (const m of blk.maps)
      rows.push([blk.label, '0x' + hex(m.dataAddr, 5), m.name.replace(/;/g, ','), m.id2 !== null ? m.n2 : m.n1, m.id2 !== null ? m.n1 : 1, m.id2 === null ? hex(m.id1) : hex(m.id2), m.id2 === null ? '' : hex(m.id1), '0x' + hex(m.addr, 5), m.min, m.max].join(';'));
    return rows.join('\r\n') + '\r\n';
  }

  return { merge, split, equal, autoMerge, chipMarker, analyze, values, rawData, compare, diffRegions, looksLikeSingleChip, countMaps, mapListCsv, parseMapPack, applyMapPack, mapPackText, dims, constants, constAt, Q, hex, w16, s16, sum, blockChecksum, checksumBytes, checksumStatus, correctChecksums, setValue, setAxisValue, writeConst, readConstValue, hasConst, setMaxIQ, setRevLimit, revLimitValue, set3bar, egrOff };
});
