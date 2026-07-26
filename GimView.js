/**
 * @name GimView
 * @description A plugin that allows you to make/import texture packs into Gimkit
 * @author Jdjd141414
 * @version 1.2.0
 */

(() => {
  if (window.__GIMVIEW_TEXTURE_PACK__) return;
  window.__GIMVIEW_TEXTURE_PACK__ = true;

  const PANEL_ID = "gimview-panel";
  const TOGGLE_ID = "gimview-toggle";
  const DEV_PANEL_ID = "gimview-dev-panel";

  const STORE_KEY = "gimview.texturepack.lastsummary.v1";
  const DB_NAME = "gimview.texturepack.db";
  const DB_VERSION = 1;
  const DB_STORE = "handles";
  const LAST_HANDLE_KEY = "lastPackHandle";

  let enabled = true;
  let panelOpen = false;
  let devMode = false;

  // exact-path => blobUrl
  const exactMap = new Map();
  // basename => blobUrl (fallback)
  const baseMap = new Map();
  // for cleanup
  const objectUrls = new Set();
  const importedFiles = [];
  let packName = "No pack loaded";

  let savedRootHandle = null;
  let loadingPack = false;

  // dev mode image inventory
  const xhrImages = [];
  const xhrImageKeys = new Set();

  function log(...args) {
    try {
      console.log("[GimView]", ...args);
    } catch {}
  }

  function buttonStyle(bg = "#2d2d38") {
    return `
      cursor:pointer;
      background:${bg};
      color:#fff;
      border:0;
      border-radius:10px;
      padding:8px 12px;
      font-size:12px;
      font-weight:700;
    `;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function normalizePath(path) {
    let p = String(path || "").replaceAll("\\", "/").trim();
    if (!p) return "";
    try {
      p = new URL(p, location.href).pathname;
    } catch {}
    p = p.split("#")[0].split("?")[0];
    p = p.replace(/\/{2,}/g, "/");
    if (p.startsWith("./")) p = p.slice(2);
    if (p.startsWith("/")) p = p.slice(1);
    p = decodeURIComponent(p);
    p = p.toLowerCase();

    // Support common accidental duplicate extensions like .png.png
    p = p.replace(/\.png\.png$/i, ".png");
    p = p.replace(/\.jpg\.jpg$/i, ".jpg");
    p = p.replace(/\.jpeg\.jpeg$/i, ".jpeg");
    p = p.replace(/\.webp\.webp$/i, ".webp");
    p = p.replace(/\.gif\.gif$/i, ".gif");

    return p;
  }

  function getBasename(path) {
    const p = normalizePath(path);
    if (!p) return "";
    return p.split("/").pop() || "";
  }

  function getDisplayNameFromUrl(url) {
    const base = getBasename(url);
    if (!base) return "unknown.png";
    const noExt = base.replace(/\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i, "");
    return `${noExt || "unknown"}.png`;
  }

  function guessMime(name) {
    const n = String(name || "").toLowerCase();
    if (n.endsWith(".png")) return "image/png";
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
    if (n.endsWith(".webp")) return "image/webp";
    if (n.endsWith(".gif")) return "image/gif";
    if (n.endsWith(".bmp")) return "image/bmp";
    if (n.endsWith(".svg")) return "image/svg+xml";
    return "application/octet-stream";
  }

  function clearPack(keepHandle = true) {
    for (const url of objectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    objectUrls.clear();
    exactMap.clear();
    baseMap.clear();
    importedFiles.length = 0;
    packName = "No pack loaded";
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}

    if (!keepHandle) {
      savedRootHandle = null;
      deleteSavedHandle().catch(() => {});
    }

    refreshPanel();
    refreshDevPanel();
  }

  function registerFile(pathKey, file) {
    const exact = normalizePath(pathKey);
    if (!exact) return;

    const objectUrl = URL.createObjectURL(file);
    objectUrls.add(objectUrl);

    exactMap.set(exact, objectUrl);

    const base = getBasename(exact);
    if (base && !baseMap.has(base)) {
      baseMap.set(base, objectUrl);
    }

    importedFiles.push({
      path: exact,
      name: file.name,
      type: file.type || guessMime(file.name),
      size: file.size,
      url: objectUrl,
    });
  }

  async function scanDirectory(dirHandle, prefix = "") {
    for await (const [name, handle] of dirHandle.entries()) {
      const next = prefix ? `${prefix}/${name}` : name;

      if (handle.kind === "directory") {
        await scanDirectory(handle, next);
      } else if (handle.kind === "file") {
        const file = await handle.getFile();
        registerFile(next, file);
      }
    }
  }

  function findReplacement(inputUrl) {
    if (!enabled) return "";

    let pathname = "";
    try {
      pathname = new URL(String(inputUrl), location.href).pathname;
    } catch {
      pathname = String(inputUrl || "");
    }

    const exact = normalizePath(pathname);
    if (exact && exactMap.has(exact)) return exactMap.get(exact);

    const base = getBasename(exact);
    if (base && baseMap.has(base)) return baseMap.get(base);

    return "";
  }

  function setStatus(message) {
    const el = document.getElementById("gimview-status");
    if (el) el.textContent = message;
  }

  function refreshPanel() {
    const countEl = document.getElementById("gimview-count");
    const listEl = document.getElementById("gimview-list");
    const packEl = document.getElementById("gimview-packname");
    const reopenBtn = document.getElementById("gimview-reopen");

    if (countEl) countEl.textContent = `${importedFiles.length} file(s) loaded`;
    if (packEl) packEl.textContent = packName;

    if (reopenBtn) {
      reopenBtn.style.display = savedRootHandle ? "inline-block" : "none";
    }

    if (!listEl) return;

    const items = importedFiles
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path));

    listEl.innerHTML = "";

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:14px 12px;color:#b8b8b8;font-size:13px;";
      empty.textContent = "Import a folder to start swapping textures.";
      listEl.appendChild(empty);
      return;
    }

    for (const item of items.slice(0, 300)) {
      const row = document.createElement("div");
      row.style.cssText = `
        display:grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        align-items: start;
      `;

      const left = document.createElement("div");
      left.innerHTML = `
        <div style="font-size:12px;font-weight:800;color:#fff;">${escapeHtml(item.path)}</div>
        <div style="font-size:11px;color:#a7a7a7;margin-top:2px;">
          ${escapeHtml(item.type)} · ${item.size} bytes
        </div>
      `;

      const btns = document.createElement("div");
      btns.style.cssText = "display:flex;gap:6px;align-items:center;";

      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy path";
      copyBtn.style.cssText = buttonStyle();
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(item.path);
          copyBtn.textContent = "Copied";
          setTimeout(() => (copyBtn.textContent = "Copy path"), 900);
        } catch {}
      };

      const openBtn = document.createElement("button");
      openBtn.textContent = "Open";
      openBtn.style.cssText = buttonStyle();
      openBtn.onclick = () => {
        try {
          window.open(item.url, "_blank", "noopener,noreferrer");
        } catch {}
      };

      btns.appendChild(copyBtn);
      btns.appendChild(openBtn);

      row.appendChild(left);
      row.appendChild(btns);
      listEl.appendChild(row);
    }

    if (items.length > 300) {
      const more = document.createElement("div");
      more.style.cssText = "padding:10px 12px;color:#a7a7a7;font-size:12px;";
      more.textContent = `Showing 300 of ${items.length} imported files.`;
      listEl.appendChild(more);
    }
  }

  function refreshDevPanel() {
    const listEl = document.getElementById("gimview-dev-list");
    const countEl = document.getElementById("gimview-dev-count");
    const modeEl = document.getElementById("gimview-dev-mode");

    if (countEl) countEl.textContent = `${xhrImages.length} image XHR(s)`;
    if (modeEl) modeEl.textContent = devMode ? "ON" : "OFF";
    if (!listEl) return;

    listEl.innerHTML = "";

    if (!devMode) {
      const off = document.createElement("div");
      off.style.cssText = "padding:14px 12px;color:#b8b8b8;font-size:13px;";
      off.textContent = "Press = or + to open dev mode.";
      listEl.appendChild(off);
      return;
    }

    if (xhrImages.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:14px 12px;color:#b8b8b8;font-size:13px;";
      empty.textContent = "No image XHRs captured yet.";
      listEl.appendChild(empty);
      return;
    }

    const items = xhrImages.slice().sort((a, b) => a.name.localeCompare(b.name));

    for (const item of items) {
      const row = document.createElement("div");
      row.style.cssText = `
        display:grid;
        grid-template-columns: 72px 1fr;
        gap: 10px;
        padding: 10px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        align-items: start;
      `;

      const previewWrap = document.createElement("div");
      previewWrap.style.cssText = `
        width: 64px;
        height: 64px;
        border-radius: 10px;
        overflow: hidden;
        background: #0d0d12;
        border: 1px solid rgba(255,255,255,0.10);
        display:flex;
        align-items:center;
        justify-content:center;
      `;

      const img = document.createElement("img");
      img.src = item.url;
      img.alt = item.name;
      img.loading = "lazy";
      img.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: cover;
        image-rendering: auto;
      `;
      previewWrap.appendChild(img);

      const right = document.createElement("div");
      right.innerHTML = `
        <div style="font-size:12px;font-weight:800;color:#fff;word-break:break-word;">
          ${escapeHtml(item.name)}
        </div>
        <div style="font-size:11px;color:#a7a7a7;margin-top:2px;word-break:break-word;">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" style="color:#8ab4ff;text-decoration:none;">
            ${escapeHtml(item.url)}
          </a>
        </div>
        <div style="font-size:11px;color:#9ca3af;margin-top:2px;">
          ${escapeHtml(item.path)}
        </div>
      `;

      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;";

      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy link";
      copyBtn.style.cssText = buttonStyle();
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(item.url);
          copyBtn.textContent = "Copied";
          setTimeout(() => (copyBtn.textContent = "Copy link"), 900);
        } catch {}
      };

      const openBtn = document.createElement("button");
      openBtn.textContent = "Open";
      openBtn.style.cssText = buttonStyle();
      openBtn.onclick = () => {
        try {
          window.open(item.url, "_blank", "noopener,noreferrer");
        } catch {}
      };

      btnRow.appendChild(copyBtn);
      btnRow.appendChild(openBtn);
      right.appendChild(btnRow);

      row.appendChild(previewWrap);
      row.appendChild(right);
      listEl.appendChild(row);
    }
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(handle, LAST_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function loadHandle() {
    const db = await openDB();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(LAST_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  }

  async function deleteSavedHandle() {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).delete(LAST_HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
  }

  async function canUseHandle(handle) {
    try {
      if (!handle) return false;
      if (typeof handle.queryPermission === "function") {
        const state = await handle.queryPermission({ mode: "read" });
        if (state === "granted") return true;
        if (state === "prompt") {
          const requested = await handle.requestPermission({ mode: "read" });
          return requested === "granted";
        }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function importFromHandle(rootHandle, label = null) {
    if (!rootHandle) return false;
    if (loadingPack) return false;

    loadingPack = true;
    try {
      clearPack(true);

      const ok = await canUseHandle(rootHandle);
      if (!ok) {
        setStatus("Folder permission is not available. Import the pack again.");
        return false;
      }

      packName = label || rootHandle.name || "Imported pack";
      setStatus("Scanning folder...");

      await scanDirectory(rootHandle, "");

      savedRootHandle = rootHandle;
      await saveHandle(rootHandle);

      try {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            packName,
            count: importedFiles.length,
            importedAt: Date.now(),
          })
        );
      } catch {}

      refreshPanel();
      refreshDevPanel();
      setStatus(`Loaded ${importedFiles.length} file(s) from ${packName}.`);
      log("Texture pack loaded:", packName, importedFiles.length);
      return true;
    } catch (err) {
      setStatus(`Import failed: ${err?.message || err}`);
      return false;
    } finally {
      loadingPack = false;
    }
  }

  async function tryRestoreLastPack() {
    if (loadingPack) return;
    if (savedRootHandle) return;

    try {
      const handle = await loadHandle();
      if (!handle) return;

      savedRootHandle = handle;
      const ok = await importFromHandle(handle, handle.name || "Last pack");
      if (!ok) {
        savedRootHandle = null;
        await deleteSavedHandle();
      }
    } catch {
      savedRootHandle = null;
    }
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      top: 72px;
      right: 18px;
      width: 420px;
      max-height: 78vh;
      overflow: hidden;
      z-index: 2147483647;
      background: rgba(18, 18, 24, 0.98);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      display: none;
    `;

    panel.innerHTML = `
      <div style="padding:12px 12px 10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div>
          <div style="font-size:16px;font-weight:900;">GimView</div>
          <div id="gimview-packname" style="font-size:12px;opacity:.8;margin-top:2px;">No pack loaded</div>
          <div id="gimview-count" style="font-size:12px;opacity:.8;margin-top:2px;">0 file(s) loaded</div>
        </div>
        <button id="gimview-close" style="${buttonStyle()}">Close</button>
      </div>

      <div style="padding:10px 12px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,0.08);">
        <button id="gimview-import" style="${buttonStyle("#4f46e5")}">Import Pack</button>
        <button id="gimview-reopen" style="${buttonStyle("#1f6feb")}">Reopen Last Pack</button>
        <button id="gimview-toggle-enabled" style="${buttonStyle()}">Disable</button>
        <button id="gimview-clear" style="${buttonStyle()}">Clear</button>
        <button id="gimview-copyall" style="${buttonStyle()}">Copy all paths</button>
      </div>

      <div id="gimview-status" style="padding:10px 12px;font-size:12px;color:#cfcfcf;border-bottom:1px solid rgba(255,255,255,0.08);">
        Ready.
      </div>

      <div id="gimview-list" style="overflow:auto;max-height:calc(78vh - 162px);"></div>
    `;

    document.body.appendChild(panel);

    panel.querySelector("#gimview-close").onclick = () => {
      panel.style.display = "none";
      panelOpen = false;
    };

    panel.querySelector("#gimview-toggle-enabled").onclick = () => {
      enabled = !enabled;
      panel.querySelector("#gimview-toggle-enabled").textContent = enabled ? "Disable" : "Enable";
      setStatus(enabled ? "Texture swapping enabled." : "Texture swapping disabled.");
    };

    panel.querySelector("#gimview-clear").onclick = () => {
      clearPack(false);
      setStatus("Texture pack cleared.");
    };

    panel.querySelector("#gimview-copyall").onclick = async () => {
      const text = importedFiles.map((f) => f.path).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        setStatus("All paths copied.");
      } catch {
        setStatus("Clipboard access failed.");
      }
    };

    panel.querySelector("#gimview-import").onclick = async () => {
      if (!window.showDirectoryPicker) {
        setStatus("This browser does not support folder import.");
        return;
      }

      try {
        setStatus("Pick the root of your texture pack folder...");
        const root = await window.showDirectoryPicker({ mode: "read" });
        await importFromHandle(root, root.name || "Imported pack");
      } catch (err) {
        if (err && err.name === "AbortError") {
          setStatus("Import canceled.");
        } else {
          setStatus(`Import failed: ${err?.message || err}`);
        }
      }
    };

    panel.querySelector("#gimview-reopen").onclick = async () => {
      if (!savedRootHandle) {
        setStatus("No saved pack found.");
        return;
      }
      const ok = await importFromHandle(savedRootHandle, savedRootHandle.name || "Last pack");
      if (!ok) {
        setStatus("Could not reopen the last pack.");
      }
    };

    refreshPanel();
  }

  function createDevPanel() {
    if (document.getElementById(DEV_PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = DEV_PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      top: 72px;
      left: 18px;
      width: 460px;
      max-height: 78vh;
      overflow: hidden;
      z-index: 2147483647;
      background: rgba(13, 13, 18, 0.98);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      display: none;
    `;

    panel.innerHTML = `
      <div style="padding:12px 12px 10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div>
          <div style="font-size:16px;font-weight:900;">GimView Dev</div>
          <div style="font-size:12px;opacity:.8;margin-top:2px;">
            <span id="gimview-dev-mode">OFF</span> · <span id="gimview-dev-count">0 image XHR(s)</span>
          </div>
        </div>
        <button id="gimview-dev-close" style="${buttonStyle()}">Close</button>
      </div>

      <div style="padding:10px 12px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,0.08);">
        <button id="gimview-dev-clear" style="${buttonStyle()}">Clear images</button>
        <button id="gimview-dev-copyall" style="${buttonStyle()}">Copy all links</button>
      </div>

      <div id="gimview-dev-list" style="overflow:auto;max-height:calc(78vh - 118px);"></div>
    `;

    document.body.appendChild(panel);

    panel.querySelector("#gimview-dev-close").onclick = () => {
      panel.style.display = "none";
    };

    panel.querySelector("#gimview-dev-clear").onclick = () => {
      xhrImages.length = 0;
      xhrImageKeys.clear();
      refreshDevPanel();
      setStatus("Dev image list cleared.");
    };

    panel.querySelector("#gimview-dev-copyall").onclick = async () => {
      const text = xhrImages.map((item) => item.url).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        setStatus("All dev links copied.");
      } catch {
        setStatus("Clipboard access failed.");
      }
    };

    refreshDevPanel();
  }

  function createToggle() {
    if (document.getElementById(TOGGLE_ID)) return;

    const btn = document.createElement("button");
    btn.id = TOGGLE_ID;
    btn.textContent = "GimView";
    btn.style.cssText = `
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 2147483647;
      background: #4f46e5;
      color: white;
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 900;
      cursor: pointer;
      box-shadow: 0 8px 20px rgba(0,0,0,0.25);
    `;

    btn.onclick = () => {
      const panel = document.getElementById(PANEL_ID);
      if (!panel) return;
      panelOpen = !panelOpen;
      panel.style.display = panelOpen ? "block" : "none";
    };

    document.body.appendChild(btn);
  }

  function toggleDevMode(force) {
    devMode = typeof force === "boolean" ? force : !devMode;
    const panel = document.getElementById(DEV_PANEL_ID);
    if (panel) panel.style.display = devMode ? "block" : "none";
    refreshDevPanel();
    setStatus(devMode ? "Dev mode enabled." : "Dev mode disabled.");
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = String(el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function hookHotkey() {
    if (window.__GIMVIEW_HOTKEY_HOOKED__) return;
    window.__GIMVIEW_HOTKEY_HOOKED__ = true;

    window.addEventListener("keydown", (event) => {
      if (isTypingTarget(document.activeElement)) return;

      const key = String(event.key || "").toLowerCase();

      // "=" or "+" toggles dev mode
      if (key === "=" || key === "+" || event.code === "Equal") {
        toggleDevMode();
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  function isImageUrl(url) {
    const s = String(url || "").toLowerCase();
    return (
      s.includes(".png") ||
      s.includes(".jpg") ||
      s.includes(".jpeg") ||
      s.includes(".webp") ||
      s.includes(".gif") ||
      s.includes(".bmp") ||
      s.includes(".svg")
    );
  }

  function rememberXhrImage(url) {
    const normalized = String(url || "").trim();
    if (!normalized || !isImageUrl(normalized)) return;

    const key = normalizePath(normalized);
    if (xhrImageKeys.has(key)) return;
    xhrImageKeys.add(key);

    xhrImages.push({
      url: normalized,
      path: normalizePath(normalized),
      name: getDisplayNameFromUrl(normalized),
    });

    refreshDevPanel();
  }

  function hookFetch() {
    if (window.__GIMVIEW_FETCH_HOOKED__) return;
    window.__GIMVIEW_FETCH_HOOKED__ = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") return;

    window.fetch = async function (input, init) {
      try {
        const url = typeof input === "string" || input instanceof URL
          ? String(input)
          : input && typeof input === "object" && "url" in input
            ? String(input.url)
            : "";

        if (url) {
          rememberXhrImage(url);
        }

        const replacement = url ? findReplacement(url) : "";
        if (replacement) {
          log("fetch -> local:", url, "=>", replacement);
          const originalResponse = await originalFetch.call(this, replacement, init);

          const blob = await originalResponse.blob();
          return new Response(blob, {
            status: 200,
            statusText: "OK",
            headers: {
              "Content-Type": blob.type || guessMime(url),
            },
          });
        }
      } catch {}
      return originalFetch.call(this, input, init);
    };
  }

  function hookXHR() {
    if (window.__GIMVIEW_XHR_HOOKED__) return;
    window.__GIMVIEW_XHR_HOOKED__ = true;

    const originalOpen = XMLHttpRequest.prototype.open;
    if (typeof originalOpen !== "function") return;

    XMLHttpRequest.prototype.open = function (method, url, async = true, user, password) {
      try {
        if (url) {
          rememberXhrImage(url);
        }

        const replacement = url ? findReplacement(url) : "";
        if (replacement) {
          log("xhr -> local:", url, "=>", replacement);
          this.__gimview_original_url = String(url);
          this.__gimview_replaced_url = replacement;
          return originalOpen.call(this, method, replacement, async, user, password);
        }
      } catch {}
      return originalOpen.call(this, method, url, async, user, password);
    };
  }

  function hookImageSrc() {
    if (window.__GIMVIEW_IMAGE_HOOKED__) return;
    window.__GIMVIEW_IMAGE_HOOKED__ = true;

    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    if (!desc || !desc.get || !desc.set) return;

    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value) {
        try {
          const replacement = value ? findReplacement(value) : "";
          if (replacement) {
            log("img src -> local:", value, "=>", replacement);
            return desc.set.call(this, replacement);
          }
        } catch {}
        return desc.set.call(this, value);
      },
    });
  }

  function hookPixiTextureFrom() {
    if (window.__GIMVIEW_PIXI_HOOKED__) return;
    window.__GIMVIEW_PIXI_HOOKED__ = true;

    const tryHook = () => {
      const PIXI = window.PIXI;
      if (!PIXI || !PIXI.Texture || typeof PIXI.Texture.from !== "function") return false;
      if (PIXI.Texture.from.__gimview_patched) return true;

      const original = PIXI.Texture.from;

      function wrappedFrom(source, ...rest) {
        try {
          const replacement = source ? findReplacement(source) : "";
          if (replacement) {
            log("PIXI.Texture.from -> local:", source, "=>", replacement);
            return original.call(this, replacement, ...rest);
          }
        } catch {}
        return original.call(this, source, ...rest);
      }

      wrappedFrom.__gimview_patched = true;
      PIXI.Texture.from = wrappedFrom;
      return true;
    };

    if (tryHook()) return;

    const interval = setInterval(() => {
      if (tryHook()) clearInterval(interval);
    }, 250);

    setTimeout(() => clearInterval(interval), 10000);
  }

  async function boot() {
    createPanel();
    createDevPanel();
    createToggle();
    hookHotkey();
    hookFetch();
    hookXHR();
    hookImageSrc();
    hookPixiTextureFrom();

    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.packName) {
          packName = parsed.packName;
          refreshPanel();
        }
      }
    } catch {}

    await tryRestoreLastPack();

    log("GimView ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  window.GimView = {
    get enabled() {
      return enabled;
    },
    set enabled(value) {
      enabled = !!value;
      refreshPanel();
    },
    get devMode() {
      return devMode;
    },
    set devMode(value) {
      toggleDevMode(!!value);
    },
    get importedFiles() {
      return importedFiles.slice();
    },
    get xhrImages() {
      return xhrImages.slice();
    },
    get packName() {
      return packName;
    },
    clear() {
      clearPack(false);
    },
    refresh: refreshPanel,
    refreshDev: refreshDevPanel,
    async reopenLastPack() {
      if (savedRootHandle) {
        return importFromHandle(savedRootHandle, savedRootHandle.name || "Last pack");
      }
      const handle = await loadHandle();
      if (!handle) return false;
      savedRootHandle = handle;
      return importFromHandle(handle, handle.name || "Last pack");
    },
    show() {
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        panel.style.display = "block";
        panelOpen = true;
      }
    },
    hide() {
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        panel.style.display = "none";
        panelOpen = false;
      }
    },
    toggleDev() {
      toggleDevMode();
    },
  };
})();
