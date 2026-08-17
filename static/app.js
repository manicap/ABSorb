/* ABS Grok frontend */

const ROW_HEIGHT = 58;

const state = {
  left: [],
  right: [],
  leftSort: "name",
  rightSort: "name",
  leftSortDir: 1,
  rightSortDir: 1,
  selectedLeftId: null,
  selectedRightId: null,
  eventSource: null,
  filters: {
    found: true,
    uncertain: true,
    not_found: true,
  },
  recentLeft: [],
  recentRight: [],
  leftQuery: "",
  rightQuery: "",
  enrichAbort: false,
  enrichRunning: false,
  libraries: [],
  playerLeft: null,
  playerRight: null,
  currentLeftItem: null,
  currentRightItem: null,
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadConfig();
  await updateCacheButton();
  setupSortButtons();
  setupPathInputs();
  setupFilterButtons();
  setupBrowseButtons();
  setupSearch();
  setupPlayers();
  setupBadgePreviews();
  updateSortIndicators("left");
  updateSortIndicators("right");

  if ((state.libraries || []).length) {
    const stats = document.getElementById("stats");
    if (stats) stats.classList.remove("hidden");
    // Load library browser immediately (do not wait for Porovnat)
    try {
      await loadSide("right", false);
    } catch (e) {
      console.warn("Auto-load library failed", e);
    }
  }
});

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    document.getElementById("leftPath").value = cfg.left_path || "";
    const rp = document.getElementById("rightPath");
    if (rp) rp.value = cfg.right_path || "";
    state.recentLeft = cfg.recent_left || [];
    state.recentRight = cfg.recent_right || [];
    state.libraries = cfg.libraries || [];
    updateLibCountLabel();
    renderLibraryToggles();
  } catch (e) {
    console.warn("Config load failed", e);
  }
}

function setupPathInputs() {
  const save = debounce(async () => {
    const left = document.getElementById("leftPath").value.trim();
    const right = document.getElementById("rightPath").value.trim();
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ left_path: left, right_path: right }),
    });
    const data = await res.json();
    if (data.config) {
      state.recentLeft = data.config.recent_left || [];
      state.recentRight = data.config.recent_right || [];
    }
  }, 600);

  document.getElementById("leftPath")?.addEventListener("input", save);
  document.getElementById("rightPath")?.addEventListener("input", save);
}

function setupSortButtons() {
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = btn.dataset.panel;
      const sort = btn.dataset.sort;

      btn.parentElement.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      if (panel === "left") {
        if (state.leftSort === sort) state.leftSortDir *= -1;
        else {
          state.leftSort = sort;
          state.leftSortDir = 1;
        }
        updateSortIndicators("left");
        renderList("left");
      } else {
        if (state.rightSort === sort) state.rightSortDir *= -1;
        else {
          state.rightSort = sort;
          state.rightSortDir = 1;
        }
        updateSortIndicators("right");
        renderList("right");
      }
    });
  });
}

function updateSortIndicators(panel) {
  const sortKey = panel === "left" ? state.leftSort : state.rightSort;
  const dir = panel === "left" ? state.leftSortDir : state.rightSortDir;
  const arrow = dir === 1 ? "↑" : "↓";

  document.querySelectorAll(`.sort-btn[data-panel="${panel}"]`).forEach((btn) => {
    const span = btn.querySelector(".sort-dir");
    if (!span) return;
    if (btn.dataset.sort === sortKey) {
      span.textContent = arrow;
    } else {
      span.textContent = "";
    }
  });
}

function setupFilterButtons() {
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.filter;
      state.filters[key] = !state.filters[key];
      btn.classList.toggle("active", state.filters[key]);
      renderList("left");
    });
  });
}

function setupBrowseButtons() {
  document.getElementById("btnLeftBrowse")?.addEventListener("click", () => openPathModal("left"));
  document.getElementById("btnRightBrowse")?.addEventListener("click", () => openPathModal("right"));
}



// ---------------------------------------------------------------------------
// Mini audio players (multi-file playlist)
// ---------------------------------------------------------------------------

function setupPlayers() {
  state.playerLeft = new Audio();
  state.playerRight = new Audio();
  state.playerLeft.preload = "metadata";
  state.playerRight.preload = "metadata";
  state._seeking = { left: false, right: false };
  state.playlist = { left: null, right: null }; // { files: [{name,url,duration}], index, total }

  bindPlayerEvents(state.playerLeft, "left");
  bindPlayerEvents(state.playerRight, "right");

  document.querySelectorAll(".player-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const side = btn.dataset.side;
      const action = btn.dataset.action;
      if (action === "play") togglePlay(side);
      else if (action === "stop") stopPlayer(side);
    });
  });

  ["left", "right"].forEach((side) => {
    const seek = document.getElementById(side === "left" ? "seekLeft" : "seekRight");
    const vol = document.getElementById(side === "left" ? "volLeft" : "volRight");

    seek.addEventListener("pointerdown", () => { state._seeking[side] = true; });
    seek.addEventListener("pointerup", () => { state._seeking[side] = false; });
    seek.addEventListener("pointercancel", () => { state._seeking[side] = false; });
    seek.addEventListener("input", (e) => {
      const t = parseFloat(e.target.value);
      if (isFinite(t)) seekPlaylist(side, t);
    });
    seek.addEventListener("change", (e) => {
      state._seeking[side] = false;
      const t = parseFloat(e.target.value);
      if (isFinite(t)) seekPlaylist(side, t);
    });

    vol.addEventListener("input", (e) => {
      const audio = side === "left" ? state.playerLeft : state.playerRight;
      if (audio) audio.volume = parseFloat(e.target.value);
    });
  });

  updatePlayerButtons("left", false, true);
  updatePlayerButtons("right", false, true);
}

function bindPlayerEvents(audio, side) {
  const seek = document.getElementById(side === "left" ? "seekLeft" : "seekRight");
  const timeEl = document.getElementById(side === "left" ? "timeLeft" : "timeRight");

  audio.addEventListener("loadedmetadata", () => {
    const pl = state.playlist[side];
    if (pl && pl.files[pl.index]) {
      pl.files[pl.index].duration = audio.duration || 0;
      recomputePlaylistTotal(side);
    }
    updateSeekUI(side);
  });

  audio.addEventListener("timeupdate", () => {
    if (state._seeking[side]) return;
    updateSeekUI(side);
  });

  audio.addEventListener("play", () => updatePlayerButtons(side, true));
  audio.addEventListener("pause", () => updatePlayerButtons(side, false));

  audio.addEventListener("ended", () => {
    // Auto-advance to next file in folder
    const pl = state.playlist[side];
    if (pl && pl.index < pl.files.length - 1) {
      playPlaylistIndex(side, pl.index + 1, 0, true);
    } else {
      updatePlayerButtons(side, false);
      if (pl) {
        pl.index = 0;
        loadPlaylistIndex(side, 0);
      }
      updateSeekUI(side);
    }
  });

  audio.addEventListener("error", () => {
    // Skip to next file on error
    const pl = state.playlist[side];
    if (pl && pl.index < pl.files.length - 1) {
      playPlaylistIndex(side, pl.index + 1, 0, true);
    } else {
      updatePlayerButtons(side, false);
      timeEl.textContent = "chyba";
    }
  });
}

function formatTime(sec) {
  if (!sec || !isFinite(sec)) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return m + ":" + String(s).padStart(2, "0");
}

function buildFileUrl(folder, filename) {
  const f = folder.replace(/[/\\]+$/, "");
  const full = f.endsWith("\\") || f.endsWith("/")
    ? f + filename
    : f + (f.includes("\\") ? "\\" : "/") + filename;
  return "/api/audio?path=" + encodeURIComponent(full);
}

