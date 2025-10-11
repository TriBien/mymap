/* -------------------------
  IndexedDB helper (simple)
----------------------------*/
const DB_NAME = "mindmaps_db_v1";
const STORE = "maps";

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(obj) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(obj);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* -------------------------
  Data model & helpers
----------------------------*/
function uid(prefix = "n") {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}

function createEmptyMap(name = "Untitled") {
  const rootId = uid("root");
  return {
    id: uid("map"),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nodes: {
      [rootId]: {
        id: rootId,
        text: "Root Node",
        x: 0,
        y: 0,
        parent: null,
        children: [],
        collapsed: false,
      },
    },
    rootId,
  };
}

/* -------------------------
  Visualization & interactions
----------------------------*/
const svg = document.getElementById("svgRoot");
const wrap = document.getElementById("wrap");
const NODE_RADIUS = 58;
const ICON_SIZE = 30;
let mapsCache = [];
let currentMap = null;
let dragging = null;

function screenCenter() {
  const rect = wrap.getBoundingClientRect();
  return { x: rect.width / 2, y: rect.height / 2 };
}

function setMapNameUI() {
  document.getElementById("currentMapName").textContent =
    currentMap?.name || "Untitled";
}

async function refreshMapsList() {
  mapsCache = await idbGetAll();
  const sel = document.getElementById("mapsList");
  sel.innerHTML = "";
  const blankOpt = document.createElement("option");
  blankOpt.value = "";
  blankOpt.textContent = "-- Load saved map --";
  sel.appendChild(blankOpt);
  mapsCache.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name + " • " + new Date(m.updatedAt).toLocaleString();
    sel.appendChild(opt);
  });
}

function ensureInitialPositions(map) {
  const { x, y } = screenCenter();
  const root = map.nodes[map.rootId];
  if (root.x === 0 && root.y === 0) {
    root.x = x;
    root.y = y;
  }
  Object.values(map.nodes).forEach((n) => {
    if (n.x === 0 && n.y === 0) {
      if (n.parent && map.nodes[n.parent]) {
        const p = map.nodes[n.parent];
        n.x = p.x + (Math.random() * 240 - 120);
        n.y = p.y + (Math.random() * 120 - 60);
      } else {
        n.x = x + (Math.random() * 100 - 50);
        n.y = y + (Math.random() * 60 - 30);
      }
    }
  });
}

