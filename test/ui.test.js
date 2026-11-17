'use strict';

// Browser helpers that need no DOM, run in Node with a stand-in `window`.

const { test } = require('node:test');
const assert = require('node:assert');

global.window = {};
require('../public/js/highlight.js');

const { highlightJSON } = window.RL_highlight;

test('highlightJSON: escapes every character of the response and colours each token', () => {
  const body = JSON.stringify({ 'k"ey': "it's <script>alert(1)</script> & co", n: -1.5e3, ok: true, none: null }, null, 2);
  const html = highlightJSON(body);

  assert.ok(!/<(?!\/?span)/.test(html), 'only our own <span> tags');
  assert.match(html, /<span class="tok-key">&quot;k\\&quot;ey&quot;:<\/span>/);
  assert.match(html, /<span class="tok-string">&quot;it&#39;s &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co&quot;<\/span>/);
  assert.match(html, /<span class="tok-number">-1500<\/span>/);
  assert.match(html, /<span class="tok-boolean">true<\/span>/);
  assert.match(html, /<span class="tok-null">null<\/span>/);
  // Stripping our tags and decoding the entities gives back exactly the original text.
  const text = html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  assert.equal(text, body);
});
