const ui = {
  banner: document.getElementById("banner"),
  projectLine: document.getElementById("project-line"),
  projectStatus: document.getElementById("project-status"),
  overviewData: document.getElementById("overview-data"),
  overviewCards: document.getElementById("overview-cards"),
  searchQ: document.getElementById("search-q"),
  searchMode: document.getElementById("search-mode"),
  searchBtn: document.getElementById("search-btn"),
  searchResults: document.getElementById("search-results"),
  searchEmpty: document.getElementById("search-empty"),
  memoryTableBody: document.querySelector("#memory-table tbody"),
  memoryDetail: document.getElementById("memory-detail"),
  memoryEmpty: document.getElementById("memory-empty"),
  reloadMemories: document.getElementById("reload-memories"),
  vectorizeBtn: document.getElementById("vectorize-btn"),
  indexBtn: document.getElementById("index-btn"),
  vectorStatus: document.getElementById("vector-status"),
  patchData: document.getElementById("patch-data"),
  taskData: document.getElementById("task-data"),
  taskAttempts: document.getElementById("task-attempts"),
  recurringErrorsData: document.getElementById("recurring-errors-data"),
  userCorrectionsData: document.getElementById("user-corrections-data"),
};

let selectedMemoryId = null;

function setBanner(type, message) {
  if (!message) {
    ui.banner.className = "banner hidden";
    ui.banner.textContent = "";
    return;
  }
  ui.banner.className = `banner ${type || "info"}`;
  ui.banner.textContent = message;
}

function setStatus(ok, text) {
  ui.projectStatus.textContent = text;
  ui.projectStatus.className = `pill ${ok ? "ok" : "err"}`;
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.textContent = label;
}