/* ---- render mindmap ---- */
function render() {
  if (!currentMap) return;
  svg.innerHTML = "";

  const nodes = currentMap.nodes;

  // draw smooth connections
  const pathGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(pathGroup);
  Object.values(nodes).forEach((node) => {
    if (!node.parent) return;
    const parent = nodes[node.parent];
    if (!parent) return;

    // hide if any ancestor collapsed
    let anc = parent;
    let hidden = false;
    while (anc) {
      if (anc.collapsed) {
        hidden = true;
        break;
      }
      anc = anc.parent ? nodes[anc.parent] : null;
    }
    if (hidden) return;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "path-line");
    path.setAttribute(
      "d",
      computeSmoothPath(parent.x, parent.y, node.x, node.y)
    );
    pathGroup.appendChild(path);
  });

  // draw nodes
  Object.values(nodes).forEach((node) => {
    // skip hidden by ancestor
    let anc = node.parent ? nodes[node.parent] : null;
    let hidden = false;
    while (anc) {
      if (anc.collapsed) {
        hidden = true;
        break;
      }
      anc = anc.parent ? nodes[anc.parent] : null;
    }
    if (hidden) return;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "node-g");
    g.setAttribute("transform", `translate(${node.x},${node.y})`);
    g.dataset.id = node.id;

    // --- create circle and auto-fit text ---
    let radius = NODE_RADIUS;

    // create circle first
    const circle = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle"
    );
    circle.setAttribute("r", radius);
    circle.setAttribute("class", "node-circle");
    g.appendChild(circle);

    // wrapped multi-line text that fits inside circle
    const textGroup = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "text"
    );
    textGroup.setAttribute("class", "node-text");

    // function: wrap words to fit circle width
    function wrapTextToCircle(text, maxWidth) {
      const words = text.split(/\s+/);
      const lines = [];
      let currentLine = words[0] || "";

      for (let i = 1; i < words.length; i++) {
        const testLine = currentLine + " " + words[i];
        const measure = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "text"
        );
        measure.setAttribute("font-size", "14");
        measure.setAttribute("font-family", "sans-serif");
        measure.textContent = testLine;
        svg.appendChild(measure);
        const width = measure.getBBox().width;
        measure.remove();

        // if text too long for circle width, wrap to next line
        if (width < maxWidth * 1.7) {
          currentLine = testLine;
        } else {
          lines.push(currentLine);
          currentLine = words[i];
        }
      }
      lines.push(currentLine);
      return lines;
    }

    // split text into wrapped lines
    let wrappedLines = [];
    node.text.split(/\r?\n/).forEach((paragraph) => {
      wrappedLines.push(...wrapTextToCircle(paragraph, radius));
    });

    // measure and adjust radius if text exceeds circle height
    const lineHeight = 16;
    const totalHeight = wrappedLines.length * lineHeight;
    if (totalHeight / 2 > radius * 0.7) {
      // dynamically increase circle radius for large text blocks
      radius = totalHeight / 2 / 0.7;
      circle.setAttribute("r", radius);
    }

    // vertically center the text
    const startY = -((wrappedLines.length - 1) * lineHeight) / 2;

    wrappedLines.forEach((line, i) => {
      const tspan = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "tspan"
      );
      tspan.setAttribute("x", 0);
      tspan.setAttribute("y", startY + i * lineHeight);
      tspan.textContent = line;
      textGroup.appendChild(tspan);
    });

    g.appendChild(textGroup);

    const icons = document.createElementNS("http://www.w3.org/2000/svg", "g");
    icons.setAttribute("class", "node-icons");

    const iconOffset = radius - 14; // horizontal offset
    const iconTop = -radius + 10; // vertical offset

    icons.setAttribute("transform", `translate(${iconOffset},${iconTop})`);

    // add, delete, collapse
    icons.appendChild(
      makeIconGroup("+", ICON_SIZE, () => addChild(node.id), "add", 38)
    );
    icons.appendChild(
      makeIconGroup("del", ICON_SIZE, () => deleteNode(node.id), "del")
    );

    // collapse toggle (shows ➖ or ➕)
    const type = node.collapsed ? "expand" : "collapse";
    icons.appendChild(
      makeIconGroup(
        type,
        ICON_SIZE,
        () => toggleCollapse(node.id),
        "collapse",
        -38
      )
    );

    g.appendChild(icons);

    // drag events
    g.addEventListener("pointerdown", nodePointerDown);
    g.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startEdit(node.id);
    });

    svg.appendChild(g);
  });
}

function computeSmoothPath(x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const mx = (x1 + x2) / 2,
    my = (y1 + y2) / 2;
  const cx = mx - dy * 0.25,
    cy = my + dx * 0.08;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

/* ---- Icons (add, delete, collapse/expand) ---- */
function makeIconGroup(type, size, onClick, cls = "", dx = 0) {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("transform", `translate(${dx},0)`);
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", -size / 2 - 4);
  bg.setAttribute("y", -size / 2 - 4);
  bg.setAttribute("width", size + 8);
  bg.setAttribute("height", size + 8);
  bg.setAttribute("rx", 6);
  bg.setAttribute("class", "icon-bg");
  g.appendChild(bg);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  let d = "";
  path.setAttribute("stroke", "white");
  path.setAttribute("class", "icon-path");
  switch (type) {
    case "+":
      d = "M -4 0 H 4 M 0 -4 V 4";
      break;
    case "del":
      // ❌ red X delete icon
      d = "M -4 -4 L 4 4 M 4 -4 L -4 4";
      path.setAttribute("stroke", "#f7a7a7");
      //   path.setAttribute("class", "icon-x");
      break;
    case "collapse":
      d = "M -4 -1 L 0 4 L 4 -1";
      break; // minus
    case "expand":
      d = "M -2 -4 L 3 0 L -2 4";
      break; // plus for expand
  }
  path.setAttribute("d", d);
  path.setAttribute("stroke-width", 2);
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("transform", `scale(${size / 24})`);
  g.appendChild(path);

  g.style.cursor = "pointer";
  g.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  });
  return g;
}

