const emptyProject = { html: '', css: '', js: '' };
const storageKey = 'coding-el-fardy-project-v3';
const editor = ace.edit('code-editor');
const frame = document.getElementById('preview-frame');
const frameShell = document.getElementById('browser-frame');
const consoleOutput = document.getElementById('console-output');
const consoleCount = document.getElementById('console-count');
const saveStatus = document.getElementById('save-status');

editor.setTheme('ace/theme/tomorrow_night');
editor.setOptions({
  fontSize: '13px',
  tabSize: 2,
  useSoftTabs: true,
  showPrintMargin: false,
  highlightActiveLine: true,
  enableBasicAutocompletion: true,
  enableLiveAutocompletion: true,
  enableSnippets: true
});
editor.session.setUseWorker(false);
editor.renderer.setPadding(16);
editor.renderer.setScrollMargin(10, 10, 0, 0);

let activeFile = 'html';
let project = loadProject();
let debounceTimer;
let toastTimer;
let messageCount = 0;
let importedAssetUrls = new Map();
let importedEntryPaths = { html: '', css: '', js: '' };

function loadProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    const validProject = saved && ['html', 'css', 'js'].every((key) => typeof saved[key] === 'string');
    if (validProject) return saved;
  } catch (error) {
    console.warn('تعذر تحميل النسخة المحفوظة.', error);
  }
  return { ...emptyProject };
}

function setEditorMode(file) {
  const mode = file === 'js' ? 'javascript' : file;
  editor.session.setMode(`ace/mode/${mode}`);
}

function normalizeRelativePath(path) {
  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    decodedPath = path;
  }

  const parts = decodedPath.replace(/\\/g, '/').split('/');
  const normalized = [];
  parts.forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  });
  return normalized.join('/');
}

function getFolderPath(file) {
  const relativePath = file.webkitRelativePath || file.name;
  const firstSlash = relativePath.indexOf('/');
  return normalizeRelativePath(firstSlash < 0 ? relativePath : relativePath.slice(firstSlash + 1));
}

function resolveFolderPath(reference, basePath) {
  const trimmed = reference.trim();
  if (!trimmed || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(trimmed)) return null;

  const cleanReference = trimmed.split(/[?#]/, 1)[0];
  const baseDirectory = trimmed.startsWith('/') ? '' : basePath.split('/').slice(0, -1).join('/');
  return normalizeRelativePath(`${baseDirectory}/${cleanReference}`);
}

function resolveFolderAsset(reference, basePath) {
  const path = resolveFolderPath(reference, basePath);
  if (path === null) return reference;

  const objectUrl = importedAssetUrls.get(path.toLowerCase());
  if (!objectUrl) return reference;

  const suffix = reference.match(/[?#].*$/)?.[0] || '';
  return `${objectUrl}${suffix}`;
}

function clearImportedFolder() {
  importedAssetUrls.clear();
  importedEntryPaths = { html: '', css: '', js: '' };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function readTagAttribute(tag, attribute) {
  return tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] || '';
}

function rewriteFolderHtml(html) {
  if (!importedEntryPaths.html) return html;

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const relation = readTagAttribute(tag, 'rel').toLowerCase();
    const href = readTagAttribute(tag, 'href');
    if (relation.split(/\s+/).includes('stylesheet') &&
        resolveFolderPath(href, importedEntryPaths.html) === importedEntryPaths.css) {
      return '';
    }
    return tag;
  });

  html = html.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>\s*<\/script\s*>/gi, (tag, quote, source) => {
    if (resolveFolderPath(source, importedEntryPaths.html) === importedEntryPaths.js) return '';
    return tag;
  });

  return html.replace(/\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi, (attribute, name, quote, value) => {
    return `${name}=${quote}${resolveFolderAsset(value, importedEntryPaths.html)}${quote}`;
  });
}

function rewriteFolderCss(css) {
  if (!importedEntryPaths.css) return css;
  return css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, value) => {
    return `url("${resolveFolderAsset(value, importedEntryPaths.css)}")`;
  });
}

