import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { photoTimeKeys, timePeriodLabel, matchesPhotoTime } from "../app/photos/time-filter.ts";

const modified = new Date(2026, 9, 10, 12).getTime();

test("backup directory date takes priority over copied file modification time", () => {
  assert.deepEqual(photoTimeKeys({ sourceName: "backup", path: "2024/03/31/IMG_1.HEIC", modified }), { years: "2024", quarters: "2024-Q1", months: "2024-03" });
  assert.equal(photoTimeKeys({ sourceName: "2024", path: "04/01/IMG_1.JPG", modified }).quarters, "2024-Q2");
  assert.equal(photoTimeKeys({ sourceName: "backup", path: "2024\\12\\31\\IMG_1.JPG", modified }).months, "2024-12");
});

test("local photos use modification date and invalid timestamps remain unknown", () => {
  assert.equal(photoTimeKeys({ sourceName: "photos", path: "IMG_1.JPG", modified }).months, "2026-10");
  assert.equal(photoTimeKeys({ sourceName: "photos", path: "2024/13/IMG_1.JPG", modified }).years, "2026");
  assert.equal(photoTimeKeys({ sourceName: "photos", path: "IMG_1.JPG", modified: NaN }), null);
  assert.equal(photoTimeKeys({ sourceName: "photos", path: "IMG_1.JPG", modified: 0 }), null);
  assert.equal(photoTimeKeys({ sourceName: "photos", path: "2024/01/IMG_1.JPG", modified: 0 }).months, "2024-01");
});

test("time filtering supports multiple ranges, quarter boundaries and unknown times", () => {
  const keys = photoTimeKeys({ sourceName: "backup", path: "2024/07/01/IMG_1.JPG", modified });
  assert.equal(matchesPhotoTime(keys, "quarters", ["2024-Q2", "2024-Q3"]), true);
  assert.equal(matchesPhotoTime(keys, "quarters", ["2024-Q2"]), false);
  assert.equal(matchesPhotoTime(keys, "years", ["2025"]), false);
  assert.equal(matchesPhotoTime(keys, "months", ["2024-07"]), true);
  assert.equal(matchesPhotoTime(keys, "months", []), true);
  assert.equal(matchesPhotoTime(null, "months", ["unknown"]), true);
  assert.equal(matchesPhotoTime(null, "months", ["2024-07"]), false);
});

test("time range labels match the iCloud year, quarter and month controls", () => {
  assert.equal(timePeriodLabel("2024", "years"), "2024 年");
  assert.equal(timePeriodLabel("2024-Q3", "quarters"), "2024 年第 3 季度");
  assert.equal(timePeriodLabel("2024-07", "months"), "2024 年 7 月");
});

test("actual photo library combines time selection with source, format and favorites", () => {
  const source = readFileSync(new URL('../app/photos/page.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let filter;
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'filtered' && ts.isCallExpression(node.initializer)) filter = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, find);
  }
  find(ast); assert.ok(filter);
  const photos = [
    { id: 'match', sourceId: 'backup', sourceName: 'backup', path: '2024/03/01/one.jpg', name: 'one.jpg', extension: 'jpg', liked: true, modified },
    { id: 'wrong-month', sourceId: 'backup', sourceName: 'backup', path: '2024/04/01/two.jpg', name: 'two.jpg', extension: 'jpg', liked: true, modified },
    { id: 'wrong-source', sourceId: 'other', sourceName: 'other', path: '2024/03/01/one.jpg', name: 'one.jpg', extension: 'jpg', liked: true, modified },
    { id: 'wrong-format', sourceId: 'backup', sourceName: 'backup', path: '2024/03/01/one.heic', name: 'one.heic', extension: 'heic', liked: true, modified },
    { id: 'not-liked', sourceId: 'backup', sourceName: 'backup', path: '2024/03/01/three.jpg', name: 'three.jpg', extension: 'jpg', liked: false, modified },
  ];
  const compiled = ts.transpileModule(`const filter = ${filter};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = vm.runInNewContext(`${compiled}\nfilter();`, {
    photos, photoTimes: new Map(photos.map(item => [item.id, photoTimeKeys(item)])),
    matchesPhotoTime, timeGranularity: 'months', selectedTimePeriods: ['2024-03'],
    sourceFilter: 'backup', formatFilter: 'jpg', tab: 'liked', query: '', sort: 'newest',
  });
  assert.deepEqual(Array.from(result, item => item.id), ['match']);
});
