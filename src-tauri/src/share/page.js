(function () {
  'use strict';

  const meta = document.querySelector('meta[name="share-base"]');
  const BASE = meta ? meta.content : '';
  const listEl = document.getElementById('list');
  const statusEl = document.getElementById('status');
  const crumbsEl = document.getElementById('crumbs');
  const searchEl = document.getElementById('search');
  const langBtn = document.getElementById('lang');
  const connEl = document.getElementById('conn');
  const downloadDirEl = document.getElementById('downloadDir');

  //#region 文案
  const DICT = {
    zh: {
      tagline: '局域网分享',
      footer: '由 TinyPNG Lite 分享 · 文件只在你的设备与这台电脑之间传输',
      subtitle: '同一局域网内，点击文件即可下载',
      search: '搜索当前文件夹',
      shared: '共享内容',
      folder: '文件夹',
      file: '文件',
      download: '下载',
      downloadFolder: '下载文件夹',
      loading: '正在加载…',
      emptyRoot: '分享者还没有添加内容',
      emptyDir: '这个文件夹是空的',
      noMatch: '没有匹配的文件',
      loadError: '加载失败，请检查网络后重试',
      retry: '重试',
      live: '实时更新',
      offline: '连接中断，正在重连',
      count: count => `${count} 项`,
      langLabel: 'EN'
    },
    en: {
      tagline: 'LAN sharing',
      footer: 'Shared by TinyPNG Lite · Files travel only between your device and this computer',
      subtitle: 'Same network — tap a file to download',
      search: 'Search this folder',
      shared: 'Shared',
      folder: 'Folder',
      file: 'File',
      download: 'Download',
      downloadFolder: 'Download folder',
      loading: 'Loading…',
      emptyRoot: 'Nothing has been shared yet',
      emptyDir: 'This folder is empty',
      noMatch: 'No matching files',
      loadError: 'Failed to load. Check the network and try again.',
      retry: 'Retry',
      live: 'Live',
      offline: 'Reconnecting…',
      count: count => `${count} item${count === 1 ? '' : 's'}`,
      langLabel: '中文'
    }
  };

  function initialLang() {
    const saved = localStorage.getItem('share:lang');
    if (saved === 'zh' || saved === 'en') return saved;
    const browser = (navigator.language || 'en').toLowerCase();
    return browser.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  const state = {
    lang: initialLang(),
    view: 'root',
    itemId: null,
    path: '',
    rootName: '',
    segments: [],
    entries: [],
    query: '',
    loading: true,
    error: '',
    connected: false
  };

  let loadSerial = 0;
  let refreshTimer = null;

  function t(key) {
    const value = DICT[state.lang][key];
    return typeof value === 'function' ? value.apply(null, Array.prototype.slice.call(arguments, 1)) : value;
  }
  //#endregion

  //#region 图标
  const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const ICONS = {
    folder: svg('<path d="M3 7V5h6l2 2h10v12H3z"/>'),
    file: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
    image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/>'),
    video: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>'),
    audio: svg('<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>'),
    pdf: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16h4"/>'),
    archive: svg('<path d="M4 4h16v16H4z"/><path d="M12 4v4M12 10v4M12 16v2"/>'),
    doc: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h5"/>'),
    sheet: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M10 4v16"/>'),
    slides: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M12 17v3M8 20h8"/>'),
    code: svg('<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>'),
    text: svg('<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>'),
    download: svg('<path d="M12 4v10M8 10l4 4 4-4M5 19h14"/>'),
    chevron: svg('<path d="M9 6l6 6-6 6"/>')
  };

  const EXT_KIND = {
    png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image', avif: 'image', heic: 'image',
    mp4: 'video', mov: 'video', mkv: 'video', webm: 'video',
    mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio',
    pdf: 'pdf',
    zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
    doc: 'doc', docx: 'doc', pages: 'doc',
    txt: 'text', md: 'text', log: 'text',
    csv: 'sheet', xls: 'sheet', xlsx: 'sheet', numbers: 'sheet',
    ppt: 'slides', pptx: 'slides', key: 'slides',
    js: 'code', ts: 'code', jsx: 'code', tsx: 'code', json: 'code', html: 'code', css: 'code', py: 'code', rs: 'code', go: 'code', sh: 'code'
  };

  function iconFor(entry) {
    if (entry.kind === 'dir') return ICONS.folder;
    const name = entry.name || '';
    const ext = name.indexOf('.') >= 0 ? name.split('.').pop().toLowerCase() : '';
    return ICONS[EXT_KIND[ext] || 'file'] || ICONS.file;
  }
  //#endregion

  //#region 工具
  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(digits) + ' ' + units[unit];
  }

  function formatDate(seconds) {
    if (!seconds) return '';
    try {
      return new Date(seconds * 1000).toLocaleDateString(state.lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'short',
        day: 'numeric'
      });
    } catch (error) {
      return '';
    }
  }

  function joinPath(base, name) {
    return base ? base + '/' + name : name;
  }

  function downloadUrl(id, path) {
    let url = BASE + '/api/download?id=' + encodeURIComponent(id);
    if (path) url += '&path=' + encodeURIComponent(path);
    return url;
  }

  function thumbUrl(id, path) {
    return BASE + '/api/thumb?id=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(path);
  }

  async function getJSON(url) {
    const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }
  //#endregion

  //#region 渲染
  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function currentEntries() {
    const query = state.query.trim().toLowerCase();
    if (!query) return state.entries;
    return state.entries.filter(entry => (entry.name || '').toLowerCase().indexOf(query) >= 0);
  }

  function renderStatus() {
    clear(statusEl);
    statusEl.className = 'status';
    if (state.loading) {
      statusEl.textContent = t('loading');
      return;
    }
    if (state.error) {
      statusEl.classList.add('is-error');
      statusEl.append(document.createTextNode(state.error));
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = t('retry');
      retry.addEventListener('click', () => load());
      statusEl.append(retry);
      return;
    }
    statusEl.textContent = t('count', currentEntries().length);
  }

  function rowFor(entry, root) {
    const li = document.createElement('li');
    li.className = 'row' + (entry.kind === 'dir' ? ' row--dir' : '');

    const link = document.createElement(entry.kind === 'dir' ? 'button' : 'a');
    link.className = 'row-link';
    if (entry.kind === 'dir') {
      link.type = 'button';
      link.addEventListener('click', () => {
        navigate(root ? entry.id : state.itemId, root ? '' : entry.path);
      });
    } else {
      link.href = downloadUrl(root ? entry.id : state.itemId, root ? '' : entry.path);
      link.setAttribute('download', entry.name || '');
    }

    const icon = document.createElement('span');
    icon.className = 'icon';
    if (entry.thumb && !root) {
      const img = document.createElement('img');
      img.src = thumbUrl(state.itemId, entry.path);
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        icon.textContent = '';
        icon.innerHTML = iconFor(entry);
      });
      icon.append(img);
    } else {
      icon.innerHTML = iconFor(entry);
    }

    const main = document.createElement('span');
    main.className = 'row-main';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name || '';
    name.title = entry.name || '';
    const meta = document.createElement('span');
    meta.className = 'meta';
    if (entry.kind === 'dir') {
      meta.textContent = [t('folder'), formatDate(entry.modified)].filter(Boolean).join(' · ');
    } else {
      meta.textContent = [formatSize(entry.size), formatDate(entry.modified)].filter(Boolean).join(' · ');
    }
    main.append(name, meta);

    const action = document.createElement('span');
    action.className = 'action';
    action.innerHTML = entry.kind === 'dir' ? ICONS.chevron : ICONS.download;

    link.append(icon, main, action);
    li.append(link);
    return li;
  }

  function renderList() {
    clear(listEl);
    if (state.loading) {
      for (let index = 0; index < 3; index += 1) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton';
        listEl.append(skeleton);
      }
      return;
    }
    if (state.error) return;

    const entries = currentEntries();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      if (state.query.trim()) empty.textContent = t('noMatch');
      else empty.textContent = state.view === 'root' ? t('emptyRoot') : t('emptyDir');
      listEl.append(empty);
      return;
    }
    entries.forEach(entry => listEl.append(rowFor(entry, state.view === 'root')));
  }

  function crumbButton(label, onClick, current) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crumb';
    button.textContent = label;
    button.title = label;
    if (current) button.setAttribute('aria-current', 'page');
    else button.addEventListener('click', onClick);
    return button;
  }

  function renderCrumbs() {
    clear(crumbsEl);
    downloadDirEl.hidden = true;
    if (state.view === 'root') {
      crumbsEl.append(crumbButton(t('shared'), () => {}, true));
      return;
    }
    crumbsEl.append(crumbButton(t('shared'), () => navigate(null, ''), false));
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    crumbsEl.append(sep);
    crumbsEl.append(crumbButton(state.rootName || t('shared'), () => navigate(state.itemId, ''), state.segments.length === 0));
    state.segments.forEach((segment, index) => {
      const separator = document.createElement('span');
      separator.className = 'crumb-sep';
      separator.textContent = '/';
      crumbsEl.append(separator);
      const path = state.segments.slice(0, index + 1).join('/');
      const current = index === state.segments.length - 1;
      crumbsEl.append(crumbButton(segment, () => navigate(state.itemId, path), current));
    });

    downloadDirEl.hidden = false;
    downloadDirEl.href = downloadUrl(state.itemId, state.path);
    downloadDirEl.setAttribute('download', '');
    downloadDirEl.innerHTML = ICONS.download + '<span>' + t('downloadFolder') + '</span>';
  }

  function renderConn() {
    connEl.hidden = !state.connected;
    connEl.textContent = state.connected ? t('live') : t('offline');
  }

  function renderAll() {
    renderStatus();
    renderList();
    renderCrumbs();
    renderConn();
  }
  //#endregion

  //#region 数据与导航
  function rootEntry(item) {
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      size: item.size,
      modified: item.modified,
      path: '',
      thumb: false
    };
  }

  async function load() {
    const serial = ++loadSerial;
    state.loading = true;
    state.error = '';
    renderStatus();
    renderList();
    try {
      if (state.view === 'root') {
        const items = await getJSON(BASE + '/api/items');
        if (serial !== loadSerial) return;
        state.entries = items.map(rootEntry);
      } else {
        const url = BASE + '/api/list?id=' + encodeURIComponent(state.itemId) + '&path=' + encodeURIComponent(state.path);
        const data = await getJSON(url);
        if (serial !== loadSerial) return;
        state.rootName = data.name;
        state.segments = data.path || [];
        state.entries = data.entries || [];
      }
      state.loading = false;
      renderAll();
    } catch (error) {
      if (serial !== loadSerial) return;
      state.loading = false;
      state.error = t('loadError');
      state.entries = [];
      renderAll();
    }
  }

  function syncFromUrl() {
    const params = new URLSearchParams(location.search);
    const id = Number(params.get('id'));
    state.query = '';
    searchEl.value = '';
    if (Number.isFinite(id) && id > 0) {
      state.view = 'dir';
      state.itemId = id;
      state.path = params.get('path') || '';
    } else {
      state.view = 'root';
      state.itemId = null;
      state.path = '';
    }
    load();
  }

  function navigate(id, path) {
    const params = new URLSearchParams();
    if (id) {
      params.set('id', String(id));
      if (path) params.set('path', path);
      history.pushState({}, '', location.pathname + '?' + params.toString());
    } else {
      history.pushState({}, '', location.pathname);
    }
    syncFromUrl();
  }
  //#endregion

  //#region 语言与事件
  function applyStatic() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
      element.textContent = t(element.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
      element.setAttribute('placeholder', t(element.getAttribute('data-i18n-placeholder')));
    });
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
    document.title = 'File Share · ' + t('tagline');
    langBtn.textContent = t('langLabel');
  }

  function setLang(lang) {
    state.lang = lang;
    localStorage.setItem('share:lang', lang);
    applyStatic();
    renderAll();
  }

  let source = null;

  function connectEvents() {
    if (source) source.close();
    source = new EventSource(BASE + '/api/events');
    source.addEventListener('update', () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (!state.loading) load();
      }, 250);
    });
    source.onopen = () => {
      state.connected = true;
      renderConn();
    };
    source.onerror = () => {
      state.connected = false;
      renderConn();
    };
  }

  searchEl.addEventListener('input', () => {
    state.query = searchEl.value;
    renderStatus();
    renderList();
  });

  langBtn.addEventListener('click', () => setLang(state.lang === 'zh' ? 'en' : 'zh'));

  window.addEventListener('popstate', syncFromUrl);

  applyStatic();
  syncFromUrl();
  connectEvents();
  //#endregion
})();
