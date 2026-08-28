const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'anydoc-rag-history-v1';
const MAX_HISTORY = 12;
const MAX_STORED_RESULT_CHARS = 350000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const state = {
  jobs: [],
  selectedJobId: null,
  view: 'rag',
  running: false,
  history: loadHistory(),
  runtime: null,
};

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileExtension(name) {
  const value = name.split('.').pop();
  return value && value !== name ? value.slice(0, 5) : 'FILE';
}

function loadHistory() {
  try {
    const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, MAX_HISTORY)));
  } catch {
    state.history = state.history.map(({ result, ...item }) => item);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch { /* storage unavailable */ }
  }
}

function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`.trim();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function addFiles(files) {
  const incoming = Array.from(files || []);
  if (!incoming.length) return;
  const accepted = incoming.filter((file) => file.size <= MAX_FILE_BYTES);
  for (const file of accepted) {
    state.jobs.push({ id: uid(), file, status: 'ready', result: null, error: null });
  }
  renderQueue();
  updateControls();
  const rejected = incoming.length - accepted.length;
  toast(rejected ? `${rejected} 个文件超过 50 MB，未加入队列` : `已添加 ${accepted.length} 个文档`, rejected ? 'error' : '');
}

function renderQueue() {
  const list = $('queueList');
  if (!state.jobs.length) {
    list.innerHTML = '<div class="empty-queue"><span>□</span><p>添加文档后会在这里显示处理进度</p></div>';
  } else {
    list.innerHTML = state.jobs.map((job) => {
      const labels = { ready: '等待中', processing: '转换中', done: '已完成', error: '失败' };
      return `<button type="button" class="queue-item ${state.selectedJobId === job.id ? 'selected' : ''}" data-job-id="${job.id}">
        <span class="file-type">${escapeHtml(fileExtension(job.file.name))}</span>
        <span class="queue-copy"><span class="queue-name">${escapeHtml(job.file.name)}</span><span class="queue-meta">${formatBytes(job.file.size)}</span></span>
        <span class="job-status ${job.status}">${labels[job.status]}</span>
      </button>`;
    }).join('');
  }

  list.querySelectorAll('[data-job-id]').forEach((button) => {
    button.addEventListener('click', () => selectJob(button.dataset.jobId));
  });

  const done = state.jobs.filter((job) => job.status === 'done').length;
  const failed = state.jobs.filter((job) => job.status === 'error').length;
  $('queueSummary').textContent = state.running ? `处理中 · ${done}/${state.jobs.length}` : failed ? `${done} 完成 · ${failed} 失败` : state.jobs.length ? `${state.jobs.length} 个文档` : '等待添加文档';
  $('taskCount').textContent = state.jobs.length;
}

function updateControls() {
  const pending = state.jobs.filter((job) => job.status === 'ready' || job.status === 'error').length;
  $('runBtn').disabled = state.running || pending === 0;
  $('runBtnText').textContent = state.running ? '正在转换' : '开始转换';
  $('selectedCount').textContent = pending;
  $('clearCompletedBtn').disabled = !state.jobs.some((job) => job.status === 'done');
  $('historyCount').textContent = state.history.length;
}

function currentResult() {
  return state.jobs.find((job) => job.id === state.selectedJobId)?.result || null;
}

function selectJob(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  state.selectedJobId = id;
  renderQueue();
  if (job.result) renderResult(job.result);
  else if (job.error) renderError(job);
  else renderEmpty(job.status === 'processing' ? '正在解析文档' : '该任务尚未开始', job.status === 'processing' ? '解析完成后结果会自动显示。' : '点击“开始转换”处理队列中的文档。');
}

function renderEmpty(title = '尚无解析结果', text = '选择一个或多个文档开始转换，完成后可在任务队列中切换查看。') {
  $('resultContent').hidden = true;
  $('resultEmpty').hidden = false;
  $('resultEmpty').innerHTML = `<span class="empty-glyph">{ }</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>`;
  $('copyBtn').disabled = true;
  $('downloadBtn').disabled = true;
}

function renderError(job) {
  $('resultContent').hidden = true;
  $('resultEmpty').hidden = false;
  $('resultEmpty').innerHTML = `<span class="empty-glyph">!</span><h3>转换失败</h3><p>${escapeHtml(humanizeError(job.error))}</p>`;
  $('copyBtn').disabled = true;
  $('downloadBtn').disabled = true;
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`;
}

