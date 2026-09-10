/* ============================================================
 * 马老师的故事屋 —— 播放器逻辑
 * ============================================================ */
(function () {
  "use strict";

  var CFG = window.MS_HOUSE;
  if (!CFG) {
    console.error("找不到节目单 stories.js，请确认两个 js 都已加载。");
    return;
  }

  /* ---------- DOM ---------- */
  var el = {
    greetingCard: document.getElementById("greeting-card"),
    greetEmoji: document.getElementById("greet-emoji"),
    greetTitle: document.getElementById("greet-title"),
    greetDesc: document.getElementById("greet-desc"),
    greetNote: document.getElementById("greet-note"),
    list: document.getElementById("episode-list"),
    count: document.getElementById("episode-count"),
    footSub: document.getElementById("foot-sub"),
    player: document.getElementById("player"),
    playerEmoji: document.getElementById("player-emoji"),
    playerTitle: document.getElementById("player-title"),
    playerSub: document.getElementById("player-sub"),
    seek: document.getElementById("seek"),
    timeCur: document.getElementById("time-cur"),
    timeDur: document.getElementById("time-dur"),
    btnStart: document.getElementById("btn-start"),
    btnPause: document.getElementById("btn-pause"),
    btnStop: document.getElementById("btn-stop"),
    toast: document.getElementById("toast")
  };

  /* ---------- 数据准备 ---------- */
  // 期号取自 id（s7 → 7），与上架顺序天然一致：server-app 的 nextId() 取「最大编号 + 1」
  function epNum(ep) {
    var m = /^s(\d+)$/.exec((ep && ep.id) || "");
    return m ? parseInt(m[1], 10) : 0;
  }

  var greeting = CFG.greeting;
  var episodes = CFG.episodes.filter(function (ep) {
    return !(ep.demo && CFG.includeDemo === false); // includeDemo=false 时隐藏 demo 条
  });
  // 最新上架的排最前面。排序只发生在这里，不动数据文件——工作台每次上架都往
  // house-data.json 的 episodes 末尾 push，改写数据文件的话下次上架就又乱了。
  var ordered = episodes.slice().sort(function (a, b) { return epNum(b) - epNum(a); });

  var playable = []; // 顺序拍平的播放队列（含开场白），跟列表顺序一致
  if (greeting && greeting.ready && greeting.file) playable.push(greeting);
  ordered.forEach(function (ep) {
    if (ep.ready && ep.file) playable.push(ep);
  });

  /* ---------- 播放器核心 ---------- */
  var audio = new Audio();
  audio.preload = "metadata"; // 取到时长后进度条才可用；none 会让播放前 duration 一直是 NaN
  var current = null;      // 当前条目
  var _toastTimer = null;
  var KEY = "ms-house-v1";

  /* ---------- 工具 ---------- */
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" + s : s);
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        id: current ? current.id : null,
        time: audio.currentTime || 0
      }));
    } catch (e) { /* 忽略隐私模式等异常 */ }
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () {
      el.toast.classList.remove("show");
    }, 2200);
  }

  function markActive() {
    document.querySelectorAll(".episode.is-playing, .greeting.is-playing")
      .forEach(function (n) { n.classList.remove("is-playing"); });
    if (!current) return;
    var hit = document.querySelector('[data-ep="' + current.id + '"]');
    if (hit) hit.classList.add("is-playing");
  }

  function setPlayerUI(item) {
    var label = item.title;
    if (item.demo) label = "试听 · " + (item.title || "示例声音");
    el.playerEmoji.textContent = item.emoji || "🎧";
    el.playerTitle.textContent = label;
    el.playerSub.textContent = item.demo ? "演示声音 · 正式版会替换" : (CFG.teacher + " · " + (item.tag || "讲故事"));
    el.player.hidden = false;
    syncButtons();
  }

  // 高亮当前状态对应的按键：播放中亮「开始」，暂停中亮「暂停」
  function syncButtons() {
    var playing = !!current && !audio.paused;
    el.btnStart.classList.toggle("is-on", playing);
    el.btnPause.classList.toggle("is-on", !!current && audio.paused);
  }

  /* ---------- 进度条 ---------- */
  var isDragging = false; // 用户正按着进度条（input 已触发、change 还没来）
  var pendingFrac = null; // 时长还没到位时，先把「拖到几成」记下来，元数据一到就补上

  // 只负责把时间画到界面上：滑块位置 / 填充条 / 两个时间数字
  function paintProgress(c, d) {
    var pct = d ? (c / d) * 100 : 0;
    if (!isFinite(pct) || pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    el.seek.value = Math.round(pct * 10); // max=1000
    el.seek.style.setProperty("--fill", pct + "%");
    el.timeCur.textContent = fmt(c);
    if (d) el.timeDur.textContent = fmt(d);
  }

  function updateProgress() {
    if (isDragging) return; // 拖动中：绝不让 timeupdate 把滑块拽回播放位置
    var d = audio.duration;
    if (!isFinite(d)) d = 0; // 元数据没到位时是 NaN，流式源会是 Infinity，都要归一
    paintProgress(audio.currentTime || 0, d);
  }

  /* ---------- 播放控制 ---------- */
  // 音频地址带上内容版本号。服务端给音频发的是长缓存（它不能带 must-revalidate，
  // 否则 Chrome 拖进度条会卡死），所以「重录了要能听到新的」这件事只能靠 URL 失效：
  // 文件一变，stories.js 里的 v 就变，地址跟着变，浏览器自然去取新的。
  function srcOf(item) {
    return item.v ? item.file + "?v=" + item.v : item.file;
  }

  function loadAndPlay(item) {
    if (!item || !item.ready || !item.file) {
      toast((item && item.note) || "这个节目还在筹备中，等马老师备好稿就来～");
      return;
    }
    if (current && current.id === item.id && !audio.paused) {
      pause();
      return;
    }
    if (current && current.id === item.id) { // 同一条，续播
      audio.play().then(syncButtons).catch(playBlocked);
      return;
    }
    current = item;
    audio.src = srcOf(item); // 换源后播放位置会自动回到 0
    setPlayerUI(item);
    markActive();
    save();
    audio.play().then(syncButtons).catch(playBlocked);
  }

  function pause() {
    audio.pause();
    syncButtons();
    save();
  }

  function playBlocked() {
    // 浏览器自动播放被拦截：界面已在，让用户手动再点一次
    syncButtons();
    toast("点一下「开始」就能播放");
  }

  // 结束：停止播放 + 收起播放条，并清掉续播记忆
  // 不清记忆的话，刷新页面 restore() 会把播放条重新弹出来，和「收起」自相矛盾
  function stop() {
    audio.pause();
    try { audio.currentTime = 0; } catch (e) { /* 元数据未就绪时可能抛错，忽略 */ }
    current = null;
    isDragging = false;
    pendingFrac = null;
    // 释放媒体资源。只 pause 不清 src 的话，元素会一直挂着这条音频（networkState 停在 LOADING），
    // 「结束」就不算真的结束。load() 会中断传输并让元素回到空状态。
    // 若浏览器因此抛 error 事件，上面的 error 处理器有 current 判空，不会被误触发。
    try { audio.removeAttribute("src"); audio.load(); } catch (e) { /* ignore */ }
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    el.player.hidden = true;
    el.seek.value = 0;
    el.seek.style.setProperty("--fill", "0%");
    el.timeCur.textContent = "0:00";
    el.timeDur.textContent = "0:00";
    markActive();
    syncButtons();
  }

  function nextPlayable(forward) {
    if (!playable.length) return null;
    var i = playable.indexOf(current);
    var n = forward ? 1 : -1;
    var next = playable[(i + n + playable.length) % playable.length];
    return next === current ? null : next;
  }

  /* ---------- 事件 ---------- */
  function bindItem(elNode, item) {
    elNode.addEventListener("click", function () {
      if (item.demo && CFG.includeDemo === false) return;
      if (item.ready && item.file) loadAndPlay(item);
      else toast(item.note || "马老师正在备稿，这个小故事很快就能听啦～");
    });
  }

  function renderGreeting() {
    if (!greeting) return;
    el.greetEmoji.textContent = greeting.emoji || "📣";
    el.greetTitle.textContent = greeting.title;
    el.greetDesc.textContent = greeting.desc;
    if (greeting.ready && greeting.file) {
      el.greetNote.textContent = "▶ 点击收听";
      el.greetingCard.classList.add("is-ready");
    } else {
      el.greetNote.textContent = greeting.note || "🎙️ 录制中";
    }
    el.greetingCard.dataset.ep = greeting.id;
    bindItem(el.greetingCard, greeting);
  }

  function renderList() {
    el.list.innerHTML = "";
    var readyCount = 0;
    ordered.forEach(function (ep) { // 最新上架的排最前面
      if (ep.ready && ep.file) readyCount++;

      var li = document.createElement("li");
      var cover = document.createElement("span");
      cover.className = "episode-cover";
      cover.textContent = ep.emoji || "📖";
      cover.style.background = ep.tone || "#f6a24e";

      var body = document.createElement("span");
      body.className = "episode-body";

      var t = document.createElement("span");
      t.className = "episode-title";
      if (ep.demo) {
        t.textContent = ep.title;
      } else {
        // 期号跟着故事本身走（s9 永远是第 9 期），不随列表位置变
        t.textContent = "第 " + epNum(ep) + " 期 · " + ep.title;
      }
      if (ep.demo) {
        var demoTag = document.createElement("i");
        demoTag.className = "episode-live";
        demoTag.textContent = "演示";
        t.appendChild(demoTag);
      }

      var d = document.createElement("span");
      d.className = "episode-desc";
      d.textContent = ep.desc || "";

      body.appendChild(t);
      body.appendChild(d);

      var status = document.createElement("span");
      status.className = "episode-status";
      if (ep.ready && ep.file) {
        var bReady = document.createElement("span");
        bReady.className = "badge badge-ready";
        bReady.textContent = ep.demo ? "可试听" : "可收听";
        status.appendChild(bReady);
        if (ep.duration) {
          var dur = document.createElement("span");
          dur.className = "badge-dur";
          dur.textContent = ep.duration;
          status.appendChild(dur);
        }
      } else {
        var bPending = document.createElement("span");
        bPending.className = "badge badge-pending";
        bPending.textContent = "筹备中";
        status.appendChild(bPending);
      }

      var row = document.createElement("button");
      row.type = "button";
      row.className = "episode";
      row.dataset.ep = ep.id;
      row.appendChild(cover);
      row.appendChild(body);
      row.appendChild(status);
      bindItem(row, ep);
      el.list.appendChild(row);
    });

    // 计数
    if (readyCount > 0) {
      el.count.textContent = readyCount + " 集可听";
    } else {
      el.count.textContent = "筹备中";
    }
    if (el.footSub) {
      var footer = CFG.teacher + "的故事屋 · 已收录 " + (episodes.length + 1) + " 个故事 · 持续更新中";
      el.footSub.textContent = footer;
    }
  }

  /* ---------- 事件绑定 ---------- */
  el.btnStart.addEventListener("click", function () {
    if (!current) {
      // 还没有播放记录：从「开场白 → 最新一集」开始
      var first = playable[0];
      if (first && first.demo && !CFG.includeDemo) first = null;
      if (first) loadAndPlay(first);
      else toast("故事还在筹备中，先点点试听那一条吧～");
      return;
    }
    if (audio.paused) {
      audio.play().then(syncButtons).catch(playBlocked);
    }
  });

  el.btnPause.addEventListener("click", function () {
    if (!audio.paused) pause();
  });

  el.btnStop.addEventListener("click", stop);

  // 拖动中只做预览（时间数字 + 填充条），不写 audio.currentTime：
  // input 每移动一像素就触发一次，写 currentTime 会造成 seek 请求风暴，且中间的 seek 会被丢弃
  el.seek.addEventListener("input", function () {
    // 无条件置位。滑块是浏览器原生行为，这里就算什么都不做它也会跟着手走；
    // 若因「时长还没拿到」提前 return 而不置位，松手时 commitSeek 会以为自己没在拖，
    // 整段拖动被静默吞掉——手柄动了、声音没动、还不报错，最难查的就是这种。
    isDragging = true;
    var d = audio.duration;
    var frac = el.seek.value / 1000;
    if (!d || !isFinite(d)) {
      pendingFrac = frac; // 元数据还没到：先记账，loadedmetadata 里补做
      return;
    }
    pendingFrac = null;
    var t = frac * d;
    el.timeCur.textContent = fmt(t);
    el.seek.style.setProperty("--fill", (t / d) * 100 + "%");
  });

  // 真正落地：写 currentTime + 立刻刷新界面 + 从新位置起播
  function applyFrac(frac, d) {
    if (!isFinite(d) || d <= 0) return; // NaN（元数据缺失）/ Infinity（流式源）都不能拿来算位置
    audio.currentTime = frac * d;
    updateProgress(); // 不等 timeupdate，界面立刻钉到目标位置
    save();
    // 松手就从新位置开始播——不管拖动前是播放还是暂停，符合「拖到哪儿就从哪儿开始播放」
    if (current && audio.paused) audio.play().then(syncButtons).catch(playBlocked);
  }

  // 松手（或键盘调整完）才真正提交，一次拖动只发一个 seek 请求
  function commitSeek() {
    if (!isDragging) return; // 幂等：change 和 pointerup 谁先到都只提交一次
    isDragging = false;
    var frac = el.seek.value / 1000;
    var d = audio.duration;
    if (!d || !isFinite(d)) { pendingFrac = frac; return; } // 交给 loadedmetadata 补做
    applyFrac(frac, d);
  }
  el.seek.addEventListener("change", commitSeek);
  // 兜底：个别浏览器/拖动方式可能不发 change，那样 isDragging 会永久卡住、进度条再也不更新。
  // 挂在 window 上还顺带覆盖了「拖到控件外松手」。
  window.addEventListener("pointerup", commitSeek);
  window.addEventListener("pointercancel", commitSeek);

  // seek 真正落地后再对一次表（WAV 是无压缩 PCM，seeked 后位置就是精确目标）
  audio.addEventListener("seeked", function () {
    if (!isDragging) updateProgress();
  });

  audio.addEventListener("timeupdate", updateProgress);
  audio.addEventListener("loadedmetadata", function () {
    // 用户在元数据到位前就拖过进度条：以那次拖动为准，补做，别再恢复旧进度把他拽回去
    if (pendingFrac !== null) {
      var f = pendingFrac;
      pendingFrac = null;
      applyFrac(f, audio.duration);
      return;
    }
    updateProgress();
    // 恢复记忆播放位置
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (current && saved && saved.id === current.id && saved.time > 2 && saved.time < (audio.duration - 5)) {
        audio.currentTime = saved.time;
      }
    } catch (e) { /* ignore */ }
  });
  audio.addEventListener("ended", function () {
    var nxt = nextPlayable(true);
    if (nxt) loadAndPlay(nxt);
    else {
      current = null;
      markActive();
      save();
      syncButtons();
    }
  });
  audio.addEventListener("error", function () {
    if (current && current.id) {
      toast("这个音频还没准备好（" + current.title + "），换个试试？");
      current = null;
      markActive();
      el.player.hidden = true;
      syncButtons();
    }
  });

  // 恢复上次听到的位置
  function restore() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!saved || !saved.id) return;
      var found = null;
      if (greeting && greeting.id === saved.id) found = greeting;
      else found = episodes.filter(function (e) { return e.id === saved.id; })[0];
      if (found && found.ready && found.file) {
        current = found;
        audio.src = srcOf(found);
        setPlayerUI(found);
        markActive();
        updateProgress();
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- 分享 ---------- */
  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(txt);
    }
    return new Promise(function (res, rej) {
      var ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); res(); } catch (e) { rej(e); }
      ta.remove();
    });
  }

  function initShare() {
    var btn = document.getElementById("btn-share");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var url = location.href;
      var host = location.hostname;
      // 本机预览时分享没有意义，先提示
      if (host === "localhost" || host === "127.0.0.1" || host.indexOf("192.168.") === 0) {
        toast("现在还是本机预览地址，发布到公网后，点这里就能把链接发给孩子们啦～");
        return;
      }
      var text = "来「" + CFG.title + "」听马老师讲故事吧 🐴✨";
      if (navigator.share) {
        navigator.share({ title: CFG.title, text: text, url: url }).catch(function () { });
      } else {
        copyText(url).then(function () {
          toast("链接已复制，去微信里粘贴给孩子们吧 ✉️");
        }, function () {
          toast("请手动复制当前网址发给孩子们：" + url);
        });
      }
    });
  }

  /* ---------- 初始化 ---------- */
  renderGreeting();
  renderList();
  initShare();
  restore();
})();
