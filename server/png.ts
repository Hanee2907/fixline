import { deflateSync } from 'node:zlib';

/** A tiny PNG encoder, used to draw the demo's sample "error screenshot" without shipping image files. */
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Buffer) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A sign-in prompt over a blurred desktop: what "Outlook keeps asking for my password" looks like. */
export function samplePasswordPrompt(): Buffer {
  const W = 480, H = 280;
  const box = { x: 110, y: 50, w: 260, h: 180 };
  const inBox = (x: number, y: number) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
  return png(W, H, (x, y) => {
    if (inBox(x, y)) {
      const ly = y - box.y, lx = x - box.x;
      if (ly < 34) return [0, 99, 177]; // blue title bar
      if (ly > 70 && ly < 96 && lx > 20 && lx < 240) return ly === 71 || ly === 95 || lx === 21 || lx === 239 ? [160, 160, 160] : [255, 255, 255]; // field
      if (ly > 110 && ly < 136 && lx > 20 && lx < 240) return ly === 111 || ly === 135 || lx === 21 || lx === 239 ? [160, 160, 160] : [255, 255, 255];
      if (ly > 148 && ly < 170 && lx > 150 && lx < 240) return [0, 99, 177]; // OK button
      if (ly > 44 && ly < 52 && lx > 20 && lx < 200) return [60, 60, 60]; // text line
      return [243, 243, 243];
    }
    // desktop: a soft gradient with a hint of windows behind
    const t = y / H;
    const behind = x > 30 && x < 450 && y > 20 && y < 260 ? 18 : 0;
    return [Math.round(28 + 30 * t) + behind, Math.round(40 + 40 * t) + behind, Math.round(70 + 60 * t) + behind];
  });
}