function renderResult(result) {
  $('resultEmpty').hidden = true;
  $('resultContent').hidden = false;
  const chunks = result.rag?.metadata?.chunk_count ?? '—';
  $('summary').innerHTML = [
    metric('文件', result.file_name),
    metric('格式', (result.format || 'unknown').toUpperCase()),
    metric('大小', formatBytes(result.size_bytes)),
    metric('分块', String(chunks)),
  ].join('');
  $('copyBtn').disabled = false;
  $('downloadBtn').disabled = false;
  renderOutput();
}

function currentOutput() {
  const result = currentResult();
  if (!result) return '';
  return state.view === 'markdown' ? result.markdown || '' : JSON.stringify(result.rag || result, null, 2);
}

function renderOutput() {
  $('output').textContent = currentOutput();
}

function setView(view) {
  state.view = view;
  $('markdownTab').classList.toggle('active', view === 'markdown');
  $('ragTab').classList.toggle('active', view === 'rag');
  renderOutput();
}

async function loadRuntime() {
  try {
    const response = await fetch('/api/runtime');
    if (!response.ok) throw new Error('runtime unavailable');
    const data = await response.json();
    state.runtime = data;
    const localReady = Boolean(data.ocr.local_command);
    const paddleReady = Boolean(data.ocr.paddleocr_command);
    configureOcrOption('local', localReady, localReady ? '本地命令' : '本地命令（未配置）');
    configureOcrOption('paddleocr', paddleReady, paddleReady ? 'PaddleOCR' : 'PaddleOCR（未配置）');
    $('runtime').innerHTML = `<span class="status-dot"></span><span>解析服务在线 · v${escapeHtml(data.version)}</span>`;
    const capability = $('ocrCapability');
    capability.textContent = localReady || paddleReady ? '可用' : '未配置';
    capability.classList.toggle('ready', localReady || paddleReady);
  } catch {
    $('runtime').innerHTML = '<span class="status-dot error"></span><span>解析服务不可用</span>';
    $('ocrCapability').textContent = '不可用';
  }
}

function configureOcrOption(value, enabled, label) {
  const option = Array.from($('ocr').options).find((item) => item.value === value);
  if (!option) return;
  option.disabled = !enabled;
  option.textContent = label;
}

async function submitForm(event) {
  event.preventDefault();
  if (state.running) return;
  const jobs = state.jobs.filter((job) => job.status === 'ready' || job.status === 'error');
  if (!jobs.length) return;
  if (!validateSettings()) return;

  state.running = true;
  updateControls();
  for (const job of jobs) {
    job.status = 'processing';
    job.error = null;
    state.selectedJobId = job.id;
    renderQueue();
    renderEmpty('正在解析文档', `${job.file.name} 正在处理中…`);
    try {
      job.result = await convertFile(job.file);
      job.status = 'done';
      addHistory(job.result);
      renderResult(job.result);
    } catch (error) {
      job.status = 'error';
      job.error = error;
      renderError(job);
    }
    renderQueue();
    updateControls();
  }
  state.running = false;
  updateControls();
  renderQueue();
  const failed = jobs.filter((job) => job.status === 'error').length;
  toast(failed ? `批量任务完成，${failed} 个失败` : `${jobs.length} 个文档转换完成`, failed ? 'error' : '');
}

function validateSettings() {
  const maxChars = Number($('maxChars').value);
  const overlap = Number($('overlap').value);
  if (!Number.isInteger(maxChars) || maxChars < 200) {
    toast('分块字符数不能小于 200', 'error');
    return false;
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxChars) {
    toast('重叠字符数必须小于分块字符数', 'error');
    return false;
  }
  return true;
}

async function convertFile(file) {
  const form = new FormData();
  form.append('file', file);
  form.append('mode', $('mode').value);
  form.append('ocr', $('ocr').value);
  form.append('max_chars', $('maxChars').value);
  form.append('overlap', $('overlap').value);
  const response = await fetch('/api/convert', { method: 'POST', body: form });
  let data;
  try { data = await response.json(); } catch { data = { error: `服务返回了无效响应（HTTP ${response.status}）` }; }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || '转换失败');
    error.code = data.code;
    throw error;
  }
  return data;
}

