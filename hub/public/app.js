// GameSync dashboard — vanilla ES module, no build step.

const TOKEN_KEY = "gamesync.token";
const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = { games: [], devices: [], conflicts: [], vault: [], tab: "library" };

// ---- API helpers ---------------------------------------------------------
async function api(method, path, body, isForm = false) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !isForm) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.error || JSON.stringify(j);
    } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res;
}

function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---- Data loading --------------------------------------------------------
async function loadAll() {
  try {
    const [games, devices, conflicts] = await Promise.all([
      api("GET", "/api/games"),
      api("GET", "/api/devices"),
      api("GET", "/api/conflicts"),
    ]);
    state.games = games;
    state.devices = devices;
    state.conflicts = conflicts;
    renderAll();
  } catch (e) {
    toast("Load failed: " + e.message, true);
  }
}

// ---- Rendering -----------------------------------------------------------
function renderAll() {
  renderLibrary();
  renderDevices();
  renderConflicts();
  const badge = $("#conflict-badge");
  if (state.conflicts.length) {
    badge.textContent = state.conflicts.length;
    badge.classList.remove("hidden");
  } else badge.classList.add("hidden");
}

function renderLibrary() {
  const grid = $("#game-grid");
  grid.innerHTML = "";
  $("#library-empty").classList.toggle("hidden", state.games.length > 0);
  for (const g of state.games) {
    const card = document.createElement("div");
    card.className = "game-card";
    const pathCount = g.paths?.length ?? 0;
    const cover = g.coverUrl
      ? `<div class="cover" style="background-image:url('${g.coverUrl}')"></div>`
      : `<div class="cover">${escapeHtml(g.name)}</div>`;
    card.innerHTML = `
      ${cover}
      <div class="meta">
        <div class="title">${escapeHtml(g.name)}</div>
        <div class="sub">
          <span class="pill">${pathCount} device${pathCount === 1 ? "" : "s"}</span>
          <span class="pill">v${g.currentVersion}</span>
          ${g.autoSync === false ? `<span class="pill" style="background:#7a5b00;color:#ffd97a">paused</span>` : ""}
        </div>
      </div>`;
    card.onclick = () => openGameDetail(g.id);
    grid.appendChild(card);
  }
}

function renderDevices() {
  const list = $("#device-list");
  list.innerHTML = "";
  $("#devices-empty").classList.toggle("hidden", state.devices.length > 0);
  for (const d of state.devices) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <span class="dot ${d.online ? "online" : ""}"></span>
      <div class="grow">
        <div class="name">${escapeHtml(d.name)}</div>
        <div class="sub">id: ${escapeHtml(d.id)} · ${d.online ? "online" : "last seen " + fmtDate(d.lastSeen)}</div>
      </div>
      <button class="danger" data-del="${escapeAttr(d.id)}">Remove</button>`;
    row.querySelector("[data-del]").onclick = async () => {
      if (!confirm(`Remove device "${d.name}"?`)) return;
      await api("DELETE", `/api/devices/${encodeURIComponent(d.id)}`);
      loadAll();
    };
    list.appendChild(row);
  }
}

function renderConflicts() {
  const list = $("#conflict-list");
  list.innerHTML = "";
  $("#conflicts-empty").classList.toggle("hidden", state.conflicts.length > 0);
  for (const c of state.conflicts) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="grow">
        <div class="name">${escapeHtml(c.game?.name ?? "Game " + c.gameId)}</div>
        <div class="sub">from <b>${escapeHtml(c.deviceId)}</b> · based on v${c.baseVersion}, server was v${c.serverVersion} · ${fmtDate(c.createdAt)}</div>
      </div>
      <a href="/api/conflicts/${c.id}/download" target="_blank"><button>Download</button></a>
      <button data-keep="client">Keep theirs</button>
      <button data-keep="server" class="primary">Keep server</button>`;
    row.querySelector('[data-keep="client"]').onclick = () => resolveConflict(c.id, "client");
    row.querySelector('[data-keep="server"]').onclick = () => resolveConflict(c.id, "server");
    list.appendChild(row);
  }
}

