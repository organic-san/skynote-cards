// 標籤欄的推薦面板。
//
// 既有的標籤依「用過幾張卡」由多到少排，游標進到欄位就跳出來，
// 打字時用**游標所在的那一節**過濾。點一個標籤是取代那一節，不是追加到結尾——
// 「打幾個字 → 看到符合的 → 點下去」要能是一個連續動作，
// 追加到結尾會把你打到一半的字留成孤兒。
//
// 這不是標籤正規化（那是事後合併，spec 明確排除）。它不改任何資料，
// 只是在你打字的當下讓你看見既有的，降低分歧產生的機率——一個是修正，一個是預防。
//
// 已經填在欄位裡的不顯示：那一項點下去不會有任何效果，列出來只是雜訊。

(function () {
  var field = document.getElementById('tagsfield');
  if (!field) return;
  var input = field.querySelector('input[name=tags]');
  var panel = field.querySelector('.tagpicker');
  if (!input || !panel) return;

  var ALL = JSON.parse(field.dataset.tags || '[]');
  if (ALL.length === 0) return;

  // 分隔符只有空白，所以「游標所在的那一節」就是往兩邊找到空白為止。
  function tokenAt(value, pos) {
    var start = pos;
    while (start > 0 && !/\s/.test(value.charAt(start - 1))) start -= 1;
    var end = pos;
    while (end < value.length && !/\s/.test(value.charAt(end))) end += 1;
    return { start: start, end: end, text: value.slice(start, end) };
  }

  function used() {
    return input.value.split(/\s+/).filter(function (t) { return t !== ''; });
  }

  function pick(tag) {
    var tok = tokenAt(input.value, input.selectionStart);
    var before = input.value.slice(0, tok.start);
    var after = input.value.slice(tok.end);
    input.value = before + tag + ' ' + after.replace(/^\s+/, '');
    var caret = (before + tag + ' ').length;
    input.focus();
    input.setSelectionRange(caret, caret);
    render();
  }

  function render() {
    var tok = tokenAt(input.value, input.selectionStart);
    var q = tok.text.toLowerCase();
    var taken = used();
    // 正在打的那一節不算「已經填了」——否則打到一半自己就把自己濾掉了。
    var here = taken.indexOf(tok.text);
    if (here > -1) taken.splice(here, 1);

    var list = ALL.filter(function (t) {
      if (taken.indexOf(t.tag) > -1) return false;
      return q === '' || t.tag.toLowerCase().indexOf(q) > -1;
    });

    panel.textContent = '';

    function row(text, count, tag) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (count !== null) {
        var n = document.createElement('span');
        n.className = 'pid';
        n.textContent = count;
        b.appendChild(n);
      }
      // mousedown 而不是 click：click 之前欄位會先失焦，面板就關掉了。
      b.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        pick(tag);
      });
      panel.appendChild(b);
    }

    // 僅推薦既有標籤；無匹配時收合推薦面板。
    list.forEach(function (t) { row(t.tag, t.n, t.tag); });

    if (panel.children.length === 0) { panel.classList.remove('on'); return; }
    panel.classList.add('on');
  }

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('click', render);
  input.addEventListener('keyup', render);
  input.addEventListener('blur', function () { panel.classList.remove('on'); });
})();
