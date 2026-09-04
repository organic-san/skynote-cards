// 建立表單：連結列與目標搜尋、來源面板的分隔線、把選取的原文插成引用。

(function () {
  var form = document.getElementById('newform');
  if (!form) return;

  var rows = document.getElementById('linkrows');
  var tpl = document.getElementById('linkrowtpl');
  var addlink = document.getElementById('addlink');
  var body = form.querySelector('textarea[name=body]');

  // ---------------------------------------------------------------- 依型別分歧

  // 哪一型顯示哪些欄位，是伺服器那張表送過來的，不在這裡再寫一次。
  // 關掉的欄位一律 disabled：既不會被送出，隱藏的必填欄位也不會擋住送出。
  var SPECS = JSON.parse(form.dataset.specs || '{}');
  var RELS = JSON.parse(form.dataset.rels || '{}');

  var FIELDS = {
    singlefield: function (s) { return s.single; },
    titlefield: function (s) { return !s.single; },
    bodyfield: function (s) { return !s.single; },
    tagsfield: function (s) { return !s.single; },
    urlfield: function (s) { return s.url; },
    sourcefields: function (s) { return s.source; },
    provfield: function (s) { return s.source; },
    linksfield: function (s) { return s.links; }
  };

  // 型別可能是一組 radio，也可能是一個 hidden input（由入口決定、鎖住的時候）。
  // form.elements 兩種都認得：RadioNodeList 的 value 是被選中的那個，
  // 單一 input 的 value 就是它自己。用 ':checked' 找會在鎖住時整個瞎掉。
  function currentType() {
    var el = form.elements.type;
    return el && typeof el.value === 'string' ? el.value : '';
  }

  function syncType() {
    // 沒選型別時什麼都不開——這一組要跟伺服器的 formSpec() 退回值一致。
    var spec = SPECS[currentType()] || { single: false, url: false, source: false, links: false };
    var hint = document.getElementById('linkshint');
    if (hint) hint.classList.toggle('off', spec.links);
    Object.keys(FIELDS).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var on = FIELDS[id](spec);
      el.classList.toggle('off', !on);
      Array.prototype.forEach.call(el.querySelectorAll('input, textarea, select'), function (c) {
        c.disabled = !on;
        // 標題與那句話互為替身：開著的那一個才是必填的。
        if (c.name === 'title' || c.name === 'quick_body') c.required = on;
      });
    });
    syncRelOptions(spec);
  }

  // rel 的選項收窄兩次：先依「新卡的型別」，目標已知時再依「目標的型別」。
  // 列不出來的組合按下去只會被規則擋掉，而被擋的當下使用者看不出為什麼——
  // 所以乾脆不列。這是硬性規則能不刺人的前提。
  function optionsFor(row) {
    var all = RELS[currentType()] || [];
    var input = row.querySelector('.linkto');
    var targetType = input ? input.dataset.targetType : '';
    if (!targetType) return all;
    var narrowed = all.filter(function (o) { return o.targets.indexOf(targetType) !== -1; });
    // 目標型別認不得就退回整組，寧可多列也不要給一個空選單。
    return narrowed.length > 0 ? narrowed : all;
  }

  function paintRow(row) {
    var sel = row.querySelector('select[name=link_rel]');
    if (!sel) return;
    var options = optionsFor(row);
    if (options.length === 0) return;

    var keep = sel.value;
    sel.textContent = '';
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    // 換了型別或換了參照對象之後，原本那條關係可能不再合法，
    // 落回第一個仍然合法的——表單任何時候都停在規則之內。
    sel.value = options.some(function (o) { return o.value === keep; }) ? keep : options[0].value;
    row.className = 'linkrow rel-' + sel.value;
  }

  function syncRelOptions(spec) {
    if (!spec.links) return;
    if ((RELS[currentType()] || []).length === 0) return;
    Array.prototype.forEach.call(form.querySelectorAll('.linkrow'), paintRow);
  }

  form.addEventListener('change', function (ev) {
    if (ev.target.name === 'type') syncType();
    if (ev.target.name === 'link_rel') {
      ev.target.closest('.linkrow').className = 'linkrow rel-' + ev.target.value;
    }
  });

  // ---------------------------------------------------------------- 內文長高

  // 隨內容長高，但有上限——貼一篇長文進來時，欄位若無限長高，
  // 底下的標籤與連結就會被推到幾千像素之外，整份表單變得沒辦法調整。
  // 到頂之後改成內部捲動。
  // 使用者一旦自己拖過高度，就別再自動改它——那是他明確表達過的偏好。
  var grown = null;
  function grow() {
    if (!body) return;
    if (grown !== null && Math.abs(body.offsetHeight - grown) > 1) return;
    body.style.height = 'auto';
    var max = parseInt(getComputedStyle(body).getPropertyValue('--grow-max'), 10);
    if (getComputedStyle(body).getPropertyValue('--grow-max').indexOf('vh') > -1) {
      max = (window.innerHeight * max) / 100;
    }
    var want = body.scrollHeight;
    var h = isNaN(max) ? want : Math.min(want, max);
    body.style.height = h + 'px';
    body.style.overflowY = !isNaN(max) && want > max ? 'auto' : 'hidden';
    grown = body.offsetHeight;
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
      paintRow(rows.lastElementChild);
      var inputs = rows.querySelectorAll('.linkto');
      inputs[inputs.length - 1].focus();
    });
  }

  // 每一列的 ID 存在同一列的 hidden 欄位裡，看得到的那個框只放標題。
  function hiddenOf(input) {
    var row = input.closest('.linkrow');
    return row ? row.querySelector('input[type=hidden][name=link_to]') : null;
  }
  function setTarget(input, id) {
    var h = hiddenOf(input);
    if (h) h.value = id;
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
        // U15：看得到的是標題，送出去的是 ID。整套設計的目的就是
        // 使用者永遠不必碰 ID——把 18 位數當欄位主值是主次相反。
        input.value = r.title;
        setTarget(input, r.id);
        // 換了參照對象，這一列可用的關係就跟著換——目標的型別決定了一半的規則。
        input.dataset.targetType = r.type || '';
        closePicker(picker);
        paintRow(input.closest('.linkrow'));
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

      // 手打或貼上的 ID 不知道型別，先前那個目標的型別不再算數。
      // 認不得就退回整組選項，由伺服器擋——總比列一組錯的好。
      if (input.dataset.targetType) {
        input.dataset.targetType = '';
        paintRow(input.closest('.linkrow'));
      }

      // 沒有從選單挑、直接打字的內容原樣送出去：貼 ID 仍然可用，
      // 打了標題卻沒挑的話，伺服器會說「ID 格式錯誤」——那比靜默丟掉好。
      setTarget(input, q);

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

  syncType();
  grow();
})();
