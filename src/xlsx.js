// A minimal .xlsx reader — no dependencies.
//
// Why not a library: an .xlsx is a zip of XML, and the only parts we need are the
// shared-string table, one worksheet, and the hyperlink relationships. Node 22 ships
// zlib, which is the only hard part of reading a zip, so the whole thing is ~200
// lines and adds nothing to the dependency tree.
//
// Why hyperlinks matter here: in his sheet the cell TEXT is often just "Link", and
// the actual URL lives in the worksheet's relationship file. 13,593 of his cells are
// like that — every Airbnb page, every Drive photo folder, every Zillow listing. A
// plain CSV export throws all of them away, which is why we read the .xlsx itself.

const zlib = require('zlib');

// ---- zip -------------------------------------------------------------------
// Read the central directory and inflate the entries we ask for. We look the entries
// up by name rather than walking local headers, because the local header's size
// fields can be zeroed out when a data descriptor is used.
function readZip(buf) {
  // End of central directory: signature 0x06054b50, scanned from the back because it
  // is followed by a variable-length comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record)');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // Zip64: when the counts are saturated the real values live in the zip64 EOCD.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {           // zip64 locator
        const z64 = Number(buf.readBigUInt64LE(i + 8));
        if (buf.readUInt32LE(z64) === 0x06064b50) {       // zip64 EOCD
          count = Number(buf.readBigUInt64LE(z64 + 32));
          cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
        }
        break;
      }
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method    = buf.readUInt16LE(p + 10);
    const compSize  = buf.readUInt32LE(p + 20);
    const nameLen   = buf.readUInt16LE(p + 28);
    const extraLen  = buf.readUInt16LE(p + 30);
    const cmtLen    = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name      = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // zip64 extended information, when the 32-bit fields are saturated
    if (localOffset === 0xffffffff) {
      const exStart = p + 46 + nameLen;
      let q = exStart;
      while (q + 4 <= exStart + extraLen) {
        const id = buf.readUInt16LE(q), sz = buf.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (buf.readUInt32LE(p + 24) === 0xffffffff) r += 8;   // uncompressed
          if (buf.readUInt32LE(p + 20) === 0xffffffff) r += 8;   // compressed
          localOffset = Number(buf.readBigUInt64LE(r));
          break;
        }
        q += 4 + sz;
      }
    }
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      // The local header repeats the name/extra lengths; the data starts after them.
      const lh = e.localOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('Bad local header for ' + name);
      const nLen = buf.readUInt16LE(lh + 26);
      const xLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + nLen + xLen;
      const raw = buf.subarray(start, start + e.compSize);
      return e.method === 0 ? raw : zlib.inflateRawSync(raw);
    },
  };
}

// ---- xml helpers ------------------------------------------------------------
function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&');
}

// Concatenate every <t> run inside a fragment (a shared string can be split across
// several runs when parts of it are styled differently).
function textRuns(fragment) {
  let out = '', q = 0;
  for (;;) {
    const a = fragment.indexOf('<t', q);
    if (a === -1) break;
    const close = fragment.indexOf('>', a);
    if (close === -1) break;
    if (fragment[close - 1] === '/') { q = close + 1; continue; }   // <t/>
    const b = fragment.indexOf('</t>', close);
    if (b === -1) break;
    out += fragment.slice(close + 1, b);
    q = b + 4;
  }
  return unescapeXml(out);
}

function colToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

