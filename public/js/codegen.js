/*
 * Generate copy-pasteable code snippets from an "effective" request
 * (the fully-resolved { method, url, headers, body } that ReqLab sends).
 */
(function (global) {
  'use strict';

  function shellQuote(str) {
    // Wrap in single quotes, escaping any embedded single quotes.
    return "'" + String(str).replace(/'/g, "'\\''") + "'";
  }

  function curl(eff) {
    const lines = [`curl -X ${eff.method} ${shellQuote(eff.url)}`];
    for (const [k, v] of Object.entries(eff.headers || {})) {
      lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
    }
    if (eff.body != null && eff.body !== '') {
      lines.push(`  --data ${shellQuote(eff.body)}`);
    }
    return lines.join(' \\\n');
  }

  function fetchSnippet(eff) {
    const opts = { method: eff.method };
    if (eff.headers && Object.keys(eff.headers).length) opts.headers = eff.headers;
    if (eff.body != null && eff.body !== '') opts.body = eff.body;

    const optsStr = JSON.stringify(opts, null, 2);
    return (
      `const response = await fetch(${JSON.stringify(eff.url)}, ${optsStr});\n` +
      `const data = await response.text();\n` +
      `console.log(response.status, data);`
    );
  }

  global.RL_codegen = {
    generate(lang, eff) {
      if (lang === 'fetch') return fetchSnippet(eff);
      return curl(eff);
    },
  };
})(window);