async function importFolder(fileList) {
  const entries = Array.from(fileList).map((file) => ({ file, path: getFolderPath(file) }));
  const codeEntries = entries.filter(({ path }) => /\.(?:html?|css|js)$/i.test(path));
  const htmlEntries = codeEntries.filter(({ path }) => /\.html?$/i.test(path));
  if (!htmlEntries.length) {
    showToast('المجلد لازم يحتوي على ملف HTML.');
    return;
  }

  const byPath = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry]));
  const htmlEntry = htmlEntries.sort((left, right) => {
    const leftIndex = /(^|\/)index\.html?$/i.test(left.path) ? 0 : 1;
    const rightIndex = /(^|\/)index\.html?$/i.test(right.path) ? 0 : 1;
    return leftIndex - rightIndex || left.path.split('/').length - right.path.split('/').length;
  })[0];
  const htmlText = await htmlEntry.file.text();

  const linkedCss = [...htmlText.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => readTagAttribute(match[0], 'href'))
    .map((href) => byPath.get(resolveFolderPath(href, htmlEntry.path)?.toLowerCase()))
    .find((entry) => entry && /\.css$/i.test(entry.path));
  const cssEntries = codeEntries.filter(({ path }) => /\.css$/i.test(path));
  const cssEntry = linkedCss || cssEntries.find(({ path }) => /(^|\/)(?:style|styles|main)\.css$/i.test(path)) || cssEntries[0];

  const linkedJs = [...htmlText.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)]
    .map((match) => byPath.get(resolveFolderPath(match[2], htmlEntry.path)?.toLowerCase()))
    .find((entry) => entry && /\.js$/i.test(entry.path));
  const jsEntries = codeEntries.filter(({ path }) => /\.js$/i.test(path));
  const jsEntry = linkedJs || jsEntries.find(({ path }) => /(^|\/)(?:script|main|app)\.js$/i.test(path)) || jsEntries[0];

  clearImportedFolder();
  importedEntryPaths = {
    html: htmlEntry.path,
    css: cssEntry?.path || '',
    js: jsEntry?.path || ''
  };

  const ignoredDirectory = /(^|\/)(?:node_modules|\.git|\.next|dist|build)(\/|$)/i;
  const assetEntries = entries.filter(({ file, path }) =>
    !/\.html?$/i.test(path) && !ignoredDirectory.test(path) && file.size <= 25 * 1024 * 1024
  );
  await Promise.all(assetEntries.map(async ({ file, path }) => {
    importedAssetUrls.set(path.toLowerCase(), await readFileAsDataUrl(file));
  }));

  project.html = htmlText;
  project.css = cssEntry ? await cssEntry.file.text() : '';
  project.js = jsEntry ? await jsEntry.file.text() : '';
  activeFile = 'html';
  setEditorMode(activeFile);
  editor.setValue(project.html, -1);

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    const selected = tab.dataset.tab === activeFile;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.file-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.file === activeFile);
  });
  document.getElementById('language-label').textContent = 'HTML';

  renderPreview();
  showToast(`اتفتح المجلد وفيه ${codeEntries.length} ملف كود`);
}

function updateCursorPosition() {
  const position = editor.getCursorPosition();
  document.getElementById('cursor-position').textContent = `سطر ${position.row + 1}، عمود ${position.column + 1}`;
}

function selectFile(file) {
  if (file === activeFile) return;
  clearTimeout(debounceTimer);
  project[activeFile] = editor.getValue();
  activeFile = file;
  setEditorMode(file);
  editor.setValue(project[file], -1);

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    const selected = tab.dataset.tab === file;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-selected', String(selected));
  });

  document.querySelectorAll('.file-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.file === file);
  });

  document.getElementById('language-label').textContent = file === 'js' ? 'JAVASCRIPT' : file.toUpperCase();
  editor.focus();
}

function saveProject() {
  project[activeFile] = editor.getValue();

  try {
    localStorage.setItem(storageKey, JSON.stringify(project));
    saveStatus.textContent = 'تم الحفظ';
    saveStatus.classList.remove('saving');
  } catch (error) {
    saveStatus.textContent = 'تعذر الحفظ';
    showToast('مساحة التخزين في المتصفح ممتلئة.');
  }
}

function addConsoleMessage(level, values) {
  if (consoleOutput.querySelector('.console-empty')) {
    consoleOutput.innerHTML = '';
  }

  const row = document.createElement('div');
  const kind = level === 'error' || level === 'warn' ? level : '';
  row.className = `console-line ${kind}`;
  row.textContent = values.join(' ');
  consoleOutput.appendChild(row);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
  messageCount += 1;
  consoleCount.textContent = messageCount;
}