// Excel serial date -> ISO date. Day 1 is 1900-01-01, and Excel's deliberate
// 1900-leap-year bug means serials above 59 are one day ahead.
function serialToDate(n) {
  if (!(n > 0) || n > 60000) return null;
  const days = n > 59 ? n - 1 : n;
  const ms = Date.UTC(1900, 0, 1) + (days - 1) * 86400000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ---- the reader -------------------------------------------------------------
// Returns { headers: [...], rows: [[{v, link}, ...], ...] } where every cell carries
// both its displayed value and the hyperlink behind it, if any.
function readSheet(buffer, { sheetIndex = 0, maxRows = 100000 } = {}) {
  const zip = readZip(buffer);

  // shared strings
  const shared = [];
  const ssBuf = zip.read('xl/sharedStrings.xml');
  if (ssBuf) {
    const ss = ssBuf.toString('utf8');
    let p = 0;
    for (;;) {
      const a = ss.indexOf('<si>', p);
      if (a === -1) break;
      const b = ss.indexOf('</si>', a);
      if (b === -1) break;
      shared.push(textRuns(ss.slice(a + 4, b)));
      p = b + 5;
    }
  }

  // which worksheet part to read
  const sheetNames = zip.names()
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));
  const sheetName = sheetNames[sheetIndex];
  if (!sheetName) throw new Error('No worksheet found in workbook');
  const sheet = zip.read(sheetName).toString('utf8');

  // hyperlinks: cell ref -> target URL, resolved through the worksheet's rels
  const links = new Map();
  const relName = sheetName.replace(/worksheets\/(sheet\d+)\.xml$/, 'worksheets/_rels/$1.xml.rels');
  const relBuf = zip.read(relName);
  if (relBuf) {
    const relXml = relBuf.toString('utf8');
    const rel = new Map();
    const rre = /<Relationship\b([^>]*)\/?>/g;
    let rm;
    while ((rm = rre.exec(relXml)) !== null) {
      const attrs = rm[1];
      const id = (attrs.match(/\bId="([^"]+)"/) || [])[1];
      const target = (attrs.match(/\bTarget="([^"]*)"/) || [])[1];
      if (id && target) rel.set(id, unescapeXml(target));
    }
    const hi = sheet.indexOf('<hyperlinks');
    if (hi !== -1) {
      const hj = sheet.indexOf('</hyperlinks>', hi);
      const hsec = sheet.slice(hi, hj === -1 ? sheet.length : hj);
      const hre = /<hyperlink\b([^>]*)\/?>/g;
      let hm;
      while ((hm = hre.exec(hsec)) !== null) {
        const attrs = hm[1];
        const ref = (attrs.match(/\bref="([^"]+)"/) || [])[1];
        const rid = (attrs.match(/r:id="([^"]+)"/) || [])[1];
        if (!ref) continue;
        // Either an external target via r:id, or an in-workbook `location`.
        const url = rid ? rel.get(rid) : null;
        if (!url) continue;
        // A ref can be a range (A1:A9); apply the link to each cell in it.
        if (ref.includes(':')) {
          const [s, e] = ref.split(':');
          const sm = s.match(/^([A-Z]+)(\d+)$/), em = e.match(/^([A-Z]+)(\d+)$/);
          if (sm && em) {
            for (let r = +sm[2]; r <= +em[2] && r - +sm[2] < 5000; r++) {
              for (let c = colToIndex(sm[1]); c <= colToIndex(em[1]); c++) links.set(`${c}:${r}`, url);
            }
          }
        } else {
          const m = ref.match(/^([A-Z]+)(\d+)$/);
          if (m) links.set(`${colToIndex(m[1])}:${+m[2]}`, url);
        }
      }
    }
  }

  // Which style ids are date formats — needed to tell 46043 (a date) from 46043 (a
  // number). We only look at the built-in date formats plus any custom format whose
  // code contains y/m/d outside of quotes.
  const dateStyles = new Set();
  const stBuf = zip.read('xl/styles.xml');
  if (stBuf) {
    const st = stBuf.toString('utf8');
    const customDate = new Set();
    const nre = /<numFmt\b([^>]*)\/?>/g;
    let nm;
    while ((nm = nre.exec(st)) !== null) {
      const id = (nm[1].match(/numFmtId="(\d+)"/) || [])[1];
      const code = (nm[1].match(/formatCode="([^"]*)"/) || [])[1] || '';
      if (id && /[ymd]/i.test(code.replace(/"[^"]*"/g, '')) && !/[#0]/.test(code)) customDate.add(+id);
    }
    const BUILTIN = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
    const xi = st.indexOf('<cellXfs');
    if (xi !== -1) {
      const xj = st.indexOf('</cellXfs>', xi);
      const xfs = st.slice(xi, xj === -1 ? st.length : xj);
      const xre = /<xf\b([^>]*?)(?:\/>|>)/g;
      let xm, idx = 0;
      while ((xm = xre.exec(xfs)) !== null) {
        const fid = +((xm[1].match(/numFmtId="(\d+)"/) || [])[1] ?? -1);
        if (BUILTIN.has(fid) || customDate.has(fid)) dateStyles.add(idx);
        idx++;
      }
    }
  }

  // Walk cells. Index-based rather than a big regex, because the sheet can be tens of
  // megabytes and a lazy quantifier over that backtracks badly.
  const rows = [];
  let headers = [];
  let pos = sheet.indexOf('<sheetData');
  if (pos === -1) return { headers, rows };
  let curRow = 0;
  let rowCells = [];

  const flush = () => {
    if (curRow === 1) {
      headers = [];
      for (const [ci, cell] of rowCells) headers[ci] = cell.v;
    } else if (rowCells.length && rows.length < maxRows) {
      const arr = [];
      let any = false;
      for (const [ci, cell] of rowCells) {
        arr[ci] = cell;
        if (cell.v != null && cell.v !== '') any = true;
      }
      if (any) rows.push(arr);
    }
    rowCells = [];
  };

  for (;;) {
    const rowTag = sheet.indexOf('<row ', pos);
    const cellTag = sheet.indexOf('<c ', pos);
    if (rowTag !== -1 && (cellTag === -1 || rowTag < cellTag)) {
      flush();
      const end = sheet.indexOf('>', rowTag);
      const rm = sheet.slice(rowTag, end).match(/\br="(\d+)"/);
      curRow = rm ? +rm[1] : curRow + 1;
      pos = end + 1;
      continue;
    }
    if (cellTag === -1) break;

    const end = sheet.indexOf('>', cellTag);
    const attrs = sheet.slice(cellTag, end);
    const selfClosing = sheet[end - 1] === '/';
    const refM = attrs.match(/\br="([A-Z]+)(\d+)"/);
    const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || null;
    const style = (attrs.match(/\bs="(\d+)"/) || [])[1];
    const ci = refM ? colToIndex(refM[1]) : -1;

    if (selfClosing) { pos = end + 1; continue; }
    const close = sheet.indexOf('</c>', end);
    if (close === -1) break;
    const inner = sheet.slice(end + 1, close);
    pos = close + 4;
    if (ci < 0) continue;

    let v = null;
    if (type === 'inlineStr') {
      v = textRuns(inner) || null;
    } else {
      const va = inner.indexOf('<v>');
      if (va !== -1) {
        const vb = inner.indexOf('</v>', va);
        const raw = unescapeXml(inner.slice(va + 3, vb));
        if (type === 's') v = shared[+raw] ?? null;
        else if (type === 'b') v = raw === '1' ? 'Yes' : 'No';
        else if (raw === '') v = null;
        else {
          // A bare number that is styled as a date is a date.
          const asNum = Number(raw);
          const iso = (style != null && dateStyles.has(+style) && Number.isFinite(asNum))
            ? serialToDate(asNum) : null;
          v = iso || raw;
        }
      }
    }

    const link = links.get(`${ci}:${refM ? +refM[2] : curRow}`) || null;
    if (v == null && !link) continue;
    rowCells.push([ci, { v: v == null ? null : String(v).trim() || null, link }]);
  }
  flush();

  return { headers: headers.map(h => (h == null ? '' : String(h).trim())), rows };
}

module.exports = { readSheet, readZip };
