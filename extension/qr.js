// Tiny QR code generator (byte mode, error correction level M, versions 1 to 10).
// Written for Tab Lock so the extension has no outside dependencies.
// Usage: const modules = qrEncode("text"); // 2D array of booleans (true = dark)
//        qrToCanvas(canvas, modules, 6);

(function (global) {
  "use strict";

  // Level M block layout per version: [ecPerBlock, [blocks, dataCw], [blocks, dataCw]?]
  const LAYOUT_M = {
    1: [10, [1, 16]],
    2: [16, [1, 28]],
    3: [26, [1, 44]],
    4: [18, [2, 32]],
    5: [24, [2, 43]],
    6: [16, [4, 27]],
    7: [18, [4, 31]],
    8: [22, [2, 38], [2, 39]],
    9: [22, [3, 36], [2, 37]],
    10: [26, [4, 43], [1, 44]]
  };
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };
  const EC_FORMAT_M = 0; // format bits for level M

  // ---------- GF(256) and Reed-Solomon

  const EXP = new Array(512), LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) {
    return a && b ? EXP[LOG[a] + LOG[b]] : 0;
  }

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly; // leading coefficient 1
  }

  function rsRemainder(data, degree) {
    const gen = rsGenerator(degree);
    const res = new Array(degree).fill(0);
    for (const b of data) {
      const factor = b ^ res.shift();
      res.push(0);
      for (let i = 0; i < degree; i++) res[i] ^= gmul(gen[i + 1], factor);
    }
    return res;
  }

  // ---------- data encoding

  function utf8(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  function dataCapacity(version) {
    const [, g1, g2] = LAYOUT_M[version];
    return g1[0] * g1[1] + (g2 ? g2[0] * g2[1] : 0);
  }

  function chooseVersion(byteLen) {
    for (let v = 1; v <= 10; v++) {
      const ccBits = v < 10 ? 8 : 16;
      if (4 + ccBits + byteLen * 8 <= dataCapacity(v) * 8) return v;
    }
    throw new Error("Text too long for this QR generator");
  }

  function encodeData(bytes, version) {
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    const capBits = dataCapacity(version) * 8;
    put(0b0100, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, capBits - bits.length));
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      out.push(v);
    }
    for (let pad = 0xec; out.length < capBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
    return out;
  }

  function addErrorCorrection(data, version) {
    const [ecLen, g1, g2] = LAYOUT_M[version];
    const blocks = [];
    let k = 0;
    for (const g of [g1, g2]) {
      if (!g) continue;
      for (let b = 0; b < g[0]; b++) {
        const d = data.slice(k, k + g[1]);
        k += g[1];
        blocks.push({ d, e: rsRemainder(d, ecLen) });
      }
    }
    const out = [];
    const maxD = Math.max(...blocks.map(b => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
    return out;
  }

  // ---------- matrix

  function makeMatrix(version) {
    const size = version * 4 + 17;
    const m = [], fn = [];
    for (let y = 0; y < size; y++) {
      m.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }
    return { size, m, fn };
  }

  function setFn(q, x, y, dark) {
    q.m[y][x] = dark;
    q.fn[y][x] = true;
  }

  function drawFunctionPatterns(q, version) {
    const s = q.size;
    for (let i = 0; i < s; i++) {
      setFn(q, 6, i, i % 2 === 0);
      setFn(q, i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= s || y >= s) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(q, x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = ALIGN[version];
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFn(q, pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    drawFormat(q, 0); // reserve the format areas (real bits drawn later)
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = s - 11 + (i % 3), b = Math.floor(i / 3);
        setFn(q, a, b, bit);
        setFn(q, b, a, bit);
      }
    }
  }

  function drawFormat(q, mask) {
    const data = (EC_FORMAT_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const s = q.size;
    for (let i = 0; i <= 5; i++) setFn(q, 8, i, bit(i));
    setFn(q, 8, 7, bit(6));
    setFn(q, 8, 8, bit(7));
    setFn(q, 7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(q, 14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(q, s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(q, 8, s - 15 + i, bit(i));
    setFn(q, 8, s - 8, true); // always-dark module
  }

  function placeData(q, codewords) {
    const s = q.size;
    let i = 0;
    const total = codewords.length * 8;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          if (!q.fn[y][x] && i < total) {
            q.m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  ];

  function applyMask(q, mask) {
    const f = MASKS[mask];
    for (let y = 0; y < q.size; y++) {
      for (let x = 0; x < q.size; x++) {
        if (!q.fn[y][x] && f(x, y)) q.m[y][x] = !q.m[y][x];
      }
    }
  }

  // Standard penalty score (rules 1 to 4). Lower is better.
  function penalty(q) {
    const s = q.size, m = q.m;
    let score = 0;
    const line = (get) => {
      let p = 0, run = 1;
      for (let i = 1; i < s; i++) {
        if (get(i) === get(i - 1)) {
          run++;
        } else {
          if (run >= 5) p += run - 2;
          run = 1;
        }
      }
      if (run >= 5) p += run - 2;
      const pat = [true, false, true, true, true, false, true];
      for (let i = 0; i + 7 <= s; i++) {
        let match = true;
        for (let k = 0; k < 7; k++) if (get(i + k) !== pat[k]) { match = false; break; }
        if (!match) continue;
        const before = i >= 4 && [1, 2, 3, 4].every(k => !get(i - k));
        const after = i + 11 <= s && [7, 8, 9, 10].every(k => !get(i + k));
        if (before || after) p += 40;
      }
      return p;
    };
    for (let y = 0; y < s; y++) score += line((x) => m[y][x]);
    for (let x = 0; x < s; x++) score += line((y) => m[y][x]);
    for (let y = 0; y < s - 1; y++) {
      for (let x = 0; x < s - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const k = Math.ceil(Math.abs(dark * 20 - s * s * 10) / (s * s)) - 1;
    score += Math.max(0, k) * 10;
    return score;
  }

  function qrEncode(text) {
    const bytes = utf8(text);
    const version = chooseVersion(bytes.length);
    const codewords = addErrorCorrection(encodeData(bytes, version), version);

    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const q = makeMatrix(version);
      drawFunctionPatterns(q, version);
      placeData(q, codewords);
      applyMask(q, mask);
      drawFormat(q, mask);
      const sc = penalty(q);
      if (sc < bestScore) {
        bestScore = sc;
        best = q;
      }
    }
    return best.m;
  }

  function qrToCanvas(canvas, modules, scale = 6, quiet = 4) {
    const n = modules.length;
    const px = (n + quiet * 2) * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }

  global.qrEncode = qrEncode;
  global.qrToCanvas = qrToCanvas;
})(typeof window !== "undefined" ? window : globalThis);
