// Visit sources from landing-page tags, click ids and referrers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficSource } from '../lib/traffic-source.js';

const own = ['booktokids.com', 'kids-book.myshopify.com'];

test('UTM tags win, with the campaign kept apart', () => {
  assert.deepEqual(
    trafficSource({ params: { utm_source: 'Instagram', utm_medium: 'paid', utm_campaign: 'spring-sale', utm_content: 'reel-2' }, referrer: 'https://l.instagram.com/' }),
    { label: 'instagram / paid', campaign: 'spring-sale · reel-2' }
  );
  assert.deepEqual(trafficSource({ params: { utm_source: 'newsletter' } }), { label: 'newsletter', campaign: '' });
});

test('ad click ids name their platform', () => {
  assert.equal(trafficSource({ params: { gclid: 'abc' } }).label, 'google ads');
  assert.equal(trafficSource({ params: { fbclid: 'abc' }, referrer: 'https://l.facebook.com/' }).label, 'facebook / instagram');
  assert.equal(trafficSource({ params: { ttclid: 'abc' } }).label, 'tiktok ads');
});

test('otherwise the referring site, without link and mobile hosts', () => {
  assert.equal(trafficSource({ referrer: 'https://l.instagram.com/?u=x' }).label, 'instagram.com');
  assert.equal(trafficSource({ referrer: 'https://www.google.com/' }).label, 'google.com');
  assert.equal(trafficSource({ referrer: 'https://chatgpt.com/' }).label, 'chatgpt.com');
});

test('the store itself, no referrer, or junk read as direct', () => {
  assert.equal(trafficSource({ referrer: 'https://www.booktokids.com/products/x', ownHosts: own }).label, 'direct');
  assert.equal(trafficSource({ referrer: '', ownHosts: own }).label, 'direct');
  assert.equal(trafficSource({ referrer: 'not a url' }).label, 'direct');
  assert.equal(trafficSource().label, 'direct');
});
