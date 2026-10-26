import { inflateRawSync } from 'node:zlib';

/**
 * Read the first entry of a small zip archive (a GDELT export is a single
 * file). Uses the central directory, so entries written with a data
 * descriptor work. Throws on anything malformed or larger than `maxBytes`
 * once inflated.
 * @param {Uint8Array} bytes
 * @param {number} [maxBytes]
 * @returns {Buffer}
 */
export function readFirstZipEntry(bytes, maxBytes = 32 * 1024 * 1024) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const cd = buf.readUInt32LE(eocd + 16);
  if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50)
    throw new Error('bad zip directory');
  const method = buf.readUInt16LE(cd + 10);
  const compressed = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
    throw new Error('bad zip entry');
  const start =
    local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + compressed);
  if (data.length !== compressed) throw new Error('truncated zip entry');
  if (method === 0) {
    if (data.length > maxBytes) throw new Error('zip entry too large');
    return data;
  }
  if (method !== 8) throw new Error(`unsupported zip method ${method}`);
  return inflateRawSync(data, { maxOutputLength: maxBytes });
}