function sortAudioFiles(files) {
  // Natural / chronological sort by filename
  return [...files].sort((a, b) =>
    a.localeCompare(b, "cs", { numeric: true, sensitivity: "base" })
  );
}

function recomputePlaylistTotal(side) {
  const pl = state.playlist[side];
  if (!pl) return;
  let total = 0;
  const offsets = [];
  for (const f of pl.files) {
    offsets.push(total);
    total += f.duration || 0;
  }
  pl.offsets = offsets;
  pl.total = total;

  const seek = document.getElementById(side === "left" ? "seekLeft" : "seekRight");
  if (total > 0) {
    seek.max = total;
    seek.disabled = false;
  }
  renderMarkers(side);
}

function renderMarkers(side) {
  const pl = state.playlist[side];
  const box = document.getElementById(side === "left" ? "markersLeft" : "markersRight");
  if (!box || !pl || !pl.total) {
    if (box) box.innerHTML = "";
    return;
  }
  // Markers at start of every file (including the first)
  box.innerHTML = "";
  for (let i = 0; i < pl.files.length; i++) {
    const offset = pl.offsets[i] || 0;
    const pct = pl.total > 0 ? (offset / pl.total) * 100 : 0;
    const m = document.createElement("div");
    m.className = "seek-marker";
    m.style.left = Math.min(pct, 99.5) + "%";
    m.title = pl.files[i].name;
    box.appendChild(m);
  }
}

function globalTime(side) {
  const audio = side === "left" ? state.playerLeft : state.playerRight;
  const pl = state.playlist[side];
  if (!pl) return audio.currentTime || 0;
  const off = pl.offsets ? pl.offsets[pl.index] || 0 : 0;
  return off + (audio.currentTime || 0);
}

function updateSeekUI(side) {
  const seek = document.getElementById(side === "left" ? "seekLeft" : "seekRight");
  const timeEl = document.getElementById(side === "left" ? "timeLeft" : "timeRight");
  const pl = state.playlist[side];
  const t = globalTime(side);
  const total = pl && pl.total ? pl.total : 0;
  if (!state._seeking[side]) seek.value = t;
  if (total > 0) seek.max = total;
  timeEl.textContent = formatTime(t) + (total > 0 ? " / " + formatTime(total) : "");
}

function loadPlaylistIndex(side, index) {
  const pl = state.playlist[side];
  const audio = side === "left" ? state.playerLeft : state.playerRight;
  if (!pl || index < 0 || index >= pl.files.length) return;
  pl.index = index;
  const file = pl.files[index];
  const absUrl = new URL(file.url, window.location.origin).href;
  if (audio.src !== absUrl) {
    audio.src = file.url;
    audio.load();
  }
}

function playPlaylistIndex(side, index, startTime, autoplay) {
  const audio = side === "left" ? state.playerLeft : state.playerRight;
  const vol = document.getElementById(side === "left" ? "volLeft" : "volRight");
  loadPlaylistIndex(side, index);
  audio.volume = vol ? parseFloat(vol.value) : 1;

  const onReady = () => {
    audio.removeEventListener("loadedmetadata", onReady);
    try {
      if (startTime > 0) audio.currentTime = startTime;
    } catch (_) {}
    if (autoplay) {
      audio.play().catch((err) => console.warn("play", err));
    }
    updateSeekUI(side);
  };

  if (audio.readyState >= 1) onReady();
  else audio.addEventListener("loadedmetadata", onReady);
}

function seekPlaylist(side, globalSec) {
  const pl = state.playlist[side];
  const audio = side === "left" ? state.playerLeft : state.playerRight;
  if (!pl || !pl.files.length) {
    try { audio.currentTime = globalSec; } catch (_) {}
    return;
  }

  // Find file containing this global time
  let idx = 0;
  for (let i = 0; i < pl.files.length; i++) {
    const start = pl.offsets[i] || 0;
    const dur = pl.files[i].duration || 0;
    const end = start + (dur > 0 ? dur : 1e12);
    if (globalSec >= start && globalSec < end) {
      idx = i;
      break;
    }
    if (i === pl.files.length - 1) idx = i;
  }

  const start = pl.offsets[idx] || 0;
  const local = Math.max(0, globalSec - start);
  const wasPlaying = !audio.paused;

  if (idx !== pl.index) {
    playPlaylistIndex(side, idx, local, wasPlaying);
  } else {
    try { audio.currentTime = local; } catch (_) {}
  }
  updateSeekUI(side);
}

function updateBadges(side, item) {
  const box = document.getElementById(side === "left" ? "badgesLeft" : "badgesRight");
  if (!box) return;
  const set = (kind, on) => {
    const el = box.querySelector(`[data-kind="${kind}"]`);
    if (el) el.classList.toggle("on", !!on);
  };
  if (!item) {
    set("id3", false); set("m4a", false); set("json", false); set("cover", false);
    return;
  }
  set("id3", item.has_id3);
  set("m4a", item.has_m4a);
  set("json", item.has_json);
  set("cover", item.has_cover);
}

function loadItemIntoPlayer(side, item) {
  const audio = side === "left" ? state.playerLeft : state.playerRight;
  const seek = document.getElementById(side === "left" ? "seekLeft" : "seekRight");
  const timeEl = document.getElementById(side === "left" ? "timeLeft" : "timeRight");
  const vol = document.getElementById(side === "left" ? "volLeft" : "volRight");

  if (side === "left") state.currentLeftItem = item;
  else state.currentRightItem = item;

  audio.pause();
  try { audio.currentTime = 0; } catch (_) {}
  updateBadges(side, item);

  if (!item || !item.path || !item.audio_files || !item.audio_files.length) {
    state.playlist[side] = null;
    audio.removeAttribute("src");
    audio.load();
    seek.value = 0; seek.max = 0; seek.disabled = true;
    timeEl.textContent = "—";
    renderMarkers(side);
    updatePlayerButtons(side, false, true);
    return;
  }

  const files = sortAudioFiles(item.audio_files).map((name) => ({
    name,
    url: buildFileUrl(item.path, name),
    duration: 0,
  }));

  state.playlist[side] = { files, index: 0, total: 0, offsets: files.map(() => 0) };
  audio.volume = vol ? parseFloat(vol.value) : 1;
  loadPlaylistIndex(side, 0);
  seek.value = 0;
  timeEl.textContent = "0:00";
  updatePlayerButtons(side, false, false);

  // Probe durations of all files via temporary Audio elements
  files.forEach((f, i) => {
    const probe = new Audio();
    probe.preload = "metadata";
    probe.src = f.url;
    probe.addEventListener("loadedmetadata", () => {
      f.duration = probe.duration || 0;
      recomputePlaylistTotal(side);
      updateSeekUI(side);
      probe.src = "";
    });
  });
}

function togglePlay(side) {
  const audio = side === "left" ? state.playerLeft : state.playerRight;
  const item = side === "left" ? state.currentLeftItem : state.currentRightItem;
  if (!item) return;

  if (!state.playlist[side]) loadItemIntoPlayer(side, item);

  if (audio.paused) {
    const other = side === "left" ? state.playerRight : state.playerLeft;
    if (other && !other.paused) other.pause();
    audio.play().catch((err) => {
      console.warn("Play failed", err);
      alert("Přehrávání selhalo. Zkontroluj soubor a formát (MP3/M4A obvykle fungují).");
    });
  } else {
    audio.pause();
  }
}

