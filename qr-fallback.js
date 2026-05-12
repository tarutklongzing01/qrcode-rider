function createLocalQRCode(text, size) {
  const version = 10;
  const moduleCount = version * 4 + 17;
  const modules = Array.from({ length: moduleCount }, () => Array(moduleCount).fill(false));
  const reserved = Array.from({ length: moduleCount }, () => Array(moduleCount).fill(false));

  function setModule(row, col, dark, isReserved = true) {
    if (row < 0 || row >= moduleCount || col < 0 || col >= moduleCount) return;
    modules[row][col] = !!dark;
    if (isReserved) reserved[row][col] = true;
  }

  function setupFinder(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= moduleCount || cc < 0 || cc >= moduleCount) continue;
        const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setModule(rr, cc, dark);
      }
    }
  }

  function setupAlignment(row, col) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        setModule(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
      }
    }
  }

  function setupPatterns() {
    setupFinder(0, 0);
    setupFinder(0, moduleCount - 7);
    setupFinder(moduleCount - 7, 0);

    [6, 28, 50].forEach((row) => {
      [6, 28, 50].forEach((col) => {
        if (reserved[row] && reserved[row][col]) return;
        setupAlignment(row, col);
      });
    });

    for (let i = 8; i < moduleCount - 8; i++) {
      setModule(6, i, i % 2 === 0);
      setModule(i, 6, i % 2 === 0);
    }

    setModule(moduleCount - 8, 8, true);

    for (let i = 0; i < 9; i++) {
      if (i !== 6) {
        reserved[8][i] = true;
        reserved[i][8] = true;
      }
    }
    for (let i = 0; i < 8; i++) {
      reserved[8][moduleCount - 1 - i] = true;
      reserved[moduleCount - 1 - i][8] = true;
    }

    const bits = getBchVersion(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1;
      setModule(Math.floor(i / 3), moduleCount - 11 + (i % 3), dark);
      setModule(moduleCount - 11 + (i % 3), Math.floor(i / 3), dark);
    }
  }

  function getBchDigit(data) {
    let digit = 0;
    while (data !== 0) {
      digit++;
      data >>>= 1;
    }
    return digit;
  }

  function getBchTypeInfo(data) {
    let d = data << 10;
    const g = 0x537;
    while (getBchDigit(d) - getBchDigit(g) >= 0) {
      d ^= g << (getBchDigit(d) - getBchDigit(g));
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  function getBchVersion(data) {
    let d = data << 12;
    const g = 0x1f25;
    while (getBchDigit(d) - getBchDigit(g) >= 0) {
      d ^= g << (getBchDigit(d) - getBchDigit(g));
    }
    return (data << 12) | d;
  }

  function putFormatInfo(maskPattern) {
    const bits = getBchTypeInfo((1 << 3) | maskPattern);
    for (let i = 0; i < 15; i++) {
      const dark = ((bits >> i) & 1) === 1;
      if (i < 6) setModule(8, i, dark);
      else if (i < 8) setModule(8, i + 1, dark);
      else setModule(8, moduleCount - 15 + i, dark);

      if (i < 8) setModule(moduleCount - i - 1, 8, dark);
      else if (i < 9) setModule(15 - i, 8, dark);
      else setModule(14 - i, 8, dark);
    }
  }

  function createDataBytes(value) {
    const data = Array.from(new TextEncoder().encode(value));
    const maxDataBytes = 274;
    const bits = [];
    const write = (num, length) => {
      for (let i = length - 1; i >= 0; i--) bits.push((num >>> i) & 1);
    };

    if (data.length > maxDataBytes - 3) {
      throw new Error('QR text is too long for the local fallback.');
    }

    write(4, 4);
    write(data.length, 16);
    data.forEach((byte) => write(byte, 8));

    const capacityBits = maxDataBytes * 8;
    for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      bytes.push(bits.slice(i, i + 8).reduce((sum, bit) => (sum << 1) | bit, 0));
    }

    for (let pad = 0; bytes.length < maxDataBytes; pad++) {
      bytes.push(pad % 2 === 0 ? 0xec : 0x11);
    }

    return bytes;
  }

  function createErrorCorrection(dataBytes) {
    const blockDefs = [
      { total: 86, data: 68 },
      { total: 86, data: 68 },
      { total: 87, data: 69 },
      { total: 87, data: 69 }
    ];
    const blocks = [];
    let offset = 0;

    blockDefs.forEach((def) => {
      const data = dataBytes.slice(offset, offset + def.data);
      offset += def.data;
      blocks.push({ data, ecc: rsEncode(data, def.total - def.data) });
    });

    const result = [];
    for (let i = 0; i < 69; i++) {
      blocks.forEach((block) => {
        if (i < block.data.length) result.push(block.data[i]);
      });
    }
    for (let i = 0; i < 18; i++) {
      blocks.forEach((block) => result.push(block.ecc[i]));
    }
    return result;
  }

  function rsEncode(data, degree) {
    const gen = rsGenerator(degree);
    const result = Array(degree).fill(0);

    data.forEach((byte) => {
      const factor = byte ^ result.shift();
      result.push(0);
      gen.forEach((coef, index) => {
        result[index] ^= gfMul(coef, factor);
      });
    });

    return result;
  }

  function rsGenerator(degree) {
    let result = [1];
    for (let i = 0; i < degree; i++) {
      const next = Array(result.length + 1).fill(0);
      result.forEach((coef, index) => {
        next[index] ^= gfMul(coef, 1);
        next[index + 1] ^= gfMul(coef, gfPow(2, i));
      });
      result = next;
    }
    return result.slice(1);
  }

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function gfPow(x, power) {
    let result = 1;
    for (let i = 0; i < power; i++) result = gfMul(result, x);
    return result;
  }

  function mapData(codewords) {
    const bits = [];
    codewords.forEach((byte) => {
      for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
    });

    let bitIndex = 0;
    let direction = -1;
    let row = moduleCount - 1;

    for (let col = moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (row >= 0 && row < moduleCount) {
        for (let c = 0; c < 2; c++) {
          const currentCol = col - c;
          if (!reserved[row][currentCol]) {
            const bit = bitIndex < bits.length ? bits[bitIndex++] === 1 : false;
            modules[row][currentCol] = bit !== ((row + currentCol) % 2 === 0);
          }
        }
        row += direction;
      }
      row -= direction;
      direction = -direction;
      row += direction;
    }
  }

  function draw() {
    const canvas = document.createElement('canvas');
    const quietZone = 4;
    const scale = Math.max(4, Math.ceil(size / (moduleCount + quietZone * 2)));
    const canvasSize = (moduleCount + quietZone * 2) * scale;
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    canvas.style.width = canvasSize + 'px';
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';
    canvas.style.imageRendering = 'pixelated';

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasSize, canvasSize);
    ctx.fillStyle = '#000000';

    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (modules[row][col]) {
          ctx.fillRect((col + quietZone) * scale, (row + quietZone) * scale, scale, scale);
        }
      }
    }
    return canvas;
  }

  setupPatterns();
  mapData(createErrorCorrection(createDataBytes(text)));
  putFormatInfo(0);
  return draw();
}
