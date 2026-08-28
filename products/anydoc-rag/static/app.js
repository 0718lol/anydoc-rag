const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  view: 'rag',
  result: null,
};

function setStatus(text) {
  $('status').textContent = text;
}

function fileLabel(file) {
  if (!file) return '选择或拖入文档';
  const size = `${Math.max(1, Math.round(file.size / 1024))} KB`;
  return `${file.name} · ${size}`;
}

function summarize(result) {
  const items = [];
  items.push(`<span class="pill"><strong>${escapeHtml(result.file_name)}</strong></span>`);
  items.push(`<span class="pill">format <strong>${escapeHtml(result.format || 'unknown')}</strong></span>`);
  items.push(`<span class="pill">bytes <strong>${result.size_bytes.toLocaleString()}</strong></span>`);
  items.push(`<span class="pill">mode <strong>${escapeHtml(result.mode)}</strong></span>`);
  if (result.rag) {
    items.push(`<span class="pill">chunks <strong>${result.rag.metadata.chunk_count}</strong></span>`);
    items.push(`<span class="pill">assets <strong>${result.rag.metadata.asset_count}</strong></span>`);
  }
  $('summary').innerHTML = items.join('');
}

function currentOutput() {
  if (!state.result) return '';
  if (state.view === 'markdown') return state.result.markdown || '';
  return JSON.stringify(state.result.rag || state.result, null, 2);
}

function renderOutput() {
  $('output').textContent = currentOutput() || '没有结果。';
}

function setView(view) {
  state.view = view;
  $('markdownTab').classList.toggle('active', view === 'markdown');
  $('ragTab').classList.toggle('active', view === 'rag');
  renderOutput();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function loadRuntime() {
  try {
    const res = await fetch('/api/runtime');
    const data = await res.json();
    $('runtime').textContent = `${data.product} ${data.version} · hosted ${data.ocr.hosted ? 'on' : 'off'} · local ${data.ocr.local_command ? 'on' : 'off'} · paddle ${data.ocr.paddleocr_command ? 'on' : 'off'}`;
  } catch {
    $('runtime').textContent = '运行状态不可用';
  }
}

async function submitForm(event) {
  event.preventDefault();
  if (!state.file) {
    setStatus('先选一个文件');
    return;
  }

  const form = new FormData();
  form.append('file', state.file);
  form.append('mode', $('mode').value);
  form.append('ocr', $('ocr').value);
  form.append('max_chars', $('maxChars').value);
  form.append('overlap', $('overlap').value);

  $('runBtn').disabled = true;
  setStatus('转换中');

  try {
    const res = await fetch('/api/convert', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'convert failed');
    }
    state.result = data;
    summarize(data);
    setView($('mode').value);
    setStatus('完成');
  } catch (error) {
    $('output').textContent = `错误: ${error.message || error}`;
    $('summary').innerHTML = '';
    setStatus('失败');
  } finally {
    $('runBtn').disabled = false;
  }
}

function attachFile(file) {
  state.file = file || null;
  $('fileLabel').textContent = fileLabel(file);
  $('fileHint').textContent = file ? '已装入' : 'docx, pdf, pptx, xlsx, epub, csv';
  $('sourceMeta').textContent = file ? `已选择 ${file.name}` : '未选择文件';
  if (file) {
    setStatus('文件已准备好');
  }
}

function downloadCurrent() {
  const text = currentOutput();
  const ext = state.view === 'markdown' ? 'md' : 'json';
  const blob = new Blob([text], { type: ext === 'md' ? 'text/markdown' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.file?.name || 'document').replace(/\.[^.]*$/, '')}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyCurrent() {
  const text = currentOutput();
  await navigator.clipboard.writeText(text);
  setStatus('已复制');
}

function wireDropzone() {
  const zone = $('dropzone');
  const fileInput = $('file');
  zone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => attachFile(fileInput.files?.[0]));
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragover');
    attachFile(event.dataTransfer?.files?.[0]);
  });
}

function wireTabs() {
  $('markdownTab').addEventListener('click', () => setView('markdown'));
  $('ragTab').addEventListener('click', () => setView('rag'));
  $('copyBtn').addEventListener('click', copyCurrent);
  $('downloadBtn').addEventListener('click', downloadCurrent);
}

function wireReset() {
  $('resetBtn').addEventListener('click', () => {
    state.file = null;
    state.result = null;
    $('file').value = '';
    $('summary').innerHTML = '';
    $('output').textContent = '上传文件后，结果会显示在这里。';
    attachFile(null);
    setStatus('等待输入');
  });
}

loadRuntime();
wireDropzone();
wireTabs();
wireReset();
$('convertForm').addEventListener('submit', submitForm);
attachFile(null);