function stopPlayer(side) {
  const audio = side === "left" ? state.playerLeft : state.playerRight;
  const pl = state.playlist[side];
  if (!audio) return;
  audio.pause();
  try { audio.currentTime = 0; } catch (_) {}
  if (pl) {
    pl.index = 0;
    loadPlaylistIndex(side, 0);
  }
  updateSeekUI(side);
  updatePlayerButtons(side, false);
}

function updatePlayerButtons(side, playing, noAudio) {
  const playBtn = document.querySelector(`.player-btn[data-action="play"][data-side="${side}"]`);
  const stopBtn = document.querySelector(`.player-btn[data-action="stop"][data-side="${side}"]`);
  if (!playBtn || !stopBtn) return;

  if (noAudio) {
    playBtn.disabled = true;
    stopBtn.disabled = true;
    playBtn.classList.remove("playing");
    playBtn.textContent = "▶";
    return;
  }

  playBtn.disabled = false;
  stopBtn.disabled = false;
  playBtn.classList.toggle("playing", playing);
  playBtn.textContent = playing ? "❚❚" : "▶";
  playBtn.title = playing ? "Pauza" : "Přehrát";
}


// ---------------------------------------------------------------------------
// Search + suggestions
// ---------------------------------------------------------------------------

function setupSearch() {
  const leftInput = document.getElementById("leftSearch");
  const rightInput = document.getElementById("rightSearch");
  const leftClear = document.getElementById("leftSearchClear");
  const rightClear = document.getElementById("rightSearchClear");

  leftInput.addEventListener("input", debounce(() => {
    state.leftQuery = leftInput.value.trim();
    renderList("left");
    updateSuggestions("left");
  }, 120));

  rightInput.addEventListener("input", debounce(() => {
    state.rightQuery = rightInput.value.trim();
    renderList("right");
    updateSuggestions("right");
  }, 120));

  function clearSearch(panel) {
    const input = panel === "left" ? leftInput : rightInput;
    input.value = "";
    if (panel === "left") state.leftQuery = "";
    else state.rightQuery = "";
    document.getElementById(panel === "left" ? "leftSuggest" : "rightSuggest").classList.add("hidden");
    renderList(panel);
    input.focus();
  }

  leftClear.addEventListener("click", () => clearSearch("left"));
  rightClear.addEventListener("click", () => clearSearch("right"));

  leftInput.addEventListener("focus", () => updateSuggestions("left"));
  rightInput.addEventListener("focus", () => updateSuggestions("right"));

  leftInput.addEventListener("keydown", (e) => handleSuggestKey(e, "left"));
  rightInput.addEventListener("keydown", (e) => handleSuggestKey(e, "right"));

  // Close suggestions on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) {
      document.getElementById("leftSuggest").classList.add("hidden");
      document.getElementById("rightSuggest").classList.add("hidden");
    }
  });
}

function normalizeForSearch(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function itemMatchesQuery(item, query) {
  if (!query) return true;
  const q = normalizeForSearch(query);
  const hay = normalizeForSearch(
    [item.name, item.author, item.title, item.interpreter].filter(Boolean).join(" ")
  );
  // All tokens must match (order independent)
  return q.split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
}

function getSearchSource(panel) {
  if (panel === "left") {
    // Respect status filters, then search
    return state.left.filter((r) => {
      if (r.status === "found") return state.filters.found;
      if (r.status === "uncertain") return state.filters.uncertain;
      if (r.status === "not_found") return state.filters.not_found;
      return true;
    });
  }
  return state.right;
}

function updateSuggestions(panel) {
  const input = document.getElementById(panel === "left" ? "leftSearch" : "rightSearch");
  const box = document.getElementById(panel === "left" ? "leftSuggest" : "rightSuggest");
  const q = input.value.trim();

  if (!q || q.length < 1) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  const source = getSearchSource(panel);
  const matches = [];
  const qn = normalizeForSearch(q);

  for (const item of source) {
    if (itemMatchesQuery(item, q)) {
      matches.push(item);
      if (matches.length >= 12) break;
    }
  }

  // Prefer prefix matches first for nicer suggestions
  matches.sort((a, b) => {
    const an = normalizeForSearch(a.name);
    const bn = normalizeForSearch(b.name);
    const ap = an.startsWith(qn) ? 0 : 1;
    const bp = bn.startsWith(qn) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return an.localeCompare(bn, "cs");
  });

  if (matches.length === 0) {
    box.innerHTML = `<div class="suggest-empty">Nic nenalezeno</div>`;
    box.classList.remove("hidden");
    return;
  }

  box.innerHTML = matches.map((item, i) => `
    <div class="suggest-item${i === 0 ? " active" : ""}" data-id="${item.id}" data-panel="${panel}">
      <div class="suggest-name">${esc(item.name)}</div>
      <div class="suggest-sub">${esc(item.author || item.title || "")}</div>
    </div>
  `).join("");

  box.querySelectorAll(".suggest-item").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus logic simple
      const id = el.dataset.id;
      const p = el.dataset.panel;
      const sourceList = p === "left" ? state.left : state.right;
      const item = sourceList.find((r) => r.id === id);
      if (!item) return;

      // Fill search with name and filter + select
      input.value = item.name;
      if (p === "left") state.leftQuery = item.name;
      else state.rightQuery = item.name;

      box.classList.add("hidden");
      renderList(p);
      selectItem(item, p);
      jumpToItemInList(item, p);
    });
  });

  box.classList.remove("hidden");
}