function fmtDate(input) {
  if (!input) return "-";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleString();
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusBadge(status) {
  const cls = String(status || "").toLowerCase();
  return `<span class="badge ${cls}">${status || "-"}</span>`;
}

async function fetchApi(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new Error(`Network error: ${String(err)}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Invalid JSON response (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(body.reason || body.error || `Request failed (${res.status})`);
  }
  return body;
}

function wireTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = Array.from(document.querySelectorAll(".panel"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

function renderOverviewCards(overview) {
  const counts = overview.memory_counts || {};
  const cards = [
    ["Project ID", shortId(overview.project_id), "neutral"],
    ["Memories", Number(counts.pending_vectorization || 0) + Number(counts.ready || 0) + Number(counts.failed || 0) + Number(counts.pending_retry || 0), "neutral"],
    ["Pending", counts.pending_vectorization || 0, "warn"],
    ["Ready", counts.ready || 0, "ok"],
    ["Failed", counts.failed || 0, "err"],
    ["Embedded", overview.embedded_count || 0, "accent"],
    ["Vector Search", overview.vector_search_enabled ? "On" : "Off", overview.vector_search_enabled ? "ok" : "neutral"],
    ["Worker", overview.worker_state || "-", "neutral"],
    ["Task Runs", overview.task_run_count || 0, "accent"],
    ["Patches", overview.patch_count || 0, "neutral"],
  ];
  ui.overviewCards.innerHTML = cards
    .map(([k, v, tone]) => `<article class="mini-card ${tone}"><h3>${k}</h3><p>${String(v)}</p></article>`)
    .join("");
}

async function loadOverview() {
  ui.projectLine.textContent = "Loading...";
  const [project, overview, vector] = await Promise.all([
    fetchApi("/api/project"),
    fetchApi("/api/overview"),
    fetchApi("/api/vectorization/status"),
  ]);
  ui.projectLine.textContent = `${project.identity.workspace_relative_path} · ${shortId(project.identity.project_id)}`;
  document.getElementById("workspace-label").textContent = project.profile.package_manager || "workspace";
  renderOverviewCards(overview);
  ui.overviewData.textContent = JSON.stringify(overview, null, 2);
  ui.vectorStatus.textContent = JSON.stringify(vector, null, 2);
  setStatus(true, "project loaded");
}

function detailValue(val) {
  if (val === undefined || val === null || val === "") return "-";
  if (Array.isArray(val)) return val.join(", ");
  return String(val);
}

async function loadMemories() {
  const filters = new URLSearchParams();
  const map = {
    type: "flt-type",
    status: "flt-status",
    language: "flt-language",
    toolchain: "flt-toolchain",
    error_class: "flt-error",
  };
  Object.entries(map).forEach(([k, id]) => {
    const v = document.getElementById(id).value.trim();
    if (v) filters.set(k, v);
  });
  filters.set("limit", "100");

  const data = await fetchApi(`/api/memories?${filters.toString()}`);
  const rows = data.records || [];
  ui.memoryTableBody.innerHTML = "";
  ui.memoryEmpty.classList.toggle("hidden", rows.length > 0);

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    if (selectedMemoryId === r.id) tr.classList.add("selected");
    tr.innerHTML = `<td class="mono">${shortId(r.id)}</td>
      <td>${r.type || "-"}</td>
      <td>${escapeHtml(r.summary || "-")}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${Number(r.confidence || 0).toFixed(2)}</td>
      <td>${r.language || "-"}</td>
      <td>${r.toolchain || "-"}</td>
      <td>${r.error_class || "-"}</td>
      <td>${r.retrieval_hits || 0}</td>
      <td>${fmtDate(r.created_at)}</td>`;
    tr.onclick = async () => {
      selectedMemoryId = r.id;
      await loadMemories();
      const detail = await fetchApi(`/api/memories/${encodeURIComponent(r.id)}`);
      const m = detail.record || {};
      ui.memoryDetail.innerHTML = `<div class="result-top">
        <span class="mono">${escapeHtml(m.id || "-")}</span>
        ${statusBadge(m.status)}
        <span>${escapeHtml(m.type || "-")}</span>
      </div>
      <p>${escapeHtml(detailValue(m.content))}</p>
      <pre class="code small">${escapeHtml(JSON.stringify(
        {
          symptoms: m.symptoms || "-",
          root_cause: m.root_cause || "-",
          fix_pattern: m.fix_pattern || "-",
          anti_patterns: m.anti_patterns || "-",
          verification_steps: m.verification_steps || "-",
          retrieval_hits: m.retrieval_hits || 0,
          last_retrieved_at: fmtDate(m.last_retrieved_at),
          metadata: m.metadata || {},
        },
        null,
        2,
      ))}</pre>`;
    };
    ui.memoryTableBody.appendChild(tr);
  });
}

async function runSearch() {
  const q = ui.searchQ.value.trim();
  if (!q) {
    ui.searchEmpty.textContent = "Enter a query.";
    return;
  }
  ui.searchEmpty.textContent = "Searching...";
  ui.searchResults.innerHTML = "";
  const mode = ui.searchMode.value;
  const data = await fetchApi(
    `/api/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}&limit=10&detail_level=summary&include_warnings=true`,
  );
  const results = data.results || [];
  const warnings = data.warnings || [];
  ui.searchEmpty.classList.toggle("hidden", results.length > 0);
  ui.searchEmpty.textContent = results.length ? "" : "No results.";
  ui.searchResults.innerHTML = results
    .map(
      (r) => `<article class="result-card">
      <div class="result-top">
        <span class="mono">${escapeHtml(shortId(r.id))}</span>
        <span class="pill">${escapeHtml(r.reason || "-")}</span>
        <span>score: ${Number(r.score || 0).toFixed(2)}</span>
      </div>
      <p>${escapeHtml(r.content || "-")}</p>
      <pre class="code small">${escapeHtml(JSON.stringify({ ranking_reasons: r.ranking_reasons || [], ranking_breakdown: r.ranking_breakdown || {} }, null, 2))}</pre>
      <pre class="code small">${escapeHtml(JSON.stringify(r.metadata || {}, null, 2))}</pre>
    </article>`,
    )
      .join("");
  if (warnings.length > 0) {
    ui.searchResults.innerHTML += `<article class="result-card"><div class="result-top"><span class="pill">cautions</span></div><pre class="code small">${escapeHtml(
      JSON.stringify(
        warnings.map((w) => ({
          type: w.type,
          summary: w.summary,
          warning_score: w.warning_score,
          warning_reasons: w.warning_reasons,
        })),
        null,
        2,
      ),
    )}</pre></article>`;
  }
}

function renderPatchHistory(data) {
  const rows = data.rows || [];
  if (!rows.length) {
    ui.patchData.innerHTML = `<div class="empty">No patch history yet.</div>`;
    return;
  }
  ui.patchData.innerHTML = `<div class="table-wrap"><table><thead><tr><th>file</th><th>status</th><th>reason</th><th>match</th><th>created</th></tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr><td class="mono">${r.file_path || "-"}</td><td>${r.success_flag ? "success" : "fail"}</td><td>${r.reason || "-"}</td><td>${r.match_count}</td><td>${fmtDate(r.created_at)}</td></tr>`,
      )
      .join("")}
  </tbody></table></div>`;
}

function renderTaskRuns(data) {
  const rows = data.rows || [];
  if (!rows.length) {
    ui.taskData.innerHTML = `<div class="empty">No task runs yet.</div>`;
    return;
  }
  ui.taskData.innerHTML = `<div class="table-wrap"><table><thead><tr><th>id</th><th>task</th><th>status</th><th>usage</th><th>started</th></tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr data-task-id="${r.id}"><td class="mono">${shortId(r.id)}</td><td>${r.task_text || "-"}</td><td>${r.status || "-"}</td><td class="mono">${JSON.stringify(r.command_usage || {})}</td><td>${fmtDate(r.started_at)}</td></tr>`,
      )
      .join("")}
  </tbody></table></div>`;
  Array.from(ui.taskData.querySelectorAll("tr[data-task-id]")).forEach((tr) => {
    tr.onclick = async () => {
      const id = tr.dataset.taskId;
      const detail = await fetchApi(`/api/task-runs/${encodeURIComponent(id)}`);
      ui.taskAttempts.textContent = JSON.stringify(detail.attempts || [], null, 2);
    };
  });
}

function renderRecurringErrors(data) {
  const rows = data.recurring_errors || [];
  if (!rows.length) {
    ui.recurringErrorsData.innerHTML = `<div class="empty">No recurring errors yet. When the same normalized failure repeats, it will appear here.</div>`;
    return;
  }
  ui.recurringErrorsData.innerHTML = `<div class="table-wrap"><table><thead><tr><th>class</th><th>message</th><th>lang/toolchain</th><th>count</th><th>last seen</th><th>fix</th></tr></thead><tbody>
    ${rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.error_class || "-")}</td><td>${escapeHtml(r.normalized_message || "-")}</td><td>${escapeHtml(r.language || "-")} / ${escapeHtml(r.toolchain || "-")}</td><td>${r.occurrence_count || 0}</td><td>${fmtDate(r.last_seen_at)}</td><td>${r.has_verified_fix ? "verified" : "open"}</td></tr>`,
      )
      .join("")}
  </tbody></table></div>`;
}