/* ---- Node operations ---- */
function addChild(parentId) {
  const map = currentMap;
  const newId = uid("n");
  const p = map.nodes[parentId];
  const child = {
    id: newId,
    text: "New Node",
    x: p.x + 160,
    y: p.y + (Math.random() * 140 - 70),
    parent: parentId,
    children: [],
    collapsed: false,
  };
  map.nodes[newId] = child;
  p.children.push(newId);
  map.updatedAt = Date.now();
  saveCurrentMapDebounced();
  render();
  setTimeout(() => startEdit(newId), 120);
}

async function deleteNode(nodeId) {
  if (!currentMap) return;
  if (nodeId === currentMap.rootId) {
    alert("Cannot delete root node.");
    return;
  }

  const node = currentMap.nodes[nodeId];
  const ok = await showDeleteConfirm(
    "Delete Node",
    `Delete the node "${node.text.slice(0, 30)}" and all its children?`
  );
  if (!ok) return;

  const toRemove = collectSubtree(nodeId);
  const parent = currentMap.nodes[node.parent];
  if (parent)
    parent.children = parent.children.filter((id) => !toRemove.includes(id));
  toRemove.forEach((id) => delete currentMap.nodes[id]);
  currentMap.updatedAt = Date.now();
  saveCurrentMapDebounced();
  render();
}

function collectSubtree(nodeId) {
  const result = [nodeId];
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop();
    const n = currentMap.nodes[id];
    if (n?.children?.length) stack.push(...n.children);
    if (id !== nodeId) result.push(id);
  }
  return result;
}

function toggleCollapse(nodeId) {
  const node = currentMap.nodes[nodeId];
  node.collapsed = !node.collapsed;
  currentMap.updatedAt = Date.now();
  saveCurrentMapDebounced();
  render();
}

/* ---- Edit node text ---- */
function startEdit(nodeId) {
  const node = currentMap.nodes[nodeId];
  if (!node) return;

  // Hide old text temporarily
  const oldTextElement = svg.querySelector(`g[data-id="${nodeId}"] text`);
  if (oldTextElement) oldTextElement.style.visibility = "hidden";

  // Create textarea for multi-line editing
  const textarea = document.createElement("textarea");
  textarea.value = node.text;
  textarea.className = "edit-textarea";
  textarea.style.left = node.x - NODE_RADIUS * 1.7 + "px";
  textarea.style.top = node.y - NODE_RADIUS * 0.9 + "px";
  textarea.style.width = NODE_RADIUS * 3 + "px";
  textarea.style.height = NODE_RADIUS * 1.5 + "px";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  // Auto-resize as user types
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  });

  // Commit or cancel editing
  function finish(save = true) {
    if (save) {
      node.text = textarea.value.trim() || "—";
      currentMap.updatedAt = Date.now();
      saveCurrentMapDebounced();
    }
    textarea.remove();
    if (oldTextElement) oldTextElement.style.visibility = "visible";
    render();
  }

  textarea.addEventListener("blur", () => finish(true));
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") finish(false);
    // Ctrl+Enter or Cmd+Enter to finish editing
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      finish(true);
    }
  });
}

/* ---- Dragging ---- */
function nodePointerDown(e) {
  e.preventDefault();
  const g = e.currentTarget;
  const id = g.dataset.id;
  dragging = {
    id,
    startX: e.clientX,
    startY: e.clientY,
    origX: currentMap.nodes[id].x,
    origY: currentMap.nodes[id].y,
  };
  g.setPointerCapture(e.pointerId);
  g.style.cursor = "grabbing";
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp, { once: true });
}
function onPointerMove(e) {
  if (!dragging) return;
  const node = currentMap.nodes[dragging.id];
  node.x = dragging.origX + (e.clientX - dragging.startX);
  node.y = dragging.origY + (e.clientY - dragging.startY);
  render();
}
function onPointerUp() {
  if (!dragging) return;
  currentMap.updatedAt = Date.now();
  saveCurrentMapDebounced();
  dragging = null;
  document.removeEventListener("pointermove", onPointerMove);
}

/* ---- Map CRUD ---- */
async function newMap(name = "Untitled") {
  currentMap = createEmptyMap(name);
  ensureInitialPositions(currentMap);
  setMapNameUI();
  render();
}
async function saveCurrentMap() {
  if (!currentMap) return;
  currentMap.updatedAt = Date.now();
  await idbPut(currentMap);
  await refreshMapsList();
}
let saveTimer = null;
function saveCurrentMapDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentMap, 400);
}
async function loadMapById(id) {
  const rec = await idbGet(id);
  if (!rec) return alert("Map not found");
  currentMap = rec;
  ensureInitialPositions(rec);
  setMapNameUI();
  render();
}