function buildPreviewDocument() {
  project[activeFile] = editor.getValue();

  const safeCss = rewriteFolderCss(project.css).replace(/<\/style/gi, '<\\/style');
  const safeScript = project.js.replace(/<\/script/gi, '<\\/script');
  const bridge = `<script>
    ['log', 'info', 'warn', 'error'].forEach((level) => {
      const original = console[level].bind(console);
      console[level] = (...values) => {
        original(...values);
        parent.postMessage({
          source: 'coding-el-fardy',
          level,
          values: values.map((value) => {
            try { return typeof value === 'object' ? JSON.stringify(value) : String(value); }
            catch { return String(value); }
          })
        }, '*');
      };
    });
    window.addEventListener('error', (event) => parent.postMessage({
      source: 'coding-el-fardy',
      level: 'error',
      values: [event.message]
    }, '*'));
  <\/script>`;
  const styles = `<style>${safeCss}</style>`;
  const scripts = `${bridge}<script>${safeScript}<\/script>`;
  let html = rewriteFolderHtml(project.html);

  if (/<html[\s>]/i.test(html)) {
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${styles}</head>`);
    } else {
      html = html.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${styles}</head>`);
    }

    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${scripts}</body>`);
    } else {
      html += scripts;
    }
  } else {
    html = `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      ${styles}</head><body>${html}${scripts}</body></html>`;
  }

  return html;
}

function renderPreview() {
  frame.srcdoc = buildPreviewDocument();
  saveProject();
}

function openResultTab() {
  const resultTab = window.open('about:blank', '_blank');
  if (!resultTab) {
    showToast('اسمح بفتح النوافذ المنبثقة لتشغيل النتيجة في تبويب جديد.');
    return false;
  }

  resultTab.document.open();
  resultTab.document.write(buildPreviewDocument());
  resultTab.document.close();
  return true;
}

function schedulePreview() {
  project[activeFile] = editor.getValue();
  saveStatus.textContent = 'جارٍ الحفظ...';
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(renderPreview, 650);
  updateCursorPosition();
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2200);
}

document.querySelectorAll('[data-tab], .file-row').forEach((button) => {
  button.addEventListener('click', () => selectFile(button.dataset.tab || button.dataset.file));
});

editor.selection.on('changeCursor', updateCursorPosition);
document.getElementById('run-button').addEventListener('click', () => {
  clearTimeout(debounceTimer);
  consoleOutput.innerHTML = '';
  messageCount = 0;
  consoleCount.textContent = '0';
  const resultOpened = openResultTab();
  renderPreview();
  if (resultOpened) showToast('تم تشغيل الكود في تبويب جديد');
});

document.getElementById('refresh-button').addEventListener('click', () => {
  document.getElementById('run-button').click();
});

document.getElementById('clear-button').addEventListener('click', () => {
  if (!editor.getValue()) return;
  editor.setValue('');
  editor.focus();
});

document.getElementById('new-project-button').addEventListener('click', () => {
  clearImportedFolder();
  project = { ...emptyProject };
  localStorage.removeItem(storageKey);
  activeFile = 'html';
  setEditorMode(activeFile);
  editor.setValue('', -1);

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    const selected = tab.dataset.tab === activeFile;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-selected', String(selected));
  });

  document.querySelectorAll('.file-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.file === activeFile);
  });

  document.getElementById('language-label').textContent = 'HTML';
  consoleOutput.innerHTML = '<div class="console-empty">رسائل وأخطاء الكود هتظهر هنا.</div>';
  messageCount = 0;
  consoleCount.textContent = '0';
  frame.srcdoc = '';
  saveProject();
  showToast('بدأنا مشروعًا فارغًا');
});

document.getElementById('open-file-button').addEventListener('click', () => {
  document.getElementById('file-picker').click();
});

document.getElementById('file-picker').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  const extension = file.name.split('.').pop().toLowerCase();
  const fileType = extension === 'css' ? 'css' : extension === 'js' ? 'js' : ['html', 'htm'].includes(extension) ? 'html' : null;
  if (!fileType) {
    showToast('افتح ملف HTML أو CSS أو JavaScript.');
    event.target.value = '';
    return;
  }

  clearImportedFolder();
  project[fileType] = await file.text();
  if (activeFile !== fileType) selectFile(fileType);
  editor.setValue(project[fileType], -1);
  saveProject();
  renderPreview();
  showToast(`تم فتح ${file.name}`);
  event.target.value = '';
});

document.getElementById('open-folder-button').addEventListener('click', () => {
  document.getElementById('folder-picker').click();
});

document.getElementById('folder-picker').addEventListener('change', async (event) => {
  if (event.target.files?.length) await importFolder(event.target.files);
  event.target.value = '';
});

document.getElementById('add-file-button').addEventListener('click', () => {
  showToast('الملفات المتاحة: HTML وCSS وJavaScript');
});

document.getElementById('console-toggle').addEventListener('click', (event) => {
  const panel = document.querySelector('.console-panel');
  const collapsed = panel.classList.toggle('collapsed');
  event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
});

document.getElementById('console-clear').addEventListener('click', (event) => {
  event.stopPropagation();
  consoleOutput.innerHTML = '<div class="console-empty">رسائل وأخطاء الكود هتظهر هنا.</div>';
  messageCount = 0;
  consoleCount.textContent = '0';
});

document.querySelectorAll('[data-device]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-device]').forEach((deviceButton) => {
      deviceButton.classList.toggle('selected', deviceButton === button);
    });

    frameShell.classList.remove('device-tablet', 'device-mobile');
    if (button.dataset.device !== 'desktop') {
      frameShell.classList.add(`device-${button.dataset.device}`);
    }
  });
});

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.data?.source !== 'coding-el-fardy') return;
  addConsoleMessage(event.data.level, event.data.values || []);
});

setEditorMode(activeFile);
editor.setValue(project.html, -1);
renderPreview();
editor.session.on('change', schedulePreview);
