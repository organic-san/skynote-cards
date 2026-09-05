// 連結列：關係的收窄、目標的標題搜尋、加一列與去掉一列。
//
// 建立頁與編輯頁共用。這支檔案不知道自己在哪一頁，它只認得一個區塊：
//
//   #linksfield[data-rels][data-card-type]   關係表與「這張卡是什麼型別」
//     #linkrows                              列的容器
//     #addlink                               加一列
//   #linkrowtpl                              一列長什麼樣（<template>）
//
// 型別會不會變是別人的事：建立頁的型別由 typefields.js 換，換完就改寫
// data-card-type，這裡用 MutationObserver 看著那個屬性。兩邊因此不互相呼叫，
// 也不必知道對方存在——編輯頁沒有 typefields.js，那個屬性就永遠不動。

(function () {
  var region = document.getElementById('linksfield');
  if (!region) return;

  var rows = document.getElementById('linkrows');
  var tpl = document.getElementById('linkrowtpl');
  var addlink = document.getElementById('addlink');

  var RELS = JSON.parse(region.dataset.rels || '{}');
  var currentType = function () { return region.dataset.cardType || ''; };

  // ---------------------------------------------------------------- 關係的收窄

  // rel 的選項收窄兩次：先依「這張卡的型別」，目標已知時再依「目標的型別」。
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

  function paintAll() {
    Array.prototype.forEach.call(region.querySelectorAll('.linkrow'), paintRow);
  }

  // 型別換了就重畫。用屬性觀察而不是讓 typefields.js 呼叫過來：
  // 那樣兩邊就得互相知道，而且順序一錯就有一邊拿到舊值。
  new MutationObserver(paintAll).observe(region, {
    attributes: true,
    attributeFilter: ['data-card-type'],
  });

  region.addEventListener('change', function (ev) {
    if (ev.target.name === 'link_rel') {
      ev.target.closest('.linkrow').className = 'linkrow rel-' + ev.target.value;
    }
  });

  // ---------------------------------------------------------------- 加一列、去一列

  if (addlink && rows && tpl) {
    addlink.addEventListener('click', function () {
      rows.appendChild(tpl.content.cloneNode(true));
      paintRow(rows.lastElementChild);
      var inputs = rows.querySelectorAll('.linkto');
      inputs[inputs.length - 1].focus();
    });
  }

  if (rows) {
    rows.addEventListener('click', function (ev) {
      var rm = ev.target.closest('.rmlink');
      // 去掉的是還沒送出的那一列。已經存在的連結不在這裡，也刪不掉（R7）。
      if (rm) rm.closest('.linkrow').remove();
    });

    // 在連結欄按 Enter 是要選目標，不是要送出整張表單。
    rows.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && ev.target.classList.contains('linkto')) ev.preventDefault();
    });
  }

  // ---------------------------------------------------------------- 目標的搜尋

  // 每一列的 ID 存在同一列的 hidden 欄位裡，看得到的那個框只放標題。
  function setTarget(input, id) {
    var row = input.closest('.linkrow');
    var h = row ? row.querySelector('input[type=hidden][name=link_to]') : null;
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
  }

  document.addEventListener('click', function (ev) {
    Array.prototype.forEach.call(document.querySelectorAll('.picker.on'), function (p) {
      if (!p.parentNode.contains(ev.target)) closePicker(p);
    });
  });

  paintAll();
})();