function humanizeError(error) {
  const messages = {
    needsOcr: '文档包含扫描页，需要启用已配置的本地 OCR 后重试。',
    noExtractableText: '文档中没有可提取的文本，可能只有图片、图形或空表格。',
    ocrUnavailable: '所选 OCR 能力尚未在服务端配置。',
    ocrFailed: '本地 OCR 命令执行失败，请检查命令配置和输出。',
    payloadTooLarge: '文件超过 50 MB，请压缩或拆分后重试。',
    badRequest: '请求参数无效，请检查分块设置或文件内容。',
  };
  return messages[error?.code] || error?.message || '未知错误';
}

function addHistory(result) {
  const serialized = JSON.stringify(result);
  const item = {
    id: uid(), fileName: result.file_name, size: result.size_bytes, format: result.format,
    mode: result.mode, createdAt: new Date().toISOString(),
    result: serialized.length <= MAX_STORED_RESULT_CHARS ? result : null,
  };
  state.history = [item, ...state.history.filter((old) => old.fileName !== item.fileName)].slice(0, MAX_HISTORY);
  saveHistory();
  renderHistory();
  updateControls();
}

function renderHistory() {
  const list = $('historyList');
  if (!state.history.length) {
    list.innerHTML = '<div class="history-empty">暂无转换记录</div>';
    return;
  }
  list.innerHTML = state.history.map((item) => `<button type="button" class="history-item" data-history-id="${item.id}">
    <span class="history-name">${escapeHtml(item.fileName)}</span>
    <span class="history-cell">${escapeHtml((item.format || 'unknown').toUpperCase())}</span>
    <span class="history-cell">${formatBytes(item.size)}</span>
    <span class="history-cell">${formatTime(item.createdAt)}</span>
  </button>`).join('');
  list.querySelectorAll('[data-history-id]').forEach((button) => {
    button.addEventListener('click', () => openHistory(button.dataset.historyId));
  });
}

function openHistory(id) {
  const item = state.history.find((entry) => entry.id === id);
  if (!item?.result) {
    toast('该记录过大，仅保留了转换信息', 'error');
    return;
  }
  const job = { id: uid(), file: { name: item.fileName, size: item.size }, status: 'done', result: item.result, error: null };
  state.jobs.unshift(job);
  state.selectedJobId = job.id;
  switchSection('tasks');
  renderQueue();
  renderResult(job.result);
  updateControls();
}

function formatTime(value) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function downloadCurrent() {
  const text = currentOutput();
  if (!text) return;
  const result = currentResult();
  const ext = state.view === 'markdown' ? 'md' : 'json';
  const blob = new Blob([text], { type: ext === 'md' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${(result?.file_name || 'document').replace(/\.[^.]*$/, '')}.${ext}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function copyCurrent() {
  const text = currentOutput();
  if (!text) return;
  try {
    if (typeof window.asteam?.rpc === 'function') {
      await window.asteam.rpc('clipboard.writeText', { text });
    } else {
      await navigator.clipboard.writeText(text);
    }
    toast('结果已复制');
  } catch {
    toast('复制失败，请使用下载功能', 'error');
  }
}

function switchSection(section) {
  const history = section === 'history';
  $('tasksSection').hidden = history;
  $('historySection').hidden = !history;
  $('clearCompletedBtn').hidden = history;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.section === section));
  document.querySelector('.page-heading h1').textContent = history ? '最近记录' : '转换任务';
  document.querySelector('.page-heading > div > p:last-child').textContent = history ? '在当前浏览器中快速找回近期转换结果。' : '批量提取文档内容，生成 Markdown 或可直接入库的 RAG JSON。';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function wireEvents() {
  const zone = $('dropzone');
  const fileInput = $('file');
  zone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (event) => { event.preventDefault(); zone.classList.remove('dragover'); addFiles(event.dataTransfer?.files); });
  $('convertForm').addEventListener('submit', submitForm);
  $('markdownTab').addEventListener('click', () => setView('markdown'));
  $('ragTab').addEventListener('click', () => setView('rag'));
  $('copyBtn').addEventListener('click', copyCurrent);
  $('downloadBtn').addEventListener('click', downloadCurrent);
  $('clearCompletedBtn').addEventListener('click', () => {
    state.jobs = state.jobs.filter((job) => job.status !== 'done');
    if (!state.jobs.some((job) => job.id === state.selectedJobId)) { state.selectedJobId = null; renderEmpty(); }
    renderQueue(); updateControls();
  });
  $('clearHistoryBtn').addEventListener('click', () => { state.history = []; saveHistory(); renderHistory(); updateControls(); toast('最近记录已清空'); });
  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => switchSection(item.dataset.section)));
}

wireEvents();
renderQueue();
renderHistory();
updateControls();
loadRuntime();
