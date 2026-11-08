// Markdown 工具列與清單延續（v3.2 §4）。
//
// 兩件事，都只是少打幾個字：
// 1. 文字框上方那一排按鈕（mdbar.eta）。待辦、清單、引用加在行首；粗體、斜體、程式碼、連結包住選取。
//    同一顆再按一次就拿掉它加上的東西。
// 2. 在清單項目上按 Enter，下一行自動帶出同樣的記號（待辦一律從 [ ] 起）。
//    空的那一項再按一次 Enter 就結束清單。在編號清單中間插進一項，後面的編號跟著順延（v3.3 §7）。
//
// 文字框仍然是原生的 textarea，送出去的就是框裡的原文。這支檔案只替你打字。
//
// 改字一律用 execCommand('insertText')。這樣改的字會進瀏覽器的復原紀錄（Ctrl+Z 退得回去），
// 也會自己發出 input 事件，草稿暫存（draft.js）不用另外通知。這個 API 已經被標成廢棄，
// 可是在文字框裡要改字又要保留復原紀錄，沒有別的辦法（copy.js 也做了同樣的取捨）。
// 它不能用的時候就直接改 value，代價是復原紀錄斷在那一步。
//
// 上半部只做文字運算：輸入原文與選取範圍，交回「把哪一段換成什麼、選取落在哪裡」，
// 不碰 DOM。test/v3.2.test.ts 用 vm 載入這支檔案，直接測這幾支函式。