async function resolveConflict(id, keep) {
  try {
    await api("POST", `/api/conflicts/${id}/resolve`, { keep });
    toast(keep === "client" ? "Promoted conflicting save to latest" : "Kept server version");
    loadAll();
  } catch (e) {
    toast("Resolve failed: " + e.message, true);
  }
}

// ---- Modal plumbing ------------------------------------------------------
function openModal(html) {
  $("#modal").innerHTML = html;
  $("#modal-root").classList.remove("hidden");
}
function closeModal() {
  $("#modal-root").classList.add("hidden");
  $("#modal").innerHTML = "";
}
$(".modal-backdrop")?.addEventListener("click", closeModal);

// ---- Add game ------------------------------------------------------------
function openAddGame() {
  let chosen = { steamGridId: null, coverUrl: null, name: "" };
  openModal(`
    <h3>Add game</h3>
    <div class="field">
      <label>Search SteamGridDB</label>
      <input id="ag-search" placeholder="e.g. The Witcher 3" autofocus />
    </div>
    <div id="ag-results" class="search-results"></div>
    <div id="ag-covers"></div>
    <div class="field" style="margin-top:14px">
      <label>Game name (saved to library)</label>
      <input id="ag-name" placeholder="Name" />
    </div>
    <div class="field">
      <label>Process name (optional) — client waits for this exe to exit before syncing</label>
      <input id="ag-proc" placeholder="witcher3.exe" />
    </div>
    <div class="modal-actions">
      <button id="ag-cancel">Cancel</button>
      <button id="ag-create" class="primary">Add game</button>
    </div>
  `);

  const searchEl = $("#ag-search");
  const nameEl = $("#ag-name");
  let timer;
  searchEl.oninput = () => {
    clearTimeout(timer);
    const q = searchEl.value.trim();
    nameEl.value = q;
    chosen.name = q;
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      try {
        const results = await api("GET", `/api/sgdb/search?q=${encodeURIComponent(q)}`);
        const box = $("#ag-results");
        box.innerHTML = "";
        for (const r of results.slice(0, 8)) {
          const el = document.createElement("div");
          el.className = "search-result";
          el.textContent = r.name + (r.release_date ? ` (${new Date(r.release_date * 1000).getFullYear()})` : "");
          el.onclick = () => pickGame(r, el);
          box.appendChild(el);
        }
      } catch (e) {
        toast("Search failed: " + e.message + " (set a SteamGridDB key in ⚙)", true);
      }
    }, 350);
  };

  async function pickGame(r, el) {
    $$(".search-result").forEach((x) => x.classList.remove("selected"));
    el.classList.add("selected");
    chosen.name = r.name;
    nameEl.value = r.name;
    const coversBox = $("#ag-covers");
    coversBox.innerHTML = `<div class="field"><label>Pick a cover</label><div class="cover-choices" id="ag-cover-grid"><span class="muted">Loading…</span></div></div>`;
    try {
      const covers = await api("GET", `/api/sgdb/covers/${r.id}`);
      const grid = $("#ag-cover-grid");
      grid.innerHTML = "";
      for (const c of covers.slice(0, 12)) {
        const cell = document.createElement("div");
        cell.className = "cover-choice";
        cell.style.backgroundImage = `url('${c.thumb}')`;
        cell.onclick = () => {
          $$(".cover-choice").forEach((x) => x.classList.remove("selected"));
          cell.classList.add("selected");
          chosen.steamGridId = r.id;
          chosen.coverUrl = c.url;
        };
        grid.appendChild(cell);
      }
      if (covers.length) {
        grid.firstChild.click();
      } else {
        grid.innerHTML = `<span class="muted">No covers found.</span>`;
      }
    } catch (e) {
      $("#ag-cover-grid").innerHTML = `<span class="muted">Cover lookup failed.</span>`;
    }
  }

  $("#ag-cancel").onclick = closeModal;
  $("#ag-create").onclick = async () => {
    const name = nameEl.value.trim();
    if (!name) return toast("Enter a name", true);
    try {
      await api("POST", "/api/games", {
        name,
        coverUrl: chosen.coverUrl || undefined,
        steamGridId: chosen.steamGridId || undefined,
        processName: $("#ag-proc").value.trim() || undefined,
      });
      closeModal();
      toast("Game added");
      loadAll();
    } catch (e) {
      toast("Add failed: " + e.message, true);
    }
  };
}