function handleSuggestKey(e, panel) {
  const box = document.getElementById(panel === "left" ? "leftSuggest" : "rightSuggest");
  if (box.classList.contains("hidden")) {
    if (e.key === "Escape") {
      const input = document.getElementById(panel === "left" ? "leftSearch" : "rightSearch");
      input.value = "";
      if (panel === "left") state.leftQuery = "";
      else state.rightQuery = "";
      renderList(panel);
    }
    return;
  }

  const items = [...box.querySelectorAll(".suggest-item")];
  if (!items.length) return;

  let idx = items.findIndex((el) => el.classList.contains("active"));

  if (e.key === "ArrowDown") {
    e.preventDefault();
    idx = (idx + 1) % items.length;
    items.forEach((el, i) => el.classList.toggle("active", i === idx));
    items[idx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    idx = (idx - 1 + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("active", i === idx));
    items[idx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const active = items[idx >= 0 ? idx : 0];
    if (active) active.dispatchEvent(new MouseEvent("mousedown"));
  } else if (e.key === "Escape") {
    box.classList.add("hidden");
  }
}

function jumpToItemInList(item, panel) {
  const items = getFilteredAndSorted(panel);
  const idx = items.findIndex((r) => r.id === item.id);
  if (idx < 0) return;

  const container = document.getElementById(panel === "left" ? "leftList" : "rightList");
  const targetScroll = Math.max(0, idx * ROW_HEIGHT - container.clientHeight / 3);
  container.scrollTop = targetScroll;
  renderList(panel);
}


// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openPathModal(side) {
  const recent = side === "left" ? state.recentLeft : state.recentRight;
  const title = side === "left" ? "Cesta – Nové nahrávky" : "Cesta – Audioknihovna";
  document.getElementById("modalTitle").textContent = title;

  const body = document.getElementById("modalBody");
  if (recent && recent.length > 0) {
    body.innerHTML = `
      <p>Vyber dříve použitou cestu, nebo ji zadej ručně do pole nahoře<br>
      (zkopíruj z Průzkumníka / správce souborů).</p>
      <ul class="recent-list" id="recentList"></ul>
    `;
    const list = document.getElementById("recentList");
    recent.forEach((p) => {
      const li = document.createElement("li");
      li.textContent = p;
      li.addEventListener("click", () => {
        const input = document.getElementById(side === "left" ? "leftPath" : "rightPath");
        input.value = p;
        input.dispatchEvent(new Event("input"));
        closeModal();
      });
      list.appendChild(li);
    });
  } else {
    body.innerHTML = `
      <p><strong>Cestu je potřeba zadat ručně.</strong></p>
      <p>Zkopíruj ji z Průzkumníka Windows (nebo správce souborů) a vlož do pole nahoře.</p>
      <p>Pro síťové disky (SMB) použij například:</p>
      <p class="mono" style="color:var(--text);margin:8px 0">\\\\NAS\\Audioknihovna</p>
      <p>nebo namountovanou cestu typu <span class="mono">Z:\\Audioknihovna</span></p>
      <p style="margin-top:12px;font-size:12px">Aplikace si cesty pamatuje – při příštím otevření je najdeš v tomto seznamu.</p>
    `;
  }

  document.getElementById("modalOverlay").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.add("hidden");
}

document.getElementById("modalOverlay")?.addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------



function updateLibCountLabel() {
  const el = document.getElementById("libCountLabel");
  if (!el) return;
  const n = (state.libraries || []).length;
  const on = (state.libraries || []).filter((l) => l.enabled).length;
  el.textContent = n ? `(${on}/${n})` : "";
}

function renderLibraryToggles() {
  const box = document.getElementById("libToggleBtns");
  if (!box) return;
  const libs = state.libraries || [];
  box.innerHTML = libs.map((l) => {
    const cnt = state.right.filter((r) => r.library_id === l.id).length;
    const label = cnt ? `${esc(l.name)} (${cnt})` : esc(l.name);
    return `<button type="button" class="filter-btn lib-toggle${l.enabled ? " active" : ""}" data-lib="${esc(l.id)}">${label}</button>`;
  }).join("");

  box.querySelectorAll(".lib-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.lib;
      const lib = state.libraries.find((x) => x.id === id);
      if (!lib) return;
      lib.enabled = !lib.enabled;
      btn.classList.toggle("active", lib.enabled);
      updateLibCountLabel();
      renderList("right");
      persistLibraries(false);
    });
  });

  const allBtn = document.getElementById("libAll");
  const noneBtn = document.getElementById("libNone");
  if (allBtn && !allBtn._bound) {
    allBtn._bound = true;
    allBtn.addEventListener("click", () => {
      state.libraries.forEach((l) => { l.enabled = true; });
      renderLibraryToggles();
      updateLibCountLabel();
      renderList("right");
      persistLibraries(false);
    });
  }
  if (noneBtn && !noneBtn._bound) {
    noneBtn._bound = true;
    noneBtn.addEventListener("click", () => {
      state.libraries.forEach((l) => { l.enabled = false; });
      renderLibraryToggles();
      updateLibCountLabel();
      renderList("right");
      persistLibraries(false);
    });
  }

  // show stats bar when we have libraries
  const stats = document.getElementById("stats");
  if (stats && libs.length) stats.classList.remove("hidden");
  updateLibCountLabel();
}

async function persistLibraries(reload) {
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      left_path: document.getElementById("leftPath").value.trim(),
      libraries: state.libraries,
    }),
  });
  if (res.ok) {
    const data = await res.json();
    if (data.config && data.config.libraries) {
      const enabledMap = Object.fromEntries((state.libraries || []).map((l) => [l.id, l.enabled]));
      state.libraries = data.config.libraries.map((l) => ({
        ...l,
        enabled: enabledMap[l.id] !== undefined ? enabledMap[l.id] : !!l.enabled,
      }));
    }
  }
  if (reload) await loadSide("right", false);
}

function openLibraryManager() {
  const modal = document.getElementById("libModal");
  if (!modal) return;
  renderLibraryManagerList();
  modal.classList.remove("hidden");
}

function closeLibraryManager() {
  document.getElementById("libModal")?.classList.add("hidden");
}

function renderLibraryManagerList() {
  const list = document.getElementById("libList");
  if (!list) return;
  const libs = state.libraries || [];
  if (!libs.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:13px">Zatím žádná knihovna. Přidej první níže.</div>`;
    return;
  }
  list.innerHTML = libs.map((l, i) => `
    <div class="lib-row" data-idx="${i}">
      <input type="text" class="lib-name" value="${esc(l.name)}" placeholder="Název" />
      <input type="text" class="lib-path" value="${esc(l.path)}" placeholder="Cesta" spellcheck="false" />
      <button type="button" class="btn btn-small btn-remove" onclick="removeLibrary(${i})" title="Odebrat">✕</button>
    </div>
  `).join("");
}

function collectLibrariesFromManager() {
  const rows = document.querySelectorAll("#libList .lib-row");
  const out = [];
  rows.forEach((row) => {
    const name = row.querySelector(".lib-name")?.value.trim() || "";
    const path = row.querySelector(".lib-path")?.value.trim() || "";
    const idx = parseInt(row.dataset.idx, 10);
    const prev = state.libraries[idx];
    if (!path) return;
    out.push({
      id: prev?.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
      name: name || path.split(/[/\\]/).filter(Boolean).pop() || "Knihovna",
      path,
      enabled: prev ? !!prev.enabled : true,
    });
  });
  return out;
}

function addLibrary() {
  const name = document.getElementById("libNewName")?.value.trim() || "";
  const path = document.getElementById("libNewPath")?.value.trim() || "";
  if (!path) {
    alert("Zadej cestu ke složce knihovny.");
    return;
  }
  // flush current editor rows first
  state.libraries = collectLibrariesFromManager();
  state.libraries.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: name || path.split(/[/\\]/).filter(Boolean).pop() || "Knihovna",
    path,
    enabled: true,
  });
  document.getElementById("libNewName").value = "";
  document.getElementById("libNewPath").value = "";
  renderLibraryManagerList();
}

function removeLibrary(idx) {
  state.libraries = collectLibrariesFromManager();
  state.libraries.splice(idx, 1);
  renderLibraryManagerList();
}

async function saveLibrariesAndReload() {
  state.libraries = collectLibrariesFromManager();
  // also include newly typed not yet added? require add click
  await persistLibraries(false);
  renderLibraryToggles();
  closeLibraryManager();
  if (state.libraries.length) {
    await loadSide("right", false);
  } else {
    state.right = [];
    renderList("right");
  }
}


async function refreshLibrary() {
  if (!(state.libraries || []).length) {
    alert("Nejdřív přidej knihovny ve Správě knihoven.");
    openLibraryManager();
    return;
  }
  // Force rescan: clear cache for this path by calling clear is heavy;
  // use scan with cache-bust via temporary clear of that side only – backend uses cache if valid.
  // User expects refresh = re-read disk: call clear-cache is too broad.
  // We'll pass refresh=1 once backend supports it; for now clear right data and hit scan
  // after deleting cache files is complex. Simple approach: POST clear-cache then scan.
  // Better: scan endpoint already uses cache; for refresh, delete only that cache key.
  await loadSide("right", true);
}


function updateStats(stats) {
  if (!stats) return;
  const statsEl = document.getElementById("stats");
  if (statsEl) statsEl.classList.remove("hidden");
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  if (stats.found != null) set("statFound", stats.found);
  if (stats.uncertain != null) set("statUncertain", stats.uncertain);
  if (stats.not_found != null) set("statNotFound", stats.not_found);
  if (stats.left_total != null) set("leftCount", `(${stats.left_total})`);
  if (stats.right_total != null) set("rightCount", `(${stats.right_total})`);
}

