// 建立表單：連結列與目標搜尋、來源面板的分隔線、把選取的原文插成引用。

(function () {
  var form = document.getElementById('newform');
  if (!form) return;

  var rows = document.getElementById('linkrows');
  var tpl = document.getElementById('linkrowtpl');
  var addlink = document.getElementById('addlink');
  var body = form.querySelector('textarea[name=body]');

  // ---------------------------------------------------------------- provenance

  // provenance 只對 original 有意義。關掉的 select 不會被送出，
  // 所以這一步同時也是在保證別的類型不會夾帶這個欄位。
  function syncProvenance() {
    var field = document.getElementById('provfield');
    if (!field) return;
    var picked = form.querySelector('input[name=type]:checked');
    var on = !!picked && picked.value === 'original';
    field.classList.toggle('off', !on);
    field.querySelector('select').disabled = !on;
  }

  form.addEventListener('change', function (ev) {
    if (ev.target.name === 'type') syncProvenance();
    if (ev.target.name === 'link_rel') {
      ev.target.closest('.linkrow').className = 'linkrow rel-' + ev.target.value;
    }
  });

  // ---------------------------------------------------------------- 內文長高

  function grow() {
    if (!body) return;
    body.style.height = 'auto';
    body.style.height = body.scrollHeight + 'px';
  }
  if (body) body.addEventListener('input', grow);

  // 游標位置：按引用鈕的時候 textarea 沒有焦點，所以要自己記著。
  var caret = null;
  if (body) {
    ['keyup', 'click', 'blur'].forEach(function (e) {
      body.addEventListener(e, function () { caret = body.selectionStart; });
    });
  }

  // ---------------------------------------------------------------- 連結列

  if (addlink) {
    addlink.addEventListener('click', function () {
      rows.appendChild(tpl.content.cloneNode(true));
      var inputs = rows.querySelectorAll('.linkto');
      inputs[inputs.length - 1].focus();
    });
  }

  function closePicker(picker) {
    picker.classList.remove('on');
    picker.textContent = '';
  }

  function showPicker(picker, input, results) {
    picker.textContent = '';
    if (results.length === 0) { closePicker(picker); return; }
    results.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.title;
      var meta = document.createElement('span');
      meta.className = 'pid';
      meta.textContent = ' ' + r.type + ' · ' + r.id;
      b.appendChild(meta);
      b.addEventListener('click', function () {
        input.value = r.id;
        var name = input.parentNode.querySelector('.linkname');
        if (name) name.textContent = r.title;
        closePicker(picker);
      });
      picker.appendChild(b);
    });
    picker.classList.add('on');
  }

  var timers = new WeakMap();

  if (rows) {
    rows.addEventListener('input', function (ev) {
      var input = ev.target;
      if (!input.classList || !input.classList.contains('linkto')) return;
      var picker = input.parentNode.querySelector('.picker');
      var q = input.value.trim();

      clearTimeout(timers.get(input));
      if (q === '' || /^[0-9]{8,}$/.test(q)) { closePicker(picker); return; }
      timers.set(input, setTimeout(function () {
        fetch('/api/search?limit=10&q=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (list) { showPicker(picker, input, list); })
          .catch(function () { closePicker(picker); });
      }, 200));
    });

    // 在連結欄按 Enter 是要選目標，不是要送出整張表單。
    rows.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && ev.target.classList.contains('linkto')) ev.preventDefault();
    });

    rows.addEventListener('click', function (ev) {
      var rm = ev.target.closest('.rmlink');
      if (rm) rm.closest('.linkrow').remove();
    });
  }

  document.addEventListener('click', function (ev) {
    Array.prototype.forEach.call(document.querySelectorAll('.picker.on'), function (p) {
      if (!p.parentNode.contains(ev.target)) closePicker(p);
    });
  });

  // ---------------------------------------------------------------- 引用原文

  var sourcetext = document.getElementById('sourcetext');
  var quotebtn = document.getElementById('quotebtn');

  if (sourcetext && quotebtn && body) {
    var pending = null;

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
      var label = sourcetext.dataset.title.replace(/([[\]])/g, '\\$1');
      lines.push('> — [' + label + '](' + href + ')');

      var text = lines.join('\n') + '\n\n';
      var at = caret === null ? body.value.length : caret;
      var before = body.value.slice(0, at);
      var pad = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      body.value = before + pad + text + body.value.slice(at);

      caret = (before + pad + text).length;
      if (document.activeElement === body) {
        body.setSelectionRange(caret, caret);
      }
      grow();
    }
  }

  // ---------------------------------------------------------------- 分隔線

  var split = document.getElementById('split');
  var splitbar = document.getElementById('splitbar');

  if (split && splitbar) {
    // 這個斷點必須跟 style.css 裡的一致。
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
  }

  syncProvenance();
  grow();
})();