// ---- Remote folder browser (asks the device's client over WebSocket) -----
function openFolderBrowser(deviceId, startPath, onPick) {
  let current = startPath || "";
  openModal(`
    <h3>Browse folders on ${escapeHtml(deviceId)}</h3>
    <div id="fb-path" class="fb-path"><span class="muted">loading…</span></div>
    <div id="fb-roots" class="fb-roots"></div>
    <div id="fb-list" class="fb-list"></div>
    <div class="modal-actions">
      <button id="fb-up">↑ Up</button>
      <span style="flex:1"></span>
      <button id="fb-cancel">Cancel</button>
      <button id="fb-use" class="primary">Use this folder</button>
    </div>
  `);

  async function nav(path) {
    $("#fb-list").innerHTML = `<div class="fb-item muted">loading…</div>`;
    let res;
    try {
      res = await api("POST", `/api/devices/${encodeURIComponent(deviceId)}/browse`, { path });
    } catch (e) {
      $("#fb-path").textContent = "couldn't reach device";
      $("#fb-list").innerHTML = `<div class="fb-item muted">${escapeHtml(e.message)}</div>`;
      return;
    }
    if (res.error) {
      $("#fb-path").textContent = "couldn't reach device";
      $("#fb-list").innerHTML = `<div class="fb-item muted">${escapeHtml(res.error)}</div>`;
      return;
    }
    current = res.path || "";
    $("#fb-path").textContent = current || "Pick a starting location";
    $("#fb-use").disabled = !current;
    $("#fb-up").disabled = !res.parent;
    $("#fb-up").onclick = () => res.parent && nav(res.parent);

    const roots = $("#fb-roots");
    roots.innerHTML = "";
    for (const r of res.roots || []) {
      const chip = document.createElement("div");
      chip.className = "fb-root";
      chip.textContent = r.name;
      chip.onclick = () => nav(r.path);
      roots.appendChild(chip);
    }

    const list = $("#fb-list");
    list.innerHTML = "";
    const entries = res.entries || [];
    if (!entries.length && current) {
      list.innerHTML = `<div class="fb-item muted">(no sub-folders here — you can still use this folder)</div>`;
    }
    for (const e of entries) {
      const item = document.createElement("div");
      item.className = "fb-item" + (e.isDir ? "" : " file");
      item.innerHTML = `<span class="ico">${e.isDir ? "📁" : "📄"}</span><span>${escapeHtml(e.name)}</span>`;
      if (e.isDir) item.onclick = () => nav(e.path);
      list.appendChild(item);
    }
  }

  $("#fb-cancel").onclick = closeModal;
  $("#fb-use").onclick = () => { onPick(current); closeModal(); };
  nav(current);
}

