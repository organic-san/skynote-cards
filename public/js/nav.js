// 換頁不換文件：站內的連結與表單用 fetch 取回下一頁，換掉 <body>，再把那一頁的腳本跑一次。
//
// 為什麼（v3.1 §4.4）：Ferdium 把頁面包在 Electron 的 <webview> 裡，那裡沒有 paint holding。
// 一般分頁換頁時，舊畫面會留到新頁畫出第一格；webview 裡新文件一接手，舊畫面就沒了，
// 中間露出外殼的底色（Ferdium 開深色模式時是一塊黑）。CSS 嵌進頁面、電腦不載網路字型
// 只把那段空檔縮短；只要換文件，空檔就在。放進 Ferdium 不會閃的那些服務都是單頁應用：
// 文件從頭到尾是同一份，舊內容一直留在畫面上，直到新內容一次換上。
//
// 換 body 與跑腳本在同一個工作裡做完，中間不會畫出任何一格：下一格就是新頁面，
// 而且腳本已經跑過（日期已經換成「今天」，引用串已經收好）。
//
// 頁面的腳本不必改寫。它們本來就是「載入時跑一次」：綁在 body 裡元素上的東西，跟著舊 body
// 一起丟掉；綁在 document、window 這類不會換掉的對象上的監聽，這裡在那些腳本執行的期間
// 記下來，換頁前拆掉。拆之前先照瀏覽器離開頁面時的樣子送一次 pagehide——draft.js 靠它
// 把還在等的最後幾個字存起來。只記腳本執行期間掛上的，Ferdium 之類的外殼自己掛的不碰。
//
// 任何一步不對（回來的不是 Skynote 的頁面、樣式跟這一頁不同代表剛部署過、網路錯誤），
// 就退回一般的換頁。沒有這支腳本，連結與表單照常運作。

