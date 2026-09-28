// 读取 PNG 并统计平均颜色 / 亮度（无需任何图像库，纯 zlib 解 PNG）。
// 用途：截图无法人工查看时，用数值确认「浅色米白」确实偏亮、「深色深绿」确实偏暗且偏绿。
// 用法： node scripts/png-mean.mjs test-artifacts/11-theme-light.png test-artifacts/12-theme-dark.png
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('只支持 8 位深度');
  if (interlace !== 0) throw new Error('不支持隔行扫描');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('不支持的 colorType ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[x] = (line[x] + a) & 0xff; break;
        case 2: line[x] = (line[x] + b) & 0xff; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x] + pr) & 0xff;
          break;
        }
        default: throw new Error('未知过滤器 ' + filter);
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { width, height, channels, pixels: out };
}

for (const file of process.argv.slice(2)) {
  const { width, height, channels, pixels } = decodePng(fs.readFileSync(file));
  let r = 0;
  let g = 0;
  let b = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    r += pixels[o];
    g += pixels[o + 1];
    b += pixels[o + 2];
  }
  r /= n; g /= n; b /= n;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  console.log(
    file.padEnd(38) +
    `${width}x${height}  平均 RGB(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})` +
    `  亮度 ${lum.toFixed(3)}` +
    `  ${g >= r && g >= b ? '偏绿' : r >= g && r >= b ? '偏红/暖' : '偏蓝'}`,
  );
}
