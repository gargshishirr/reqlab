/*
 * Safe HTML escaping + lightweight JSON syntax highlighting.
 *
 * SECURITY: every value is HTML-escaped BEFORE any markup is added, so response
 * bodies (which may contain <script>, etc.) can never inject into the page.
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

  /**
   * Highlight a JSON string. The input is escaped first; only our own <span>
   * wrappers are added afterwards, so the output is safe to inject as HTML.
   */
  function highlightJSON(jsonString) {
    const escaped = escapeHtml(jsonString);
    return escaped.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'tok-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'tok-key' : 'tok-string';
        } else if (/true|false/.test(match)) {
          cls = 'tok-boolean';
        } else if (/null/.test(match)) {
          cls = 'tok-null';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  global.RL_highlight = { escapeHtml, highlightJSON };
})(window);
