import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createMovPreviewBlob } from '../app/mov-preview.ts';

function atom(type, ...parts) {
  const body = Buffer.concat(parts); const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8); header.write(type, 4);
  return Buffer.concat([header, body]);
}
function track(type) {
  const handler = Buffer.alloc(12); handler.write(type, 8);
  return atom('trak', atom('mdia', atom('hdlr', handler)), atom('free', Buffer.from('track-data')));
}
for (const moovFirst of [true, false]) {
  test(`MOV preview preserves sample bytes and offsets (moovFirst=${moovFirst})`, async () => {
    const ftyp = atom('ftyp', Buffer.from('qt  '), Buffer.alloc(4), Buffer.from('qt  '));
    const video = track('vide'); const audio = track('soun'); const metadata = track('meta');
    const moov = atom('moov', video, audio, metadata); const mdat = atom('mdat', Buffer.from('unaltered-video-and-audio-samples'));
    const input = Buffer.concat([ftyp, ...(moovFirst ? [moov, mdat] : [mdat, moov])]);
    const file = new Blob([input], { type: 'video/quicktime' });
    const compatible = await createMovPreviewBlob(file);
    assert.equal(compatible.type, 'video/mp4'); assert.equal(compatible.size, input.length);
    const output = Buffer.from(await compatible.arrayBuffer());
    assert.equal(output.toString('ascii', 8, 12), 'mp42');
    const moovOffset = moovFirst ? ftyp.length : ftyp.length + mdat.length;
    assert.deepEqual(output.subarray(moovOffset + 8, moovOffset + 8 + video.length), video);
    assert.equal(output.toString('ascii', moovOffset + 8 + video.length + 4, moovOffset + 8 + video.length + 8), 'free');
    const mdatOffset = moovFirst ? ftyp.length + moov.length : ftyp.length;
    assert.deepEqual(output.subarray(mdatOffset, mdatOffset + mdat.length), mdat);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), input);
  });
}
test('malformed containers and files without a video track do not become preview files', async () => {
  assert.equal(await createMovPreviewBlob(new Blob([Buffer.from('invalid')])), null);
  const ftyp = atom('ftyp', Buffer.from('qt  '), Buffer.alloc(4));
  assert.equal(await createMovPreviewBlob(new Blob([ftyp, atom('moov', track('soun'))])), null);
  const truncated = Buffer.alloc(8); truncated.writeUInt32BE(1024); truncated.write('moov', 4);
  assert.equal(await createMovPreviewBlob(new Blob([ftyp, truncated])), null);
});

test('MOV fallback handles only unsupported media and preserves normal preview behavior', async () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildPreview');
  const code = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [name, errorCode, expectedFallback] of [['live.MOV', 4, true], ['normal.mp4', 4, false], ['live.MOV', 3, false], ['live.MOV', 0, false]]) {
    const original = { name }; const compatible = {}; const calls = []; const success = { thumb: 'preview' };
    const failure = Object.assign(new Error('demux failed'), { mediaCode: errorCode });
    const run = vm.runInNewContext(code + '\nbuildPreview', {
      Error, String,
      createMovPreviewBlob: async file => { calls.push('fallback'); assert.equal(file, original); return compatible; },
      buildVideoPreview: async file => {
        calls.push(file === original ? 'original' : 'compatible');
        if (file === original && errorCode) throw failure;
        return success;
      },
    });
    const item = { handle: { getFile: async () => original } };
    if (errorCode && !expectedFallback) await assert.rejects(run(item), error => error === failure);
    else assert.equal(await run(item), success);
    assert.deepEqual(calls, expectedFallback ? ['original', 'fallback', 'compatible'] : ['original']);
  }
});