// ---- Game detail / path mapping -----------------------------------------
async function openGameDetail(id) {
  let game;
  try {
    game = await api("GET", `/api/games/${id}`);
  } catch (e) {
    return toast("Load failed: " + e.message, true);
  }
  const devices = state.devices;
  const pathFor = (deviceId) => game.paths.find((p) => p.deviceId === deviceId);

  const rows = devices
    .map((d) => {
      const p = pathFor(d.id);
      return `<tr>
        <td><span class="dot ${d.online ? "online" : ""}"></span> ${escapeHtml(d.name)}</td>
        <td><input data-path="${escapeAttr(d.id)}" placeholder="C:\\Users\\You\\AppData\\..." value="${p ? escapeAttr(p.localPath) : ""}" /></td>
        <td class="muted">${p ? "v" + p.syncedVersion : "—"}</td>
        <td style="white-space:nowrap">
          <button data-browse="${escapeAttr(d.id)}" ${d.online ? "" : "disabled title='device offline'"}>Browse</button>
          <button data-savepath="${escapeAttr(d.id)}">Save</button>
        </td>
      </tr>`;
    })
    .join("");

  const versions = (game.versions || [])
    .map((v) => `<tr><td>v${v.version}</td><td class="muted">${v.deviceId}</td><td class="muted">${(v.size/1024/1024).toFixed(2)} MB</td><td class="muted">${fmtDate(v.createdAt)}</td><td><a href="/api/sync/download/${game.id}?version=${v.version}" target="_blank"><button>Get</button></a></td></tr>`)
    .join("");

  openModal(`
    <h3>${escapeHtml(game.name)}</h3>
    <div style="display:flex;gap:18px">
      <div class="cover" style="width:120px;flex:0 0 120px;border-radius:8px;${game.coverUrl ? `background-image:url('${game.coverUrl}')` : ""}">${game.coverUrl ? "" : escapeHtml(game.name)}</div>
      <div style="flex:1">
        <div class="muted">Current version: v${game.currentVersion}</div>
        <label class="toggle" style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer">
          <input type="checkbox" id="gd-autosync" ${game.autoSync ? "checked" : ""} />
          <span><b>Auto-sync this game</b> — devices sync automatically. Turn off to keep it mapped but paused.</span>
        </label>
        <label class="toggle" style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer">
          <input type="checkbox" id="gd-overwrite" ${game.overwriteStale ? "checked" : ""} />
          <span><b>Auto-resolve: newest save wins</b> — when two devices differ, keep whichever was saved most recently and overwrite the other (no conflict prompt). Ties fall back to a conflict. Needs device clocks roughly in sync.</span>
        </label>
        <div class="field" style="margin-top:10px">
          <label>Process name (client waits for exit)</label>
          <div style="display:flex;gap:8px">
            <input id="gd-proc" placeholder="witcher3.exe" value="${escapeAttr(game.processName || "")}" />
            <button id="gd-proc-save">Save</button>
          </div>
        </div>
        <h4 style="margin:14px 0 4px">Save paths per device</h4>
        ${devices.length ? `<table class="path-table"><thead><tr><th>Device</th><th>Local path</th><th>Synced</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="muted">No devices yet — add one in the Devices tab.</p>`}
      </div>
    </div>
    ${versions ? `<details class="vault-details"><summary>Version history (${game.versions.length})${game.versions.length >= 20 ? "+ — full list in the Vault tab" : ""}</summary><div class="vault-scroll"><table class="path-table"><tbody>${versions}</tbody></table></div></details>` : ""}
    <div class="modal-actions">
      <button class="danger" id="gd-delete">Delete game</button>
      <span class="spacer" style="flex:1"></span>
      <button id="gd-close">Close</button>
    </div>
  `);

  async function savePath(deviceId, localPath) {
    try {
      if (localPath) {
        await api("PUT", `/api/games/${game.id}/paths`, { deviceId, localPath });
        toast("Path saved");
      } else {
        await api("DELETE", `/api/games/${game.id}/paths/${encodeURIComponent(deviceId)}`);
        toast("Path removed");
      }
      loadAll();
    } catch (e) {
      toast("Save failed: " + e.message, true);
    }
  }

  $$("[data-savepath]").forEach((btn) => {
    btn.onclick = () => {
      const deviceId = btn.getAttribute("data-savepath");
      const input = $(`input[data-path="${cssEscape(deviceId)}"]`);
      savePath(deviceId, input.value.trim());
    };
  });

  $$("[data-browse]").forEach((btn) => {
    btn.onclick = () => {
      const deviceId = btn.getAttribute("data-browse");
      const input = $(`input[data-path="${cssEscape(deviceId)}"]`);
      openFolderBrowser(deviceId, input.value.trim(), (picked) => {
        input.value = picked;
        savePath(deviceId, picked); // pick = save immediately
      });
    };
  });

  $("#gd-autosync").onchange = async (e) => {
    const on = e.target.checked;
    try {
      await api("PATCH", `/api/games/${game.id}`, { autoSync: on });
      toast(on ? "Auto-sync enabled" : "Auto-sync paused");
      loadAll();
    } catch (err) {
      e.target.checked = !on; // revert on failure
      toast("Save failed: " + err.message, true);
    }
  };

  $("#gd-overwrite").onchange = async (e) => {
    const on = e.target.checked;
    try {
      await api("PATCH", `/api/games/${game.id}`, { overwriteStale: on });
      toast(on ? "Newest-save-wins enabled" : "Newest-save-wins disabled");
      loadAll();
    } catch (err) {
      e.target.checked = !on;
      toast("Save failed: " + err.message, true);
    }
  };

  $("#gd-proc-save").onclick = async () => {
    try {
      await api("PATCH", `/api/games/${game.id}`, { processName: $("#gd-proc").value.trim() });
      toast("Process name saved");
      loadAll();
    } catch (e) {
      toast("Save failed: " + e.message, true);
    }
  };

  $("#gd-close").onclick = closeModal;
  $("#gd-delete").onclick = async () => {
    if (!confirm(`Delete "${game.name}" and all its saved versions?`)) return;
    await api("DELETE", `/api/games/${game.id}`);
    closeModal();
    loadAll();
  };
}