async function loadSide(side, forceRefresh) {
  if (side === "left") {
    const pathEl = document.getElementById("leftPath");
    const root = (pathEl && pathEl.value || "").trim();
    if (!root) return;
  } else {
    if (!(state.libraries || []).length) return;
  }

  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  // Persist config including libraries
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      left_path: document.getElementById("leftPath").value.trim(),
      libraries: state.libraries || [],
    }),
  });

  if (forceRefresh) {
    try { await fetch("/api/clear-cache", { method: "POST" }); } catch (_) {}
    await updateCacheButton();
  }

  document.getElementById("btnCompare").disabled = true;
  const refBtn = document.getElementById("btnRefreshLib");
  if (refBtn) refBtn.disabled = true;

  setProgress(0, side === "right" ? "Načítám audioknihovnu…" : "Načítám nové nahrávky…", true);

  const url = "/api/scan?side=" + encodeURIComponent(side);

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
      }
      document.getElementById("btnCompare").disabled = false;
      if (refBtn) refBtn.disabled = false;
      resolve();
    };

    state.eventSource = new EventSource(url);

    state.eventSource.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }

      if (data.type === "progress") {
        const pct = data.total ? Math.round((data.current / data.total) * 100) : 5;
        setProgress(pct, data.message || "Skenuji…", true);
      } else if (data.type === "done") {
        if (data.right) state.right = data.right;
        if (data.left) state.left = data.left;
        if (data.libraries) {
          const enabledMap = Object.fromEntries((state.libraries || []).map((l) => [l.id, l.enabled]));
          state.libraries = data.libraries.map((l) => ({
            ...l,
            enabled: enabledMap[l.id] !== undefined ? enabledMap[l.id] : (l.enabled !== false),
          }));
        }
        if ((state.libraries || []).length && !(state.libraries || []).some((l) => l.enabled)) {
          state.libraries.forEach((l) => { l.enabled = true; });
        }
        const statsEl = document.getElementById("stats");
        if (statsEl) statsEl.classList.remove("hidden");
        updateStats(data.stats || {});
        renderLibraryToggles();
        renderList("left");
        renderList("right");
        setProgress(100, data.message || "Načteno", false);
        startJsonEnrichment();
        finish();
      } else if (data.type === "error") {
        setProgress(0, "Chyba: " + data.message, false);
        alert("Chyba: " + data.message);
        finish();
      } else if (data.type === "cancelled") {
        setProgress(0, "Zrušeno", false);
        finish();
      }
    };

    state.eventSource.onerror = () => {
      // EventSource fires error on normal close too – only finish if still open mid-stream
      if (!settled) {
        setProgress(0, "Načítání přerušeno", false);
        finish();
      }
    };
  });
}


async function startCompare() {
  const left = document.getElementById("leftPath").value.trim();
  if (!left) {
    openPathModal("left");
    return;
  }
  if (!(state.libraries || []).length) {
    alert("Nejdřív přidej alespoň jednu knihovnu ve Správě knihoven.");
    openLibraryManager();
    return;
  }
  if (!(state.libraries || []).some((l) => l.enabled)) {
    alert("Zapni alespoň jednu knihovnu v přepínačích nahoře (nebo Vše).");
    return;
  }

  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ left_path: left, libraries: state.libraries }),
  });

  clearSelectionAndDetail();

  document.getElementById("btnCompare").disabled = true;
  document.getElementById("btnCancel").classList.remove("hidden");
  document.getElementById("progressBar").classList.remove("hidden");
  document.getElementById("stats").classList.add("hidden");
  setProgress(0, "Spouštím porovnání…", true);

  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource("/api/compare");

  state.eventSource.onmessage = (ev) => {
    const data = JSON.parse(ev.data);

    if (data.type === "progress") {
      const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : -1;
      setProgress(pct, data.message || "", true);
    } else if (data.type === "result" || data.type === "done") {
      state.left = data.left || [];
      state.right = data.right || [];
      if (data.libraries) {
        const enabledMap = Object.fromEntries((state.libraries || []).map((l) => [l.id, l.enabled]));
        state.libraries = data.libraries.map((l) => ({
          ...l,
          enabled: enabledMap[l.id] !== undefined ? enabledMap[l.id] : !!l.enabled,
        }));
      }
      finishCompare(data.stats || {});
    } else if (data.type === "cancelled") {
      setProgress(0, "Zrušeno uživatelem", false);
      resetButtons();
      state.eventSource.close();
      state.eventSource = null;
    } else if (data.type === "error") {
      setProgress(0, "Chyba: " + data.message, false);
      alert("Chyba: " + data.message);
      resetButtons();
      state.eventSource.close();
      state.eventSource = null;
    }
  };

  state.eventSource.onerror = () => {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    resetButtons();
  };
}

function cancelCompare() {
  fetch("/api/cancel", { method: "POST" });
}

function finishCompare(stats) {
  setProgress(100, "Hotovo", false);
  resetButtons();
  updateCacheButton();

  document.getElementById("stats").classList.remove("hidden");
  document.getElementById("statFound").textContent = stats.found;
  document.getElementById("statUncertain").textContent = stats.uncertain;
  document.getElementById("statNotFound").textContent = stats.not_found;
  document.getElementById("leftCount").textContent = `(${stats.left_total})`;
  document.getElementById("rightCount").textContent = `(${stats.right_total})`;

  state.filters = { found: true, uncertain: true, not_found: true };
  document.querySelectorAll(".filter-btn[data-filter]").forEach((b) => b.classList.add("active"));
  renderLibraryToggles();

  renderList("left");
  renderList("right");

  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  // Progressive JSON enrichment for list rows (non-blocking)
  startJsonEnrichment();
}

function resetButtons() {
  document.getElementById("btnCompare").disabled = false;
  document.getElementById("btnCancel").classList.add("hidden");
}

function setProgress(pct, text, spinning) {
  const fill = document.getElementById("progressFill");
  const spinner = document.getElementById("progressSpinner");

  if (pct < 0) {
    fill.classList.add("indeterminate");
    fill.style.width = "30%";
  } else {
    fill.classList.remove("indeterminate");
    fill.style.width = pct + "%";
  }

  document.getElementById("progressText").textContent = text;
  spinner.classList.toggle("hidden", !spinning);
}

async function clearCache() {
  const res = await fetch("/api/clear-cache", { method: "POST" });
  const data = await res.json();
  await updateCacheButton();
  if (data.removed > 0) {
    showToast(`Keš vymazána (${data.removed} souborů)`);
  } else {
    showToast("Keš byla prázdná");
  }
}

async function updateCacheButton() {
  try {
    const res = await fetch("/api/cache-info");
    const data = await res.json();
    document.getElementById("btnClearCache").disabled = !data.exists;
  } catch {
    document.getElementById("btnClearCache").disabled = true;
  }
}

function showToast(msg) {
  const bar = document.getElementById("progressBar");
  const wasHidden = bar.classList.contains("hidden");
  bar.classList.remove("hidden");
  setProgress(0, msg, false);
  setTimeout(() => {
    if (wasHidden) bar.classList.add("hidden");
  }, 2500);
}

// ---------------------------------------------------------------------------
// Selection & Detail
// ---------------------------------------------------------------------------

function clearSelectionAndDetail() {
  state.selectedLeftId = null;
  state.selectedRightId = null;
  document.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));

  stopPlayer("left");
  stopPlayer("right");
  state.currentLeftItem = null;
  state.currentRightItem = null;
  updatePlayerButtons("left", false, true);
  updatePlayerButtons("right", false, true);
  updateBadges("left", null);
  updateBadges("right", null);

  ["Left", "Right"].forEach((side) => {
    document.getElementById(`detail${side}Placeholder`).classList.remove("hidden");
    document.getElementById(`detail${side}Content`).classList.add("hidden");
    document.getElementById(`detail${side}Content`).innerHTML = "";
    document.getElementById(`detail${side}Meta`).textContent = "";
  });
}

