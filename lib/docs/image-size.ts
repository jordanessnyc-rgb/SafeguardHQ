/** Width/height from PNG or JPEG headers (keeps photo aspect ratios in DOCX output). */
export function imageSize(buf: Buffer): { width: number; height: number; ext: "png" | "jpeg" } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: "png" };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), ext: "jpeg" };
      i += 2 + len;
    }
    return { width: 0, height: 0, ext: "jpeg" };
  }
  return null;
}