// ---- Add device (manual) -------------------------------------------------
function openAddDevice() {
  openModal(`
    <h3>Add device</h3>
    <div class="field"><label>Device id (hostname / hardware id)</label><input id="dv-id" placeholder="Main-PC" /></div>
    <div class="field"><label>Friendly name</label><input id="dv-name" placeholder="Main PC" /></div>
    <p class="muted">Tip: the Windows client registers itself automatically. Add manually only for testing.</p>
    <div class="modal-actions"><button id="dv-cancel">Cancel</button><button id="dv-save" class="primary">Add</button></div>
  `);
  $("#dv-cancel").onclick = closeModal;
  $("#dv-save").onclick = async () => {
    const id = $("#dv-id").value.trim();
    if (!id) return toast("Enter an id", true);
    await api("POST", "/api/devices/register", { id, name: $("#dv-name").value.trim() || id });
    closeModal();
    loadAll();
  };
}

// ---- Settings ------------------------------------------------------------
function openSettings() {
  openModal(`
    <h3>Settings</h3>
    <div class="field">
      <label>API token (only if the hub has API_TOKEN set)</label>
      <input id="st-token" type="password" value="${escapeAttr(getToken())}" placeholder="leave blank if hub is open" />
    </div>
    <div class="field">
      <label>SteamGridDB</label>
      <div id="st-sgdb" class="muted">checking…</div>
    </div>
    <p class="muted">The SteamGridDB key is set <b>on the hub</b> via the <code>STEAMGRIDDB_API_KEY</code>
    environment variable (not here). After changing it, restart the hub container.</p>
    <div class="modal-actions"><button id="st-cancel">Cancel</button><button id="st-save" class="primary">Save</button></div>
  `);
  api("GET", "/api/sgdb/status")
    .then((s) => {
      const el = $("#st-sgdb");
      if (s.ok) el.innerHTML = `<span style="color:var(--ok)">✅ connected</span>`;
      else if (!s.configured) el.innerHTML = `<span style="color:var(--danger)">❌ no key set on the hub (STEAMGRIDDB_API_KEY)</span>`;
      else el.innerHTML = `<span style="color:var(--warn)">⚠ key set but rejected: ${escapeHtml(s.error || "")}</span>`;
    })
    .catch((e) => { $("#st-sgdb").textContent = "status check failed: " + e.message; });
  $("#st-cancel").onclick = closeModal;
  $("#st-save").onclick = () => {
    setToken($("#st-token").value.trim());
    closeModal();
    toast("Saved");
    loadAll();
  };
}