function selectItem(item, panel) {
  if (panel === "left") {
    state.selectedLeftId = item.id;
    document.querySelectorAll("#leftList .row.selected").forEach((r) => r.classList.remove("selected"));
    const row = document.querySelector(`#leftList .row[data-id="${item.id}"]`);
    if (row) row.classList.add("selected");
    showDetail(item, "left");

    // If matched, jump to matching item on the right
    if (item.matched_name && (item.status === "found" || item.status === "uncertain")) {
      jumpToMatchedOnRight(item.matched_name);
    }
  } else {
    state.selectedRightId = item.id;
    document.querySelectorAll("#rightList .row.selected").forEach((r) => r.classList.remove("selected"));
    const row = document.querySelector(`#rightList .row[data-id="${item.id}"]`);
    if (row) row.classList.add("selected");
    showDetail(item, "right");
  }
}

function jumpToMatchedOnRight(matchedName) {
  // Find in full right list (not filtered)
  const target = state.right.find((r) => r.name === matchedName);
  if (!target) return;

  // Make sure it's visible in current sort
  const items = getFilteredAndSorted("right");
  const idx = items.findIndex((r) => r.id === target.id);
  if (idx < 0) return;

  state.selectedRightId = target.id;
  showDetail(target, "right");

  // Scroll into view
  const container = document.getElementById("rightList");
  const targetScroll = Math.max(0, idx * ROW_HEIGHT - container.clientHeight / 3);
  container.scrollTop = targetScroll;

  // Re-render so selection class is applied
  renderList("right");
}

function shortPath(fullPath) {
  if (!fullPath) return "—";
  // Show only the last folder component (recording folder name)
  const parts = fullPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : fullPath;
}

function showDetail(item, panel) {
  const side = panel === "left" ? "Left" : "Right";
  const placeholder = document.getElementById(`detail${side}Placeholder`);
  const content = document.getElementById(`detail${side}Content`);
  const meta = document.getElementById(`detail${side}Meta`);

  placeholder.classList.add("hidden");
  content.classList.remove("hidden");

  // Load audio into mini player for this side
  loadItemIntoPlayer(panel, item);

  // Format + size in top-right (no labels)
  const formats = (item.formats && item.formats.length)
    ? item.formats.join(", ").toUpperCase()
    : "—";
  const size = item.size_human || humanSize(item.total_size) || "—";
  meta.innerHTML = `<strong>${esc(formats)}</strong> · ${esc(size)}`;

  let matchHtml = "";
  if (panel === "left" && item.status && item.status !== "unknown") {
    const label =
      item.status === "found" ? "Nalezeno" :
      item.status === "uncertain" ? "Nejisté" : "Nenalezeno";
    matchHtml = `
      <div class="detail-row">
        <span class="detail-label">Shoda:</span>
        <span>${label} (${item.match_score?.toFixed(0) || 0} %) – ${esc(item.match_reason || "")}${item.matched_name ? ` → „${esc(item.matched_name)}“` : ""}</span>
      </div>`;
  }

  const pathDisplay = shortPath(item.path);

  content.innerHTML = `
    <div class="detail-row"><span class="detail-label">Název:</span><span>${esc(item.name)}</span></div>
    <div class="detail-row"><span class="detail-label">Složka:</span><span class="mono">${esc(pathDisplay)}</span></div>
    <div class="detail-row"><span class="detail-label">Autor:</span><span>${esc(item.author || "—")}</span></div>
    <div class="detail-row"><span class="detail-label">Titul:</span><span>${esc(item.title || "—")}</span></div>
    <div class="detail-row"><span class="detail-label">Soubory:</span><span class="mono">${(item.audio_files && item.audio_files.length) ? item.audio_files.slice(0, 6).join(", ") + (item.audio_files.length > 6 ? "…" : "") : "—"}</span></div>
    ${matchHtml}
  `;
}