(function () {
  if (!window.fetch || !window.DOMParser || !window.history.pushState) return;

  var add = EventTarget.prototype.addEventListener;
  var remove = EventTarget.prototype.removeEventListener;

  // ------------------------------------------------------------ 頁面腳本掛上的監聽

  var held = [];
  // 從這裡到 DOMContentLoaded 之間，跑的是這一頁其他的 defer 腳本（它們排在這支後面）。
  var recording = true;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    // body 裡的元素會跟著舊 body 一起丟掉，不用記。
    if (recording && listener && !(this instanceof Element && document.body && document.body.contains(this))) {
      held.push([this, type, listener, options]);
    }
    return add.call(this, type, listener, options);
  };

  function call(listener, ev) {
    try {
      if (typeof listener === 'function') listener.call(window, ev);
      else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(ev);
    } catch (e) {
      setTimeout(function () { throw e; }); // 報出去，但不擋住換頁。
    }
  }

  function leave() {
    var gone = held;
    held = [];
    var ev;
    try { ev = new PageTransitionEvent('pagehide', { persisted: false }); } catch (e) { ev = new Event('pagehide'); }
    gone.forEach(function (h) { if (h[0] === window && h[1] === 'pagehide') call(h[2], ev); });
    gone.forEach(function (h) { remove.call(h[0], h[1], h[2], h[3]); });
  }

  // ------------------------------------------------------------ 腳本的內容

  // 依網址（帶著版本）記住每支腳本的內容。換頁時要在同一個工作裡跑完，等不了下載。
  var sources = {};
  function source(src) {
    if (!sources[src]) {
      sources[src] = fetch(src, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error(src + ' ' + r.status);
        return r.text();
      });
      sources[src].catch(function () { delete sources[src]; });
    }
    return sources[src];
  }

  function pageScripts(d) { return Array.prototype.slice.call(d.body.querySelectorAll('script')); }
  function textOf(s) { var src = s.getAttribute('src'); return src ? source(src) : Promise.resolve(s.textContent); }

  function run(scripts, texts) {
    recording = true;
    try {
      scripts.forEach(function (s, i) {
        var el = document.createElement('script');
        var src = s.getAttribute('src');
        el.text = texts[i] + (src ? '\n//# sourceURL=' + new URL(src, location.href).href : '');
        document.body.appendChild(el); // 內嵌的腳本一插進去就同步執行。
        el.remove();
      });
    } finally {
      recording = false;
    }
  }

  // ------------------------------------------------------------ 換得過去嗎

  function own(d) { return d.querySelector('head script[src^="/static/js/nav.js"]'); }
  function styles(d) { return Array.prototype.map.call(d.head.querySelectorAll('style'), function (s) { return s.textContent; }); }

  // 同一版的這支腳本，而且那一頁的樣式一份不差地出現在現在的 <head> 裡
  // （外殼可能另外插了自己的樣式，所以是依序找得到，不是完全相等），才換得過去。
  // 否則多半是剛部署過：整頁重新載入，拿新的樣式與腳本。
  function fits(d) {
    var mine = own(document), theirs = own(d);
    if (!mine || !theirs || mine.getAttribute('src') !== theirs.getAttribute('src')) return false;
    var cur = styles(document), i = 0;
    return styles(d).every(function (t) {
      while (i < cur.length && cur[i] !== t) i += 1;
      return i++ < cur.length;
    });
  }

  // ------------------------------------------------------------ 捲動位置
  //
  // 回上一頁時捲回原本的位置。瀏覽器自己的還原會在 popstate 當下捲動舊的畫面，
  // 新內容還沒到——那一下跳動本身就是一閃，所以改由這裡在換上新內容之後捲。

  history.scrollRestoration = 'manual';
  var saving = null;
  function remember() {
    clearTimeout(saving);
    saving = null;
    try { history.replaceState({ skynote: true, scroll: window.scrollY }, ''); } catch (e) { /* 太頻繁被擋，下次再記 */ }
  }
  add.call(window, 'scroll', function () {
    clearTimeout(saving);
    saving = setTimeout(remember, 150);
  }, { passive: true });
  // 真的離開（重新整理、關掉、表單以外的整頁載入）也記一次，回來時照樣捲得回去。
  add.call(window, 'pagehide', remember);

  // ------------------------------------------------------------ 換頁

  function here() { return location.pathname + location.search; }
  var shown = here();
  var seq = 0;
  var pending = null; // 進行中的 GET，又點了別的就放棄
  var posting = false;
  var slow = null; // 等太久才標 aria-busy（css/base.css）

  function show(doc, scripts, texts, url, opts) {
    if (opts.pop) { clearTimeout(saving); saving = null; } else remember();
    leave();
    scripts.forEach(function (s) { s.remove(); });
    document.title = doc.title;
    document.body.replaceWith(document.adoptNode(doc.body));
    var next = new URL(url, location.href);
    // 跟現在同一個網址就不另開一筆歷史，跟瀏覽器自己的做法一樣。
    if (!opts.pop) {
      if (next.href === location.href) history.replaceState({ skynote: true }, '', next.href);
      else history.pushState({ skynote: true }, '', next.href);
    }
    shown = here();
    // 網址要先換好：draft.js 讀的是網址上的 ?d=。
    run(scripts, texts);
    // 一份文件只在第一次載入時處理 autofocus（搜尋頁的輸入框），換上的內容要自己來。
    var auto = document.querySelector('[autofocus]');
    if (auto && auto.offsetParent !== null) auto.focus({ preventScroll: true });
    // 捲動放在腳本之後：收起引用串會改變頁面的高度。
    var anchor = next.hash && document.getElementById(decodeURIComponent(next.hash.slice(1)));
    if (opts.pop && typeof opts.scroll === 'number') window.scrollTo(0, opts.scroll);
    else if (anchor) anchor.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  /*
    opts.body：POST 的內容。opts.pop：回上一頁、下一頁，歷史已經在那一筆了。

    POST 不中途放棄、也不重送：伺服器可能已經建好卡片了。所以送出去之後就算又點了別的，
    結果照樣收下（只是不畫）；送出的過程中再按一次送出則不理。
  */
  function visit(url, opts) {
    opts = opts || {};
    var id = ++seq;
    if (pending) pending.abort();
    pending = opts.body ? null : new AbortController();
    if (opts.body) posting = true;
    clearTimeout(slow);
    slow = setTimeout(function () { document.documentElement.setAttribute('aria-busy', 'true'); }, 400);
    var got = null;
    return fetch(url, {
      method: opts.body ? 'POST' : 'GET',
      body: opts.body,
      headers: { accept: 'text/html' },
      credentials: 'same-origin',
      signal: pending ? pending.signal : undefined,
    })
      .then(function (res) {
        got = res;
        if ((res.headers.get('content-type') || '').indexOf('text/html') !== 0) throw new Error('不是頁面');
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        if (!fits(doc)) throw new Error('不是同一版的頁面');
        var scripts = pageScripts(doc);
        return Promise.all(scripts.map(textOf)).then(function (texts) {
          if (id !== seq) return;
          // POST 沒有導向（驗證失敗退回表單、「更新」的結果）：網址留在按下去的那一頁。
          // fetch 給的網址沒有 #，要接回去。
          var to = opts.body && !got.redirected ? location.href : got.url;
          var hash = new URL(url, location.href).hash;
          if (hash && to.indexOf('#') < 0) to += hash;
          show(doc, scripts, texts, to, opts);
        });
      })
      .catch(function () {
        if (id !== seq) return; // 已經換去別頁了，不把人拉走
        // 退回一般的換頁。POST 已經有回應，表示伺服器處理過了，不能再送一次：去它導向的地方。
        // 還沒有回應（斷線、IAP 要重新登入）就重新載入這一頁；打的字還在草稿裡（draft.js）。
        if (!opts.body) location.assign(url);
        else if (got) location.assign(got.url);
        else location.reload();
      })
      .then(function () {
        if (opts.body) posting = false;
        if (id === seq) {
          pending = null;
          clearTimeout(slow);
          document.documentElement.removeAttribute('aria-busy');
        }
      });
  }

  // ------------------------------------------------------------ 哪些要接手

  function ours(u) {
    return u.origin === location.origin && u.pathname.indexOf('/static/') !== 0;
  }

  add.call(document, 'click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    var u = new URL(a.href);
    if (!ours(u)) return;
    // 同一頁裡的錨點交給瀏覽器。
    if (u.hash && u.pathname + u.search === here()) return;
    ev.preventDefault();
    visit(u.href);
  });

  // 冒泡到 document 才接：表單自己的處理（editform.js 改用 PUT）先跑，取消了就不管。
  add.call(document, 'submit', function (ev) {
    if (ev.defaultPrevented) return;
    var form = ev.target;
    var by = ev.submitter;
    var method = ((by && by.getAttribute('formmethod')) || form.getAttribute('method') || 'get').toLowerCase();
    var target = (by && by.getAttribute('formtarget')) || form.getAttribute('target');
    if ((method !== 'get' && method !== 'post') || (target && target !== '_self')) return;
    if (form.enctype === 'multipart/form-data' || form.querySelector('input[type=file]')) return;
    var u = new URL(by && by.hasAttribute('formaction') ? by.formAction : form.action);
    if (!ours(u)) return;
    ev.preventDefault();
    if (posting) return;
    var data = new URLSearchParams(by ? new FormData(form, by) : new FormData(form));
    if (method === 'get') {
      u.search = data.toString();
      visit(u.href);
    } else {
      visit(u.href, { body: data });
    }
  });

  add.call(window, 'popstate', function (ev) {
    if (here() === shown) return; // 只是頁內錨點的上一步
    visit(location.href, { pop: true, scroll: ev.state && ev.state.scroll });
  });

  // 腳本自己要換頁的時候（editform.js 存好之後）。
  window.skynoteNav = {
    visit: function (url) { visit(new URL(url, location.href).href); },
  };

  add.call(document, 'DOMContentLoaded', function () {
    recording = false;
    // 重新整理或從別處回來：捲回離開時的位置（scrollRestoration 已經交給這裡了）。
    var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    var st = history.state;
    if (nav && (nav.type === 'reload' || nav.type === 'back_forward') && st && typeof st.scroll === 'number') {
      window.scrollTo(0, st.scroll);
    }
    // 先把這一頁的腳本內容拿好，第一次換頁就不必再等下載。
    var warm = function () { pageScripts(document).forEach(textOf); };
    if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 2000 }); else setTimeout(warm, 500);
  }, { once: true });
})();
