/*
 * dc-lite：讓設計畫布的 .dc.html 頁面（{{洞}}、<sc-for>、<sc-if>、DCLogic 元件）在一般網站上執行的小型執行環境。
 * 只實作 chang.fit 網站用到的部分。畫面更新用 morphdom 比對差異，影片和輸入框不會被重建。
 */
(function () {
  'use strict';
  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

  function lookup(scope, expr) {
    expr = expr.trim();
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    if (/^'.*'$|^".*"$/.test(expr)) return expr.slice(1, -1);
    var parts = expr.split('.'), v = scope;
    for (var i = 0; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }
  function interp(str, scope) {
    return str.replace(HOLE, function (_, e) { var v = lookup(scope, e); return v == null ? '' : String(v); });
  }

  // 事件處理函式登記表：每次重繪重建，元素上只留 data-dch-<事件>="編號"
  var handlers = [];
  function bind(fn) { handlers.push(fn); return String(handlers.length - 1); }

  function renderNodes(nodes, scope, parent) {
    for (var i = 0; i < nodes.length; i++) renderNode(nodes[i], scope, parent);
  }
  function renderNode(node, scope, parent) {
    if (node.nodeType === 3) { parent.appendChild(document.createTextNode(interp(node.nodeValue, scope))); return; }
    if (node.nodeType !== 1) return;
    var tag = node.localName;
    var kids = node.content ? node.content.childNodes : node.childNodes;
    if (tag === 'sc-for') {
      var list = lookup(scope, (node.getAttribute('list') || '').replace(/^\s*\{\{|\}\}\s*$/g, '')) || [];
      var as = node.getAttribute('as') || 'item';
      for (var k = 0; k < list.length; k++) {
        var s = Object.create(scope); s[as] = list[k]; s.$index = k;
        renderNodes(kids, s, parent);
      }
      return;
    }
    if (tag === 'sc-if') {
      var cond = lookup(scope, (node.getAttribute('value') || '').replace(/^\s*\{\{|\}\}\s*$/g, ''));
      if (cond) renderNodes(kids, scope, parent);
      return;
    }
    var el = node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      ? document.createElementNS(node.namespaceURI, tag) : document.createElement(tag);
    for (var a = 0; a < node.attributes.length; a++) {
      var at = node.attributes[a], name = at.name, val = at.value, m = val.match(WHOLE);
      if (name.indexOf('hint-') === 0) continue;
      if (/^on[a-z]+$/.test(name)) {
        if (m) { var fn = lookup(scope, m[1]); if (typeof fn === 'function') el.setAttribute('data-dch-' + name.slice(2), bind(fn)); }
        continue;
      }
      if (m) {
        var v = lookup(scope, m[1]);
        if (v === true) { el.setAttribute(name, ''); continue; }
        if (v === false || v == null) continue;
        el.setAttribute(name, String(v));
      } else {
        el.setAttribute(name, interp(val, scope));
      }
    }
    renderNodes(kids, scope, el);
    parent.appendChild(el);
  }

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (patch) {
    var p = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, p);
    schedule();
  };
  DCLogic.prototype.forceUpdate = function () { schedule(); };
  DCLogic.prototype.renderVals = function () { return {}; };
  window.DCLogic = DCLogic;

  var app, tpl, comp, pending = false;
  function schedule() { if (pending) return; pending = true; Promise.resolve().then(render); }
  function render() {
    pending = false;
    handlers = [];
    var vals = comp.renderVals() || {};
    var root = document.createElement('div');
    renderNodes(tpl.content.childNodes, vals, root);
    window.morphdom(app, root, {
      childrenOnly: true,
      onBeforeElUpdated: function (from, to) {
        if (from.isEqualNode(to)) return false;
        // 學員正在選的檔案、播放中的影片不要被覆蓋
        if (from.tagName === 'INPUT' && from.type === 'file') {
          for (var i = from.attributes.length - 1; i >= 0; i--) { var n = from.attributes[i].name; if (!to.hasAttribute(n)) from.removeAttribute(n); }
          for (var j = 0; j < to.attributes.length; j++) from.setAttribute(to.attributes[j].name, to.attributes[j].value);
          return false;
        }
        return true;
      }
    });
  }
  function dispatch(type) {
    return function (e) {
      var t = e.target;
      while (t && t !== app) {
        if (t.getAttribute) {
          var id = t.getAttribute('data-dch-' + type);
          if (id != null && handlers[+id]) { handlers[+id](e); return; }
        }
        t = t.parentNode;
      }
    };
  }

  window.DCLite = {
    mount: function (ComponentClass, defaults) {
      app = document.getElementById('app'); tpl = document.getElementById('dc-template');
      comp = new ComponentClass(defaults || {});
      if (!comp.state) comp.state = {};
      ['click', 'change', 'input', 'submit', 'keydown'].forEach(function (t) { app.addEventListener(t, dispatch(t)); });
      render();
      if (comp.componentDidMount) comp.componentDidMount();
    }
  };
})();