function esc(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Virtual list
// ---------------------------------------------------------------------------

function getFilteredAndSorted(panel) {
  let items = panel === "left" ? state.left : state.right;

  // Left panel: only folders that actually contain audio
  if (panel === "left") {
    items = items.filter((r) => r.audio_files && r.audio_files.length > 0);
  }

  // Right panel: only enabled libraries
  if (panel === "right") {
    const enabled = new Set(
      (state.libraries || []).filter((l) => l.enabled).map((l) => l.id)
    );
    if (enabled.size) {
      items = items.filter((r) => !r.library_id || enabled.has(r.library_id));
    }
  }

  if (panel === "left") {
    items = items.filter((r) => {
      if (r.status === "found") return state.filters.found;
      if (r.status === "uncertain") return state.filters.uncertain;
      if (r.status === "not_found") return state.filters.not_found;
      return true;
    });
  }

  // Text search
  const query = panel === "left" ? state.leftQuery : state.rightQuery;
  if (query) {
    items = items.filter((r) => itemMatchesQuery(r, query));
  }

  const sortKey = panel === "left" ? state.leftSort : state.rightSort;
  const dir = panel === "left" ? state.leftSortDir : state.rightSortDir;

  const sorted = [...items];
  sorted.sort((a, b) => {
    let va, vb;
    if (sortKey === "name") {
      va = a.name || "";
      vb = b.name || "";
    } else if (sortKey === "author") {
      va = a.author || "";
      vb = b.author || "";
    } else {
      va = a.title || a.name || "";
      vb = b.title || b.name || "";
    }
    return va.localeCompare(vb, "cs", { sensitivity: "base" }) * dir;
  });
  return sorted;
}

function renderList(panel) {
  const container = document.getElementById(panel === "left" ? "leftList" : "rightList");
  const items = getFilteredAndSorted(panel);

  if (panel === "left") {
    const anyFilter = state.filters.found || state.filters.uncertain || state.filters.not_found;
    if (!anyFilter) {
      container.innerHTML = `<div class="empty-state">Všechny filtry jsou vypnuté.<br>Zapni alespoň jednu kategorii (Nalezeno / Nejisté / Nenalezeno), aby se položky zobrazily.</div>`;
      return;
    }
  }

  if (items.length === 0) {
    const q = panel === "left" ? state.leftQuery : state.rightQuery;
    let msg;
    if (q) {
      msg = `Žádné výsledky pro „${esc(q)}“.`;
    } else if (panel === "left") {
      msg = "Žádné položky neodpovídají aktivním filtrům (nebo ještě neproběhlo porovnání).";
    } else {
      msg = "Žádná data. Nastav cesty a stiskni Porovnat.";
    }
    container.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  let inner = container.querySelector(".list-inner");
  if (!inner) {
    container.innerHTML = "";
    inner = document.createElement("div");
    inner.className = "list-inner";
    container.appendChild(inner);
    container.addEventListener("scroll", () => onScroll(panel));
  }

  inner.style.height = items.length * ROW_HEIGHT + "px";
  container._items = items;
  container._panel = panel;

  onScroll(panel);
}

function onScroll(panel) {
  const container = document.getElementById(panel === "left" ? "leftList" : "rightList");
  const items = container._items;
  if (!items) return;
  onListScrollEnrich(panel);

  const inner = container.querySelector(".list-inner");
  if (!inner) return;

  const scrollTop = container.scrollTop;
  const viewHeight = container.clientHeight;

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + 4);

  const existing = new Map();
  inner.querySelectorAll(".row").forEach((row) => {
    existing.set(row.dataset.idx, row);
  });

  const fragment = document.createDocumentFragment();
  const used = new Set();
  const selectedId = panel === "left" ? state.selectedLeftId : state.selectedRightId;

  for (let i = start; i < end; i++) {
    const item = items[i];
    let row = existing.get(String(i));
    if (row) {
      used.add(String(i));
      updateRow(row, item, panel, selectedId);
      row.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
    } else {
      row = createRow(item, panel, i, selectedId);
      fragment.appendChild(row);
    }
  }

  existing.forEach((row, idx) => {
    if (!used.has(idx)) row.remove();
  });

  if (fragment.childNodes.length) {
    inner.appendChild(fragment);
  }
}

function createRow(item, panel, idx, selectedId) {
  const row = document.createElement("div");
  row.className = "row" + (item.id === selectedId ? " selected" : "");
  row.dataset.idx = idx;
  row.dataset.id = item.id;
  row.dataset.panel = panel;
  row.style.transform = `translateY(${idx * ROW_HEIGHT}px)`;

  if (panel === "left") {
    const dot = document.createElement("div");
    dot.className = `status-dot ${item.status || "unknown"}`;
    row.appendChild(dot);
  }

  const text = document.createElement("div");
  text.className = "row-text";

  const name = document.createElement("div");
  name.className = "row-name";
  name.textContent = rowDisplayTitle(item);
  text.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.innerHTML = buildRowMetaHtml(item);
  text.appendChild(meta);

  row.appendChild(text);
  if (item.from_json) {
    row.classList.add("from-json");
    row.classList.add("json-flash");
  }

  // IMPORTANT: do not close over `item` – rows are recycled by the virtual list.
  // Always resolve the current item by id at click time.
  row.addEventListener("click", onRowClick);

  return row;
}

function onRowClick(ev) {
  const row = ev.currentTarget;
  const id = row.dataset.id;
  const panel = row.dataset.panel;
  if (!id || !panel) return;

  // Prefer full source lists so filters/sort never give a stale object
  const source = panel === "left" ? state.left : state.right;
  const item = source.find((r) => r.id === id);
  if (!item) return;

  selectItem(item, panel);
}

function updateRow(row, item, panel, selectedId) {
  row.dataset.id = item.id;
  row.dataset.panel = panel;
  row.classList.toggle("selected", item.id === selectedId);

  const nameEl = row.querySelector(".row-name");
  if (nameEl) nameEl.textContent = rowDisplayTitle(item);

  const metaEl = row.querySelector(".row-meta");
  if (metaEl) metaEl.innerHTML = buildRowMetaHtml(item);

  const wasJson = row.classList.contains("from-json");
  row.classList.toggle("from-json", !!item.from_json);
  if (item.from_json && !wasJson) {
    row.classList.remove("json-flash");
    // force reflow for restart animation
    void row.offsetWidth;
    row.classList.add("json-flash");
  }

  if (panel === "left") {
    const dot = row.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${item.status || "unknown"}`;
  }
}


// ---------------------------------------------------------------------------
// Badge previews (ID3 / M4A / JSON / Cover) – click only
// ---------------------------------------------------------------------------

function setupBadgePreviews() {
  document.querySelectorAll(".badge").forEach((badge) => {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!badge.classList.contains("on")) return;
      const kind = badge.dataset.kind;
      const side = badge.closest("#playerLeft") ? "left" : "right";
      openSidecarPreview(side, kind);
    });
  });

  document.getElementById("previewClose")?.addEventListener("click", closePreview);
  document.getElementById("previewOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "previewOverlay") closePreview();
  });
  document.getElementById("previewFmtBtn")?.addEventListener("click", () => {
    if (state._rawJson == null) return;
    state._jsonPretty = !state._jsonPretty;
    renderJsonPreview(state._rawJson, state._jsonPretty, state._jsonFilename || "");
    const btn = document.getElementById("previewFmtBtn");
    if (btn) btn.classList.toggle("active", state._jsonPretty);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePreview();
  });
}

const JSON_PRIORITY_KEYS = [
  "title", "name", "nazev", "název",
  "subtitle", "podtitul", "podnazev", "podnázev",
  "author", "authors", "autor", "autori", "autoři", "artist", "artists",
  "narrator", "narrators", "interpret", "interpreti", "reader", "readers", "voice",
  "description", "desc", "popis", "summary", "anotace", "annotation",
];

function prioritizeJsonEntries(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return [["", obj]];
  }
  const lowerMap = {};
  Object.keys(obj).forEach((k) => { lowerMap[k.toLowerCase()] = k; });
  const used = new Set();
  const entries = [];

  for (const pk of JSON_PRIORITY_KEYS) {
    const real = lowerMap[pk];
    if (real != null && !used.has(real)) {
      entries.push([real, obj[real]]);
      used.add(real);
    }
  }
  const chapterKeys = Object.keys(obj).filter((k) =>
    /chapter|kapitol|track|parts?/i.test(k) && !used.has(k)
  );
  for (const k of Object.keys(obj)) {
    if (!used.has(k) && !chapterKeys.includes(k)) {
      entries.push([k, obj[k]]);
      used.add(k);
    }
  }
  for (const k of chapterKeys) entries.push([k, obj[k]]);
  return entries;
}

function formatJsonValue(v) {
  if (v == null) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string" || typeof x === "number")) {
      return v.join(", ");
    }
    return JSON.stringify(v, null, 2);
  }
  return JSON.stringify(v, null, 2);
}

function renderJsonPreview(rawText, pretty, filename) {
  const body = document.getElementById("previewBody");
  const fname = filename
    ? `<div style="color:var(--text-dim);font-size:11px;margin-bottom:8px">${esc(filename)}</div>`
    : "";

  if (!pretty) {
    body.innerHTML = fname + `<pre>${esc(rawText)}</pre>`;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    body.innerHTML = fname + `<pre>${esc(rawText)}</pre>`;
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    body.innerHTML = fname + `<pre>${esc(String(parsed))}</pre>`;
    return;
  }

  if (Array.isArray(parsed)) {
    body.innerHTML = fname + `<pre>${esc(JSON.stringify(parsed, null, 2))}</pre>`;
    return;
  }

  const entries = prioritizeJsonEntries(parsed);
  const prioritySet = new Set(JSON_PRIORITY_KEYS);
  let priorityRows = "";
  let restRows = "";

  for (const [k, v] of entries) {
    const row = `<div class="tag-key">${esc(k)}</div><div class="tag-val">${esc(formatJsonValue(v))}</div>`;
    if (prioritySet.has(k.toLowerCase())) priorityRows += row;
    else restRows += row;
  }

  let html = fname;
  if (priorityRows) {
    html += `<div class="preview-priority"><div class="preview-tags">${priorityRows}</div></div>`;
  }
  if (restRows) {
    html += `<div class="preview-tags">${restRows}</div>`;
  }
  body.innerHTML = html;
}

async function openSidecarPreview(side, kind) {
  const item = side === "left" ? state.currentLeftItem : state.currentRightItem;
  if (!item || !item.path) return;

  const overlay = document.getElementById("previewOverlay");
  const title = document.getElementById("previewTitle");
  const body = document.getElementById("previewBody");
  const fmtBtn = document.getElementById("previewFmtBtn");

  const labels = { id3: "ID3 tagy", m4a: "M4A metadata", json: "JSON metadata", cover: "Cover" };
  title.textContent = labels[kind] || kind;
  body.innerHTML = `<div class="preview-empty">Načítám…</div>`;
  state._rawJson = null;
  if (fmtBtn) fmtBtn.classList.add("hidden");
  overlay.classList.remove("hidden");

  try {
    if (kind === "cover") {
      const url = "/api/sidecar?folder=" + encodeURIComponent(item.path) + "&kind=cover";
      body.innerHTML = `<img src="${url}" alt="Cover" />`;
      return;
    }

    const res = await fetch(
      "/api/sidecar?folder=" + encodeURIComponent(item.path) + "&kind=" + encodeURIComponent(kind)
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      body.innerHTML = `<div class="preview-empty">${esc(err.detail || "Nelze načíst")}</div>`;
      return;
    }
    const data = await res.json();

    if (kind === "json") {
      state._rawJson = data.content || "";
      state._jsonFilename = data.filename || "";
      state._jsonPretty = true;
      if (fmtBtn) {
        fmtBtn.classList.remove("hidden");
        fmtBtn.classList.add("active");
      }
      renderJsonPreview(state._rawJson, true, state._jsonFilename);
    } else if (kind === "id3" || kind === "m4a") {
      const tags = data.tags || {};
      const keys = Object.keys(tags);
      if (!keys.length) {
        body.innerHTML = `<div class="preview-empty">Metadata se nepodařilo přečíst (nebo jsou prázdná).<br><span style="font-size:11px">${esc(data.filename || "")}</span></div>`;
      } else {
        body.innerHTML =
          `<div style="color:var(--text-dim);font-size:11px;margin-bottom:8px">${esc(data.filename || "")}</div>` +
          `<div class="preview-tags">` +
          keys.map((k) => `<div class="tag-key">${esc(k)}</div><div class="tag-val">${esc(tags[k])}</div>`).join("") +
          `</div>`;
      }
    }
  } catch (e) {
    body.innerHTML = `<div class="preview-empty">Chyba: ${esc(String(e))}</div>`;
  }
}

function closePreview() {
  document.getElementById("previewOverlay")?.classList.add("hidden");
  state._rawJson = null;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Progressive JSON enrichment – viewport-first, small batches
// ---------------------------------------------------------------------------

state._enrichQueue = [];
state._enrichQueued = new Set(); // paths
state._enrichTimer = null;

function startJsonEnrichment() {
  // Seed queue with all candidates; visible ones will be boosted on scroll
  state.enrichAbort = false;
  state._enrichQueued = new Set();
  state._enrichQueue = [];

  const candidates = [...state.right, ...state.left].filter(
    (r) => r.has_json && !r.from_json && !r._enrichTried && r.path
  );
  // right panel first
  const rightPaths = new Set(state.right.map((r) => r.path));
  candidates.sort((a, b) => (rightPaths.has(b.path) ? 1 : 0) - (rightPaths.has(a.path) ? 1 : 0));

  for (const r of candidates) {
    state._enrichQueued.add(r.path);
    state._enrichQueue.push(r.path);
  }

  prioritizeVisibleEnrichment();
  pumpEnrichment();
}

function prioritizeVisibleEnrichment() {
  const visible = new Set([
    ...getVisiblePaths("right"),
    ...getVisiblePaths("left"),
  ]);
  if (!visible.size || !state._enrichQueue.length) return;

  const rest = [];
  const front = [];
  for (const p of state._enrichQueue) {
    if (visible.has(p)) front.push(p);
    else rest.push(p);
  }
  state._enrichQueue = front.concat(rest);
}

function getVisiblePaths(panel) {
  const set = new Set();
  const container = document.getElementById(panel === "left" ? "leftList" : "rightList");
  if (!container || !container._items) return set;
  const items = container._items;
  const scrollTop = container.scrollTop;
  const viewHeight = container.clientHeight || 400;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + 8);
  for (let i = start; i < end; i++) {
    if (items[i] && items[i].path) set.add(items[i].path);
  }
  return set;
}

async function pumpEnrichment() {
  if (state.enrichRunning) return;
  state.enrichRunning = true;

  const status = document.getElementById("enrichStatus");
  const BATCH = 15;

  while (state._enrichQueue.length && !state.enrichAbort) {
    prioritizeVisibleEnrichment();
    const batchPaths = state._enrichQueue.splice(0, BATCH);
    for (const p of batchPaths) state._enrichQueued.delete(p);

    if (status) {
      status.style.display = "";
      status.textContent = "Doplňuji JSON… zbývá " + state._enrichQueue.length;
    }

    try {
      const res = await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: batchPaths }),
      });
      if (res.ok) {
        const data = await res.json();
        applyEnrichResults(data.items || []);
      } else {
        console.warn("enrich HTTP", res.status);
        // mark attempted so we do not spin forever
        markEnrichAttempted(batchPaths);
      }
    } catch (e) {
      console.warn("enrich batch failed", e);
      markEnrichAttempted(batchPaths);
      // short pause then continue with rest
      await new Promise((r) => setTimeout(r, 100));
    }

    await new Promise((r) => setTimeout(r, 5));
  }

  state.enrichRunning = false;
  if (status) {
    if (!state._enrichQueue.length) {
      const n = countEnriched();
      status.textContent = n ? ("JSON doplněn u " + n + " položek") : "JSON: nic k doplnění";
      setTimeout(() => {
        if (!state.enrichRunning && status) status.style.display = "none";
      }, 2500);
    }
  }
}

function markEnrichAttempted(paths) {
  const set = new Set(paths);
  for (const rec of [...state.right, ...state.left]) {
    if (set.has(rec.path)) rec._enrichTried = true;
  }
}

function countEnriched() {
  return [...state.right, ...state.left].filter((r) => r.from_json).length;
}

function applyEnrichResults(items) {
  const byPath = new Map();
  state.right.forEach((r) => byPath.set(r.path, r));
  state.left.forEach((r) => byPath.set(r.path, r));

  let changedRight = false;
  let changedLeft = false;
  const rightPaths = new Set(state.right.map((r) => r.path));

  for (const it of items) {
    const rec = byPath.get(it.path);
    if (!rec) continue;
    rec._enrichTried = true;
    if (!it.ok) continue;
    if (it.author) rec.author = it.author;
    if (it.title) rec.title = it.title;
    if (it.narrator) rec.interpreter = it.narrator;
    if (it.year) rec.year = it.year;
    if (it.genre) rec.genre = it.genre;
    if (it.tags) rec.tags = it.tags;
    if (it.subtitle) rec.subtitle = it.subtitle;
    if (it.from_json || it.author || it.title) {
      rec.from_json = true;
    }
    if (rightPaths.has(rec.path)) changedRight = true;
    else changedLeft = true;
  }

  if (changedRight) renderList("right");
  if (changedLeft) renderList("left");
}

// On scroll: boost visible items to front of queue and keep pumping
function onListScrollEnrich(panel) {
  prioritizeVisibleEnrichment();
  if (!state.enrichRunning && state._enrichQueue && state._enrichQueue.length) {
    pumpEnrichment();
  }
}


function rowDisplayTitle(item) {
  if (item.from_json && item.title) return item.title;
  return item.name || "—";
}

function buildRowMetaHtml(item) {
  const chips = [];
  const add = (cls, label, val) => {
    if (!val) return;
    chips.push(
      (chips.length ? `<span class="meta-sep"></span>` : "") +
      `<span class="meta-chip ${cls}">` +
      (label ? `<span class="meta-label">${label}</span>` : "") +
      `<span class="meta-val">${esc(val)}</span></span>`
    );
  };

  add("author", "", item.author || "");
  add("year", "", item.year || "");
  add("genre", "žánr", item.genre || "");
  add("tags", "tag", item.tags || "");
  add("narrator", "účinkují", item.interpreter || "");

  const left = chips.length
    ? chips.join("")
    : `<span class="meta-chip"><span class="meta-val">—</span></span>`;

  const lib = item.library_name
    ? `<span class="meta-lib" title="Knihovna">${esc(item.library_name)}</span>`
    : "";

  return `<span class="meta-left">${left}</span>${lib}`;
}



function humanSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(1) + " " + units[i];
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