// ---- Live updates via WebSocket -----------------------------------------
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const id = "dashboard-" + Math.floor(performance.now());
  const url = `${proto}://${location.host}/ws?deviceId=${id}&token=${encodeURIComponent(getToken())}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    return;
  }
  ws.onopen = () => $("#status-dot").classList.add("up");
  ws.onclose = () => {
    $("#status-dot").classList.remove("up");
    $("#status-dot").classList.add("down");
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch {}
    if (msg && msg.type === "sync_event") {
      playSyncAnimation(msg.gameName, msg.version, msg.deviceId);
    }
    loadAll(); // any event => refresh
  };
}

// A little "save flew to the cloud" toast, played when a sync completes.
function playSyncAnimation(gameName, version, deviceId) {
  const el = document.createElement("div");
  el.className = "sync-anim";
  el.innerHTML = `
    <div class="sync-stage">
      <span class="sync-dev">💾</span>
      <span class="sync-trail"></span>
      <span class="sync-cloud">☁️</span>
      <span class="sync-check">✓</span>
    </div>
    <div class="sync-text">
      <b>${escapeHtml(gameName || "Save")}</b> synced${version ? ` · v${version}` : ""}
      ${deviceId ? `<div class="muted">from ${escapeHtml(deviceId)}</div>` : ""}
    </div>`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("done"), 1400); // reveal the check
  setTimeout(() => el.classList.add("out"), 4200);
  setTimeout(() => el.remove(), 4800);
}

// ---- Vault ---------------------------------------------------------------
async function renderVault() {
  const wrap = $("#vault-list");
  wrap.innerHTML = `<p class="muted">Loading…</p>`;
  let games;
  try {
    games = await api("GET", "/api/vault");
  } catch (e) {
    wrap.innerHTML = "";
    return toast("Vault load failed: " + e.message, true);
  }
  state.vault = games;
  $("#vault-empty").classList.toggle("hidden", games.length > 0);
  wrap.innerHTML = "";
  for (const g of games) {
    const card = document.createElement("div");
    card.className = "vault-card collapsed";
    const cover = g.coverUrl
      ? `<div class="vault-cover" style="background-image:url('${g.coverUrl}')"></div>`
      : `<div class="vault-cover ph">${escapeHtml(g.name)}</div>`;
    const rows = (g.versions || [])
      .map((v) => {
        const cur = v.version === g.currentVersion;
        return `<tr>
          <td>v${v.version}${cur ? ` <span class="pill cur">current</span>` : ""}</td>
          <td class="muted">${escapeHtml(v.deviceId || "—")}</td>
          <td class="muted">${(v.size / 1024 / 1024).toFixed(2)} MB</td>
          <td class="muted">${fmtDate(v.createdAt)}</td>
          <td class="vault-row-actions">
            <a href="/api/sync/download/${g.id}?version=${v.version}" target="_blank"><button title="Download this version">Get</button></a>
            <button data-restore="${v.version}" ${cur ? "disabled" : ""} title="Make this the current save on every device">Restore</button>
            <button data-del="${v.version}" ${cur ? "disabled" : ""} class="danger" title="Delete this version permanently">✕</button>
          </td>
        </tr>`;
      })
      .join("");
    card.innerHTML = `
      ${cover}
      <div class="vault-body">
        <div class="vault-head">
          <div class="vault-head-left">
            <span class="chev">▸</span>
            <span class="title">${escapeHtml(g.name)}</span>
          </div>
          <div class="vault-actions">
            <span class="pill">${g.versions.length} version${g.versions.length === 1 ? "" : "s"}</span>
            <span class="pill">current v${g.currentVersion}</span>
            <button data-prune ${g.versions.length <= 1 ? "disabled" : ""} title="Delete old versions, keeping the newest N">Prune…</button>
          </div>
        </div>
        <table class="path-table vault-versions"><tbody>${
          rows || `<tr><td class="muted">No versions yet.</td></tr>`
        }</tbody></table>
      </div>`;
    card.querySelector(".vault-head").onclick = () => card.classList.toggle("collapsed");
    card.querySelector("[data-prune]").onclick = (e) => { e.stopPropagation(); pruneVersions(g); };
    $$("[data-restore]", card).forEach((b) => (b.onclick = () => restoreVersion(g, Number(b.dataset.restore))));
    $$("[data-del]", card).forEach((b) => (b.onclick = () => deleteVersion(g, Number(b.dataset.del))));
    wrap.appendChild(card);
  }
}

async function restoreVersion(g, version) {
  if (!confirm(`Restore "${g.name}" to v${version}?\n\nThis becomes the current save and every device will sync back to it. Nothing is deleted — it's added as a new version.`)) return;
  try {
    const r = await api("POST", `/api/games/${g.id}/versions/${version}/restore`);
    toast(`Restored v${version} → now current as v${r.version}`);
  } catch (e) {
    return toast("Restore failed: " + e.message, true);
  }
  await renderVault();
  loadAll();
}

