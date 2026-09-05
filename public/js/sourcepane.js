// 來源面板：拖曳分隔線，以及把選取的原文插成引用。
//
// 這兩件事的存在條件是同一個——畫面上有一份來源卡片可以讀。
// 沒有來源面板的 /new（裸的新增）兩件都不會發生。

(function () {
  var body = document.querySelector('#newform textarea[name=body]');

  // ---------------------------------------------------------------- 引用原文

  var sourcetext = document.getElementById('sourcetext');
  var quotebtn = document.getElementById('quotebtn');

  if (sourcetext && quotebtn && body) {
    var pending = null;
    // 游標位置：按引用鈕的時候 textarea 沒有焦點，所以要自己記著。
    var caret = null;
    ['keyup', 'click', 'blur'].forEach(function (e) {
      body.addEventListener(e, function () { caret = body.selectionStart; });
    });

    // 選取在哪個頂層區塊裡，就記下那個區塊的序號。來源卡片不可變，
    // 所以這個序號永遠指得回同一段文字。
    function capture() {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      var range = sel.getRangeAt(0);
      if (!sourcetext.contains(range.commonAncestorContainer)) return null;
      var text = sel.toString().trim();
      if (text === '') return null;
      var node = range.startContainer;
      var el = node.nodeType === 1 ? node : node.parentNode;
      var block = el && el.closest ? el.closest('[data-b]') : null;
      return { text: text, block: block ? block.dataset.b : null };
    }

    document.addEventListener('selectionchange', function () {
      pending = capture();
      quotebtn.disabled = !pending;
    });

    // pointerdown 在焦點跑掉之前就觸發，選取才還在。
    quotebtn.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      if (!pending) return;
      insertQuote(pending);
      pending = null;
      quotebtn.disabled = true;
    });

    function insertQuote(q) {
      var lines = q.text.split(/\r?\n/).map(function (l) {
        return l.trim() === '' ? '>' : '> ' + l;
      });
      var href = '/c/' + sourcetext.dataset.id + (q.block === null ? '' : '#b' + q.block);
      var label = sourcetext.dataset.title.replace(/([[\]])/g, '\$1');
      lines.push('> — [' + label + '](' + href + ')');

      var text = lines.join('\n') + '\n\n';
      var at = caret === null ? body.value.length : caret;
      var before = body.value.slice(0, at);
      var pad = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      body.value = before + pad + text + body.value.slice(at);

      caret = (before + pad + text).length;
      if (document.activeElement === body) body.setSelectionRange(caret, caret);
      // 內容是程式改的，所以要自己通知——欄位長高在 grow.js，它聽的是 input。
      body.dispatchEvent(new Event('input'));
    }
  }

  // ---------------------------------------------------------------- 分隔線

  var split = document.getElementById('split');
  var splitbar = document.getElementById('splitbar');
  if (!split || !splitbar) return;

  // 這個斷點必須跟 css/form.css 裡的一致。
  var wide = window.matchMedia('(min-width: 50rem)');
  // 左右分與上下分的比例分開記：轉向換了版面，沿用同一個數字會很莫名其妙。
  var keyFor = function () { return 'append-cards:split:' + (wide.matches ? 'col' : 'row'); };

  var apply = function (pct) { split.style.setProperty('--split', pct + '%'); };
  var restore = function () {
    var saved = null;
    try { saved = localStorage.getItem(keyFor()); } catch (e) { /* 無痕視窗，用預設 */ }
    if (saved) apply(saved);
    else split.style.removeProperty('--split');
  };
  restore();
  wide.addEventListener('change', restore);

  splitbar.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    splitbar.setPointerCapture(ev.pointerId);

    var move = function (e) {
      var r = split.getBoundingClientRect();
      var pct = wide.matches
        ? ((e.clientX - r.left) / r.width) * 100
        : ((e.clientY - r.top) / r.height) * 100;
      pct = Math.min(80, Math.max(15, pct)).toFixed(1);
      apply(pct);
      try { localStorage.setItem(keyFor(), pct); } catch (e2) { /* 存不了就算了 */ }
    };
    var up = function () {
      splitbar.removeEventListener('pointermove', move);
      splitbar.removeEventListener('pointerup', up);
    };
    splitbar.addEventListener('pointermove', move);
    splitbar.addEventListener('pointerup', up);
  });
})();
