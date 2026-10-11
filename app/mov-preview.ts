type Atom = { offset: number; size: number; header: number; type: string };
const text = (data: Uint8Array, offset: number) => String.fromCharCode(...data.subarray(offset, offset + 4));
const word = (data: Uint8Array, offset: number, value: string) => {
  for (let index = 0; index < 4; index++) data[offset + index] = value.charCodeAt(index);
};

function atom(data: Uint8Array, offset: number, end: number): Atom | null {
  if (offset + 8 > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let size = view.getUint32(offset); let header = 8;
  if (size === 1) {
    if (offset + 16 > data.length) return null;
    size = Number(view.getBigUint64(offset + 8)); header = 16;
  } else if (size === 0) size = end - offset;
  if (!Number.isSafeInteger(size) || size < header || size > end - offset) return null;
  return { offset, size, header, type: text(data, offset + 4) };
}

function children(data: Uint8Array, start: number, end: number): Atom[] | null {
  const result: Atom[] = [];
  for (let offset = start; offset < end;) {
    const entry = atom(data, offset, end);
    if (!entry) return null;
    result.push(entry); offset += entry.size;
  }
  return result;
}

// Change only headers in a temporary Blob. Media bytes and chunk offsets stay
// identical, including when moov precedes mdat. The source file is never written.
export async function createMovPreviewBlob(file: Blob): Promise<Blob | null> {
  const patches: Array<{ offset: number; data: Uint8Array }> = [];
  let sawVideo = false; let sawBrand = false; let scanned = 0;
  for (let offset = 0; offset < file.size;) {
    if (++scanned > 10000) return null;
    const headerBytes = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    const entry = atom(headerBytes, 0, file.size - offset);
    if (!entry) return null;
    if (entry.type === "ftyp" || entry.type === "moov") {
      if (entry.size > 16 * 1024 * 1024) return null;
      const data = new Uint8Array(await file.slice(offset, offset + entry.size).arrayBuffer());
      if (entry.type === "ftyp") {
        if (entry.size < entry.header + 8 || (entry.size - entry.header - 8) % 4) return null;
        word(data, entry.header, "mp42");
        for (let index = entry.header + 8; index < data.length; index += 4) word(data, index, "isom");
        sawBrand = true;
      } else {
        const tracks = children(data, entry.header, data.length);
        if (!tracks) return null;
        for (const track of tracks.filter(item => item.type === "trak")) {
          const members = children(data, track.offset + track.header, track.offset + track.size);
          if (!members) return null;
          let video = false;
          for (const media of members.filter(item => item.type === "mdia")) {
            const fields = children(data, media.offset + media.header, media.offset + media.size);
            if (!fields) return null;
            video ||= fields.some(field => field.type === "hdlr" && field.size >= field.header + 12 && text(data, field.offset + field.header + 8) === "vide");
          }
          if (video) sawVideo = true;
          else word(data, track.offset + 4, "free");
        }
      }
      patches.push({ offset, data });
    }
    offset += entry.size;
  }
  if (!sawVideo || !sawBrand) return null;
  const parts: BlobPart[] = []; let cursor = 0;
  for (const patch of patches) {
    parts.push(file.slice(cursor, patch.offset), patch.data as Uint8Array<ArrayBuffer>);
    cursor = patch.offset + patch.data.length;
  }
  parts.push(file.slice(cursor));
  return new Blob(parts, { type: "video/mp4" });
}