function renderUserCorrections(data) {
  const rows = data.corrections || [];
  if (!rows.length) {
    ui.userCorrectionsData.innerHTML = `<div class="empty">No user corrections yet. When you reject an agent's fix strategy, Bugrecall can remember it here.</div>`;
    return;
  }
  ui.userCorrectionsData.innerHTML = `<div class="table-wrap"><table><thead><tr><th>type</th><th>future rule</th><th>rejected</th><th>preferred</th><th>applies_to</th><th>confidence</th><th>created</th></tr></thead><tbody>
    ${rows
      .map(
        (r) =>
          `<tr>
            <td>${escapeHtml(r.type || "-")}</td>
            <td>${escapeHtml(r.future_rule || "-")}</td>
            <td>${escapeHtml(r.rejected_pattern || "-")}</td>
            <td>${escapeHtml(r.preferred_pattern || "-")}</td>
            <td class="mono">${escapeHtml(JSON.stringify(r.applies_to || {}))}</td>
            <td>${Number(r.confidence || 0).toFixed(2)}</td>
            <td>${fmtDate(r.created_at)}</td>
          </tr>`,
      )
      .join("")}
  </tbody></table></div>`;
}

async function refreshReadOnlySections() {
  const [patch, tasks, recurring, corrections] = await Promise.all([
    fetchApi("/api/patch-history?limit=100"),
    fetchApi("/api/task-runs?limit=100"),
    fetchApi("/api/recurring-errors?limit=20&min_occurrences=2"),
    fetchApi("/api/user-corrections?limit=50"),
  ]);
  renderPatchHistory(patch);
  renderTaskRuns(tasks);
  renderRecurringErrors(recurring);
  renderUserCorrections(corrections);
}

async function withAction(button, busyLabel, fn) {
  const original = button.textContent;
  setBusy(button, true, busyLabel);
  try {
    await fn();
  } finally {
    setBusy(button, false, original);
  }
}

async function init() {
  wireTabs();
  if (window.location.protocol === "file:") {
    setStatus(false, "error");
    setBanner("error", "Dashboard must run from local server. Run: node bin/pma.js dashboard then open http://127.0.0.1:1453");
    ui.projectLine.textContent = "Direct file opening is not supported.";
    return;
  }

  ui.searchBtn.onclick = async () => {
    try {
      await withAction(ui.searchBtn, "Searching...", runSearch);
      setBanner("", "");
    } catch (e) {
      setBanner("error", String(e));
    }
  };
  ui.reloadMemories.onclick = async () => {
    try {
      await withAction(ui.reloadMemories, "Loading...", loadMemories);
    } catch (e) {
      setBanner("error", String(e));
    }
  };
  ui.vectorizeBtn.onclick = async () => {
    await withAction(ui.vectorizeBtn, "Running...", async () => {
      const out = await fetchApi("/api/vectorization/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 10 }),
      });
      ui.vectorStatus.textContent = JSON.stringify(out, null, 2);
      setBanner("success", "Vectorization completed.");
      await loadOverview();
      await loadMemories();
    });
  };
  ui.indexBtn.onclick = async () => {
    await withAction(ui.indexBtn, "Indexing...", async () => {
      const out = await fetchApi("/api/index/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 50 }),
      });
      ui.vectorStatus.textContent = JSON.stringify(out, null, 2);
      setBanner("success", "Indexing completed.");
      await loadOverview();
    });
  };

  try {
    setStatus(false, "loading");
    await loadOverview();
    await loadMemories();
    await refreshReadOnlySections();
    setBanner("", "");
  } catch (e) {
    setStatus(false, "error");
    setBanner("error", String(e));
    ui.projectLine.textContent = "Failed to load project data.";
  }
}

init();