/* ---- UI wiring ---- */
document.getElementById("newMapBtn").onclick = async () => {
  const name = prompt("New map name", "Untitled") || "Untitled";
  await newMap(name);
};
document.getElementById("saveMapBtn").onclick = () => saveCurrentMap();
document.getElementById("exportMapBtn").onclick = () => {
  const data = JSON.stringify(currentMap, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (currentMap.name || "mindmap") + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
};
document.getElementById("renameMapBtn").onclick = async () => {
  if (!currentMap) return;
  const n = prompt("Rename map", currentMap.name) || currentMap.name;
  currentMap.name = n;
  await saveCurrentMap();
  setMapNameUI();
};

document.getElementById("deleteMapBtn").addEventListener("click", async () => {
  if (!currentMap) return;
  const ok = await showDeleteConfirm(
    "Delete Mindmap",
    `Are you sure you want to permanently delete "${currentMap.name}"?`
  );
  if (!ok) return;

  await idbDelete(currentMap.id);
  currentMap = null;
  svg.innerHTML = "";
  await refreshMapsList();
});

document.getElementById("mapsList").onchange = async (e) => {
  if (e.target.value) await loadMapById(e.target.value);
};

svg.addEventListener("dblclick", (e) => {
  if (!currentMap) return;
  const pt = getSVGPoint(e.clientX, e.clientY);
  const id = uid("n");
  const root = currentMap.nodes[currentMap.rootId];
  currentMap.nodes[id] = {
    id,
    text: "New Node",
    x: pt.x,
    y: pt.y,
    parent: root.id,
    children: [],
    collapsed: false,
  };
  root.children.push(id);
  saveCurrentMapDebounced();
  render();
  startEdit(id);
});

function getSVGPoint(x, y) {
  const pt = svg.createSVGPoint();
  pt.x = x;
  pt.y = y;
  const ctm = svg.getScreenCTM().inverse();
  const res = pt.matrixTransform(ctm);
  return { x: res.x, y: res.y };
}

document.addEventListener("selectstart", (e) => {
  if (dragging) e.preventDefault();
});

// --- Import JSON Mindmap ---
const importMapBtn = document.getElementById("importMapBtn");
const importMapFile = document.getElementById("importMapFile");

importMapBtn.addEventListener("click", () => importMapFile.click());

importMapFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const json = JSON.parse(event.target.result);

      // ✅ Validate basic structure
      if (!json.nodes || !json.rootId) {
        alert("Invalid mindmap JSON format ❗");
        return;
      }

      // ✅ Ensure ID exists
      if (!json.id) json.id = uid("map");
      if (!json.name) json.name = "Imported Map";

      // ✅ Save into IndexedDB
      await idbPut(json);

      // ✅ Load into current view
      currentMap = json;
      ensureInitialPositions(currentMap);
      setMapNameUI();
      render();

      await refreshMapsList();
    } catch (err) {
      console.error(err);
      alert("Failed to import JSON: " + err.message);
    }
  };

  reader.readAsText(file);
});

// ✅ Modern Delete Confirmation Modal
function showDeleteConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirmModal");
    const titleEl = document.getElementById("confirmTitle");
    const msgEl = document.getElementById("confirmMessage");
    const btnCancel = document.getElementById("confirmCancel");
    const btnDelete = document.getElementById("confirmDelete");

    titleEl.textContent = title || "Confirm Delete";
    msgEl.textContent = message || "Are you sure you want to delete this?";
    modal.classList.remove("hidden");

    const close = (confirmed) => {
      modal.classList.add("hidden");
      btnCancel.removeEventListener("click", cancelHandler);
      btnDelete.removeEventListener("click", deleteHandler);
      resolve(confirmed);
    };

    const cancelHandler = () => close(false);
    const deleteHandler = () => close(true);

    btnCancel.addEventListener("click", cancelHandler);
    btnDelete.addEventListener("click", deleteHandler);
  });
}

(async function init() {
  await refreshMapsList();
  if (mapsCache.length) {
    mapsCache.sort((a, b) => b.updatedAt - a.updatedAt);
    currentMap = mapsCache[0];
  } else currentMap = createEmptyMap("Untitled");
  ensureInitialPositions(currentMap);
  setMapNameUI();
  render();
})();
