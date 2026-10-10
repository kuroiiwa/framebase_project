import assert from 'node:assert/strict';
import test from 'node:test';
import { readAutoReleasePreference, saveAutoReleasePreference } from '../app/photos/release-preferences.ts';

test('automatic batch release defaults to manual confirmation and persists independently per account', () => {
  const saved = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  } });
  try {
    assert.equal(readAutoReleasePreference('zhang'), false);
    assert.equal(readAutoReleasePreference('gabri'), false);
    saveAutoReleasePreference('zhang', true);
    assert.equal(readAutoReleasePreference('zhang'), true);
    assert.equal(readAutoReleasePreference('gabri'), false);
    saveAutoReleasePreference('gabri', true);
    saveAutoReleasePreference('zhang', false);
    assert.equal(readAutoReleasePreference('zhang'), false);
    assert.equal(readAutoReleasePreference('gabri'), true);
    saved.set('framebase-user:zhang:photo-auto-release-after-review', 'true');
    assert.equal(readAutoReleasePreference('zhang'), false);
    globalThis.localStorage.getItem = () => { throw new Error('blocked'); };
    assert.equal(readAutoReleasePreference('gabri'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