(function () {
  // ---------------------------------------------------------------- 一行的結構

  // 行首依序是：引言的 > 與縮排、清單記號、待辦的方框。
  // 待辦的判準跟 render.ts 的 TASK_RE 一致：方框後面必須是空白或行尾，所以 `[x](網址)` 算連結。
  var LINE_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*)(?:([-*+]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[([ xX])\](?:[ \t]+|$))?)?/;

  function parse(line) {
    var m = LINE_RE.exec(line);
    var marker = m[2] || '';
    return {
      lead: m[1],
      marker: marker,
      ordered: /^\d/.test(marker),
      // 沒有清單記號時，方框不算待辦（`[ ] 事情` 不是標記，跟渲染一致）。
      task: m[3] === undefined ? null : m[3] === ' ' ? ' ' : 'x',
      // 行首結構到哪裡為止，後面才是內容。
      head: m[0].length,
    };
  }

  function lineStart(value, p) {
    return p === 0 ? 0 : value.lastIndexOf('\n', p - 1) + 1;
  }

  function lineEnd(value, p) {
    var at = value.indexOf('\n', p);
    return at === -1 ? value.length : at;
  }

  // 選取碰到的那幾行。選取的終點如果停在某一行的開頭（例如拖選一整行時），那一行不算在內。
  function lineRange(value, s, e) {
    var last = e > s && value.charAt(e - 1) === '\n' ? e - 1 : e;
    return { from: lineStart(value, s), to: lineEnd(value, last) };
  }

  function blank(line) {
    return line.trim() === '';
  }

  // ---------------------------------------------------------------- 行首的按鈕

  // 逐行改寫。fn 對每一行交回 null（不動），或 { at, del, ins }：從這一行第 at 個字起刪掉 del 個，再插入 ins。
  // 選取跟著內容走：原本選到的字，改完之後仍然選著；游標落在被換掉的記號裡的，移到新記號的後面。
  function editLines(value, s, e, fn) {
    var r = lineRange(value, s, e);
    var src = value.slice(r.from, r.to).split('\n');
    var prev = r.from === 0 ? null : value.slice(lineStart(value, r.from - 1), r.from - 1);
    var edits = fn(src, prev);

    var out = [];
    var rows = [];
    var pos = r.from;
    var delta = 0;
    src.forEach(function (line, i) {
      var ed = edits[i];
      out.push(ed ? line.slice(0, ed.at) + ed.ins + line.slice(ed.at + ed.del) : line);
      rows.push({ start: pos, ed: ed, before: delta });
      if (ed) delta += ed.ins.length - ed.del;
      pos += line.length + 1;
    });

    function map(p) {
      var i = rows.length - 1;
      while (i > 0 && p < rows[i].start) i -= 1;
      var row = rows[i];
      var ed = row.ed;
      var off = p - row.start;
      if (!ed || off < ed.at) return p + row.before;
      if (off < ed.at + ed.del) return row.start + row.before + ed.at + ed.ins.length;
      return p + row.before + ed.ins.length - ed.del;
    }

    return { from: r.from, to: r.to, text: out.join('\n'), selStart: map(s), selEnd: map(e) };
  }

  // 選了好幾行時，中間的空行不加記號；只有一行時，空行也照加（游標停在空行上按，就是要開始一個清單）。
  function targets(src) {
    var multi = src.length > 1;
    var t = src.map(function (l) { return !(multi && blank(l)); });
    return t.some(Boolean) ? t : src.map(function () { return true; });
  }

  /*
    清單與待辦。三顆按鈕各管一件事：
    - 待辦、已完成：設定方框。沒有清單記號的行補上 `- `；編號清單保留編號（`1. [ ]` 也是待辦）。
    - 清單、編號：設定清單記號，方框原樣留著。
    每一行都已經是這個狀態時，就把整個行首結構拿掉（記號連同方框），變回一般的文字：
    一個方框前面沒有清單記號，就不是待辦了。
  */
  function setList(kind, state) {
    return function (src, prev) {
      var ps = src.map(parse);
      var on = targets(src);
      var has = function (p) {
        if (kind === 'task') return p.marker !== '' && p.task === state;
        if (kind === 'bullet') return p.marker !== '' && !p.ordered;
        return p.ordered;
      };
      var all = ps.every(function (p, i) { return !on[i] || has(p); });

      // 編號接著上一行的編號往下排；上一行不是同一層的編號清單，就從 1 開始。
      var n = 1;
      var pp = prev === null ? null : parse(prev);
      var first = ps[on.indexOf(true)];
      if (pp && pp.ordered && first && pp.lead === first.lead) n = parseInt(pp.marker, 10) + 1;

      return ps.map(function (p, i) {
        if (!on[i]) return null;
        var at = p.lead.length;
        var del = p.head - at;
        if (all) return { at: at, del: del, ins: '' };
        var task = kind === 'task' ? state : p.task;
        var marker;
        if (kind === 'ordered') {
          marker = n + (p.ordered ? p.marker.slice(-1) : '.');
          n += 1;
        } else if (kind === 'bullet') {
          marker = p.marker !== '' && !p.ordered ? p.marker : '-';
        } else {
          marker = p.marker || '-';
        }
        return { at: at, del: del, ins: marker + ' ' + (task === null ? '' : '[' + task + '] ') };
      });
    };
  }

  // 引用：每一行前面加 `> `。選了好幾行時中間的空行補一個 `>`，引言才不會從那裡斷開（同 sourcepane.js 的引用）。
  // 每一行都已經在引言裡時，拿掉一層。
  function quote(src) {
    var multi = src.length > 1;
    var quoted = function (l) { return /^[ \t]*>/.test(l); };
    var all = src.every(function (l) { return (multi && blank(l)) || quoted(l); });
    return src.map(function (l) {
      if (all) {
        var m = /^([ \t]*)>[ \t]?/.exec(l);
        return m ? { at: m[1].length, del: m[0].length - m[1].length, ins: '' } : null;
      }
      if (quoted(l)) return null;
      return { at: 0, del: 0, ins: multi && blank(l) ? '>' : '> ' };
    });
  }

  // ---------------------------------------------------------------- 包住選取的按鈕

  var MARKS = { bold: '**', italic: '*', code: '`' };

  // 選取兩側連著幾個同樣的記號字元。
  function runBack(value, p, ch, stop) {
    var k = 0;
    while (p - k > stop && value.charAt(p - k - 1) === ch) k += 1;
    return k;
  }

  function runFwd(value, p, ch, stop) {
    var k = 0;
    while (p + k < stop && value.charAt(p + k) === ch) k += 1;
    return k;
  }

  // 兩側的記號是不是「這一種」。`*` 同時是斜體與粗體的字元，要看連著幾個：
  // 奇數個（`*`、`***`）裡有一層斜體，兩個以上裡有一層粗體。
  function fits(name, k) {
    if (name === 'italic') return k % 2 === 1;
    if (name === 'bold') return k >= 2;
    return k >= 1;
  }

  function wrap(value, s, e, name) {
    var mark = MARKS[name];
    var ch = mark.charAt(0);
    var n = mark.length;

    // 程式碼選了好幾行：行內的反引號包不住換行，改成程式碼區塊。
    if (name === 'code' && value.slice(s, e).indexOf('\n') !== -1) {
      var r = lineRange(value, s, e);
      var block = value.slice(r.from, r.to);
      return { from: r.from, to: r.to, text: '```\n' + block + '\n```', selStart: r.from + 4, selEnd: r.from + 4 + block.length };
    }

    // 選取兩端的空白留在記號外面：`**字 **` 不會變粗體（雙擊選字常常連後面的空格一起選進去）。
    while (s < e && /\s/.test(value.charAt(s))) s += 1;
    while (e > s && /\s/.test(value.charAt(e - 1))) e -= 1;

    var before = runBack(value, s, ch, 0);
    var after = runFwd(value, e, ch, value.length);

    if (s === e) {
      // 一對剛按出來、還沒打字的空記號，再按一次就收回去。
      if (before === n && after === n) return { from: s - n, to: s + n, text: '', selStart: s - n, selEnd: s - n };
      return { from: s, to: s, text: mark + mark, selStart: s + n, selEnd: s + n };
    }
    // 記號在選取外面：拿掉。
    if (fits(name, before) && fits(name, after)) {
      return { from: s - n, to: e + n, text: value.slice(s, e), selStart: s - n, selEnd: e - n };
    }
    // 記號被選在裡面：也拿掉。
    if (e - s > 2 * n && fits(name, runFwd(value, s, ch, e)) && fits(name, runBack(value, e, ch, s))) {
      return { from: s, to: e, text: value.slice(s + n, e - n), selStart: s, selEnd: e - 2 * n };
    }
    return { from: s, to: e, text: mark + value.slice(s, e) + mark, selStart: s + n, selEnd: e + n };
  }

  // 連結：選的是網址就放進括號、游標停在方括號裡等你打字；選的是字就當連結文字、游標停在括號裡等網址。
  function link(value, s, e) {
    while (s < e && /\s/.test(value.charAt(s))) s += 1;
    while (e > s && /\s/.test(value.charAt(e - 1))) e -= 1;
    var sel = value.slice(s, e);
    if (sel === '') return { from: s, to: s, text: '[]()', selStart: s + 1, selEnd: s + 1 };
    if (/^(?:https?:\/\/|\/)\S*$/.test(sel)) {
      return { from: s, to: e, text: '[](' + sel + ')', selStart: s + 1, selEnd: s + 1 };
    }
    var at = s + sel.length + 3;
    return { from: s, to: e, text: '[' + sel + ']()', selStart: at, selEnd: at };
  }

  // ---------------------------------------------------------------- Enter

  // 程式碼區塊裡的 `- ` 不是清單（渲染也不把它當清單），Enter 照常換行。
  function inFence(value, from) {
    return ((value.slice(0, from).match(/^[ \t]{0,3}(?:```|~~~)/gm) || []).length) % 2 === 1;
  }

  // Enter 在編號清單中間插進一項之後，同一層後面的編號往後順延（v3.3 §7）。
  // 渲染只看第一項的數字，畫面上本來就是連續的；這裡修的是原文——編輯時看到的、
  // 複製與下載出去的 .md。
  //
  // 從 at（目前這一行的行尾）往下一行一行看：
  // - 同一層的編號項目：引言與縮排（lead）一模一樣、分隔符號一樣（. 或 )）。照順序改成 n、n+1……
  // - 比它深的行（子清單、項目裡縮排的續行）與空行：跳過，清單還沒結束。
  // - 其他（同層換成 - 清單、換了分隔符號、縮排變淺、沒有縮排的一般文字）：這張清單到此為止。
  // 交回從 at 到最後一個改到的行尾要換成什麼；一行都不用改就是 null。
  function renumber(value, at, lead, delim, n) {
    var lines = [];
    var last = -1;
    var pos = at;
    while (pos < value.length) {
      var from = pos + 1;
      var stop = lineEnd(value, from);
      var line = value.slice(from, stop);
      var p = parse(line);
      if (p.marker === '' && blank(line.slice(p.head))) {
        // 空行（引言裡只剩 > 的也算）：清單可以隔著空行。
      } else if (p.lead === lead && p.ordered && p.marker.slice(-1) === delim) {
        var want = n + delim;
        if (p.marker !== want) {
          line = lead + want + line.slice(lead.length + p.marker.length);
          last = lines.length;
        }
        n++;
      } else if (!(p.lead.length > lead.length && p.lead.slice(0, lead.length) === lead)) {
        break;
      }
      lines.push({ text: line, stop: stop });
      pos = stop;
    }
    if (last === -1) return null;
    return {
      to: lines[last].stop,
      text: lines.slice(0, last + 1).map(function (l) { return '\n' + l.text; }).join(''),
    };
  }

  function enter(value, s, e) {
    if (s !== e) return null;
    var from = lineStart(value, s);
    var to = lineEnd(value, s);
    var line = value.slice(from, to);
    var p = parse(line);
    // 不在清單項目上，或游標在記號前面（在行首按 Enter 是想把這一項往下推），照常換行。
    if (p.marker === '' || s - from < p.head) return null;
    if (inFence(value, from)) return null;

    if (blank(line.slice(p.head))) {
      // 空的一項：結束清單。還在引言裡的話 > 留著，只是縮排的話一起拿掉。
      var keep = /\S/.test(p.lead) ? p.lead : '';
      return { from: from, to: to, text: keep, selStart: from + keep.length, selEnd: from + keep.length };
    }

    var marker = p.ordered ? parseInt(p.marker, 10) + 1 + p.marker.slice(-1) : p.marker;
    // 待辦的下一項一律從未完成開始：剛打下去的那一件不會已經做完。
    var next = '\n' + p.lead + marker + ' ' + (p.task === null ? '' : '[ ] ');
    var caret = s + next.length;
    var rest = p.ordered ? renumber(value, to, p.lead, p.marker.slice(-1), parseInt(p.marker, 10) + 2) : null;
    if (!rest) return { from: s, to: s, text: next, selStart: caret, selEnd: caret };
    // 後面的編號一起改，仍然是一次替換：Ctrl+Z 一次就連插入帶重排一起退回去。
    return { from: s, to: rest.to, text: next + value.slice(s, to) + rest.text, selStart: caret, selEnd: caret };
  }

  function edit(name, value, s, e) {
    switch (name) {
      case 'task': return editLines(value, s, e, setList('task', ' '));
      case 'done': return editLines(value, s, e, setList('task', 'x'));
      case 'bullet': return editLines(value, s, e, setList('bullet'));
      case 'ordered': return editLines(value, s, e, setList('ordered'));
      case 'quote': return editLines(value, s, e, quote);
      case 'bold':
      case 'italic':
      case 'code': return wrap(value, s, e, name);
      case 'link': return link(value, s, e);
      default: return null;
    }
  }

  // 給測試用（見檔頭）。頁面上沒有別的程式碼呼叫它們。
  window.skynoteMd = { edit: edit, enter: enter };

  // ---------------------------------------------------------------- 接上文字框

  if (typeof document === 'undefined' || !document.querySelectorAll) return;

  function apply(ta, ed) {
    if (!ed) return;
    if (document.activeElement !== ta) ta.focus();
    var v = ta.value;
    var want = v.slice(0, ed.from) + ed.text + v.slice(ed.to);
    if (want !== v) {
      ta.setSelectionRange(ed.from, ed.to);
      var ok = false;
      try { ok = document.execCommand('insertText', false, ed.text); } catch (err) { ok = false; }
      if (!ok || ta.value !== want) {
        ta.value = want;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    ta.setSelectionRange(ed.selStart, ed.selEnd);
  }

  function attach(ta) {
    var touched = false;
    ta.addEventListener('focus', function () { touched = true; });

    var bar = ta.previousElementSibling;
    if (bar && bar.classList.contains('mdbar')) {
      // 按鈕不拿走焦點：文字框的選取還在，手機的鍵盤也不會收起來。焦點是在 mousedown 移走的
      // （觸控時是點完之後補發的那個 mousedown），所以擋的是它。
      // 動作放在 click 而不是按下的那一刻：手指按下去又滑開就不算數。
      bar.addEventListener('mousedown', function (ev) {
        if (ev.target.closest('.mdbtn')) ev.preventDefault();
      });
      bar.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.mdbtn');
        if (!btn || ta.disabled) return;
        // 還沒點進過文字框就按：瀏覽器把游標放在最前面，接在最後面才是想要的。
        if (!touched) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        apply(ta, edit(btn.dataset.md, ta.value, ta.selectionStart, ta.selectionEnd));
      });
    }

    // Shift+Enter 是「我就是要換行」：不延續清單。
    var plain = false;

    function lineBreak(ev) {
      var ed = enter(ta.value, ta.selectionStart, ta.selectionEnd);
      if (!ed) return;
      ev.preventDefault();
      apply(ta, ed);
    }

    ta.addEventListener('keydown', function (ev) {
      plain = ev.key === 'Enter' && (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey);
      // 注音、倉頡選字時按的 Enter 是在確認組字，不是換行。
      if (ev.key !== 'Enter' || plain || ev.isComposing || ev.keyCode === 229) return;
      lineBreak(ev);
    });

    // 手機的虛擬鍵盤常常不給 keydown 真正的按鍵（keyCode 229），這時只能在這裡看到換行。
    // keydown 已經處理掉的不會走到這裡：preventDefault 之後就不會發生這次輸入。
    // 不能取消的（有些輸入法在組字中送出的換行）不碰，否則會變成兩個換行。
    ta.addEventListener('beforeinput', function (ev) {
      if (ev.inputType !== 'insertLineBreak' && ev.inputType !== 'insertParagraph') return;
      if (plain || ev.isComposing || !ev.cancelable) return;
      lineBreak(ev);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('textarea[data-mdbar]'), attach);
})();