async function deleteVersion(g, version) {
  if (!confirm(`Permanently delete v${version} of "${g.name}"?\n\nThis frees its storage and can't be undone.`)) return;
  try {
    await api("DELETE", `/api/games/${g.id}/versions/${version}`);
    toast(`Deleted v${version}`);
  } catch (e) {
    return toast("Delete failed: " + e.message, true);
  }
  await renderVault();
}

async function pruneVersions(g) {
  const ans = prompt(`Keep how many of the newest versions for "${g.name}"?\n\nOlder ones (except the current) will be deleted permanently.`, "5");
  if (ans == null) return;
  const keep = Math.max(1, parseInt(ans, 10) || 1);
  try {
    const r = await api("POST", `/api/games/${g.id}/versions/prune`, { keep });
    toast(r.removed ? `Pruned ${r.removed} old version${r.removed === 1 ? "" : "s"}` : "Nothing to prune");
  } catch (e) {
    return toast("Prune failed: " + e.message, true);
  }
  await renderVault();
}

// ---- Tabs / wiring -------------------------------------------------------
function activateTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.remove("active"));
  state.tab = name;
  $(`#tab-${name}`).classList.add("active");
  if (name === "vault") renderVault();
}
$$(".tab").forEach((tab) => {
  tab.onclick = () => activateTab(tab.dataset.tab);
});
// Clicking the logo returns to the Library.
$(".brand").onclick = () => activateTab("library");
$("#add-game-btn").onclick = openAddGame;
$("#add-device-btn").onclick = openAddDevice;
$("#settings-btn").onclick = openSettings;

// ---- utils ---------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;
function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}
function fmtDate(d) {
  if (!d) return "never";
  const dt = new Date(d);
  return dt.toLocaleString();
}

// ---- Setup tab -----------------------------------------------------------
function renderSetup() {
  const origin = location.origin;
  const snip = $("#hub-url-snippet");
  if (snip) snip.textContent = origin;
  const snip2 = $("#hub-url-snippet2");
  if (snip2) snip2.textContent = origin;
  const addr = $("#addr-local");
  if (addr) addr.textContent = origin;
  // Is the client package actually present on the hub?
  fetch("/downloads/GameSyncClient-win-x64.zip", { method: "HEAD" })
    .then((res) => {
      const ok = res.ok;
      $("#client-dl")?.classList.toggle("hidden", !ok);
      $("#dl-missing")?.classList.toggle("hidden", ok);
    })
    .catch(() => {});
}

// ---- boot ----------------------------------------------------------------
renderSetup();
loadAll().then(() => {
  // The client opens the hub as /?synced=<gameId>&v=<version> right after a
  // game exits — play the sync animation for that game, then clean the URL.
  const params = new URLSearchParams(location.search);
  const gid = Number(params.get("synced"));
  if (gid) {
    const g = state.games.find((x) => x.id === gid);
    playSyncAnimation(g ? g.name : "Save", params.get("v"), null);
    history.replaceState({}, "", location.pathname);
  }
});
connectWS();
setInterval(loadAll, 8000); // polling fallback
