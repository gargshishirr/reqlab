/*
 * Variable substitution for {{placeholders}} using the active environment.
 */
(function (global) {
  'use strict';

  const RE = /\{\{\s*([\w.\-]+)\s*\}\}/g;

  const RL_vars = {
    /**
     * Replace {{var}} tokens in a string with values from `map`.
     * Unknown variables are left untouched so the user can see them.
     */
    resolve(str, map) {
      if (typeof str !== 'string' || !str) return str;
      return str.replace(RE, (match, key) =>
        Object.prototype.hasOwnProperty.call(map, key) ? map[key] : match
      );
    },

    /** Build a { key: value } map from an environment object. */
    mapFromEnv(env) {
      const map = {};
      if (env && Array.isArray(env.variables)) {
        for (const v of env.variables) {
          if (v && v.key && v.enabled !== false) map[v.key] = v.value == null ? '' : v.value;
        }
      }
      return map;
    },

    /** List the variable names referenced in a string. */
    referenced(str) {
      const found = new Set();
      if (typeof str !== 'string') return found;
      let m;
      RE.lastIndex = 0;
      while ((m = RE.exec(str))) found.add(m[1]);
      return found;
    },
  };

  global.RL_vars = RL_vars;
})(window);
