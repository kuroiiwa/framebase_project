import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePlaybackKey } from '../app/player-shortcuts.ts';

globalThis.HTMLElement = class { closest() { return this.editable; } };
globalThis.document = { fullscreenElement: null };
function fixture() {
  const video = { currentTime: 5, duration: 30, volume: .98, muted: true, paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } };
  function press(key, extra = {}) {
    const event = { key, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    let closed = false;
    handlePlaybackKey(event, video, () => { closed = true; });
    return { event, closed };
  }
  return { video, press };
}
test('player keys work without range focus, clamp seek/volume and suppress native duplicates', () => {
  const { video, press } = fixture();
  const { event } = press('ArrowLeft'); assert.equal(video.currentTime, 0);
  assert.ok(event.prevented && event.stopped);
  video.currentTime = 29; press('ArrowRight'); assert.equal(video.currentTime, 30);
  press('ArrowUp'); assert.equal(video.volume, 1); assert.equal(video.muted, false);
  video.volume = .02; press('ArrowDown'); assert.equal(video.volume, 0);
  press(' '); assert.equal(video.paused, false);
  press(' ', { repeat: true }); assert.equal(video.paused, false);
  press(' '); assert.equal(video.paused, true);
  press('M'); assert.equal(video.muted, true);
  assert.equal(press('Escape').closed, true);
});
test('typing, composing and browser modifier shortcuts never control playback', () => {
  const { video, press } = fixture();
  const target = new HTMLElement(); target.editable = true;
  assert.equal(press(' ', { target }).event.prevented, undefined);
  assert.equal(press('ArrowRight', { ctrlKey: true }).event.prevented, undefined);
  assert.equal(press(' ', { isComposing: true }).event.prevented, undefined);
  assert.equal(video.paused, true); assert.equal(video.currentTime, 5);
});

test('fullscreen uses the stage so the custom playback controls remain available', async () => {
  const { video, press } = fixture();
  let entered = 0;
  video.closest = selector => {
    assert.equal(selector, '.player-stage');
    return { requestFullscreen() { entered++; return Promise.resolve(); } };
  };
  press('f');
  assert.equal(entered, 1);
  press('f', { repeat: true });
  assert.equal(entered, 1);
  let exited = 0;
  document.fullscreenElement = {};
  document.exitFullscreen = () => { exited++; return Promise.resolve(); };
  try {
    press('F');
    assert.equal(exited, 1);
    assert.equal(press('Escape').closed, false);
    assert.equal(exited, 2);
  } finally {
    document.fullscreenElement = null;
  }
});

test('volume slider arrow keys retain native range behavior', () => {
  const { video, press } = fixture();
  const target = new HTMLElement();
  target.closest = selector => selector === '[data-player-volume]' ? target : null;
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(press(key, { target }).event.prevented, undefined);
  }
  assert.equal(video.currentTime, 5);
  assert.equal(video.volume, .98);
  press('M', { target });
  assert.equal(video.muted, false);
});
