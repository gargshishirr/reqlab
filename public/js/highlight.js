/*
 * Safe HTML escaping + lightweight JSON syntax highlighting.
 *
 * SECURITY: every piece of text is HTML-escaped before it goes into markup, so
 * response bodies (which may contain <script>, etc.) can never inject into the page.
 */
(function (global) {
  'use strict';

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // A JSON string (with an optional ":" after it, for keys), true/false, null, or a number.
  const TOKEN = /"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

  /**
   * Highlight a JSON string. The tokens are found in the raw text first; then every
   * token and every gap between them is escaped on its own and only our own <span>
   * wrappers are added, so the output is safe to inject as HTML.
   */
  function highlightJSON(jsonString) {
    const text = String(jsonString);
    let html = '';
    let last = 0;
    for (const match of text.matchAll(TOKEN)) {
      const token = match[0];
      let cls = 'tok-number';
      if (token[0] === '"') cls = /:$/.test(token) ? 'tok-key' : 'tok-string';
      else if (token === 'true' || token === 'false') cls = 'tok-boolean';
      else if (token === 'null') cls = 'tok-null';
      html += escapeHtml(text.slice(last, match.index)) + `<span class="${cls}">${escapeHtml(token)}</span>`;
      last = match.index + token.length;
    }
    return html + escapeHtml(text.slice(last));
  }

  global.RL_highlight = { escapeHtml, highlightJSON };
})(window);
