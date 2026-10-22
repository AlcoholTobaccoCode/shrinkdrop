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
  const authEl = document.getElementById('auth');
  const sessionEl = document.getElementById('session');
  const toolbarEl = document.getElementById('toolbar');

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
      langLabel: 'EN',
      upload: '上传文件',
      sendText: '发文字',
      logout: '退出',
      loggedIn: '已登录',
      unlockTitle: '需要 PIN',
      unlockHint: '分享者设置了访问 PIN，输入后即可访问。',
      pinPlaceholder: '6 位数字',
      loginTitle: '登录后访问',
      loginHint: '分享者要求使用账号访问。',
      username: '用户名',
      password: '密码',
      submit: '继续',
      authFailed: '口令不正确',
      authLocked: '尝试次数过多，请 10 分钟后再试',
      chooseFiles: '请先选择文件',
      uploadFailed: '上传失败，请重试',
      tooLarge: '文件超过 1GB，无法上传',
      textPlaceholder: '输入要分享的文字',
      send: '发布',
      textEmpty: '文字不能为空',
      sendFailed: '发布失败，请重试',
      noDownload: '当前账号没有下载权限，可继续上传或发布文字。',
      notOpen: '分享者还没有开放访问，请让分享者在设置里开启「允许公开访问」。',
      cancel: '取消',
      copy: '复制',
      copied: '已复制',
      textItem: '文字'
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
      langLabel: '中文',
      upload: 'Upload',
      sendText: 'Send text',
      logout: 'Sign out',
      loggedIn: 'signed in',
      unlockTitle: 'PIN required',
      unlockHint: 'The host set an access PIN.',
      pinPlaceholder: '6-digit PIN',
      loginTitle: 'Sign in',
      loginHint: 'The host requires an account.',
      username: 'Username',
      password: 'Password',
      submit: 'Continue',
      authFailed: 'Wrong credentials',
      authLocked: 'Too many attempts. Try again in 10 minutes.',
      chooseFiles: 'Choose files first',
      uploadFailed: 'Upload failed. Try again.',
      tooLarge: 'File exceeds 1 GB',
      textPlaceholder: 'Write something to share',
      send: 'Send',
      textEmpty: 'Text is empty',
      sendFailed: 'Failed to send. Try again.',
      noDownload: 'This account cannot download. You can still upload or send text.',
      notOpen: 'The host has not opened access yet. Ask them to enable “Allow public access” in Settings.',
      cancel: 'Cancel',
      copy: 'Copy',
      copied: 'Copied',
      textItem: 'Text'
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
    connected: false,
    auth: null,
    serverLang: ''
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

  function textRowFor(entry) {
    const li = document.createElement('li');
    li.className = 'row';
    const card = document.createElement('div');
    card.className = 'row-link row-link--text';
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = ICONS.text;
    const main = document.createElement('span');
    main.className = 'row-main';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.text || entry.name || '';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [t('textItem'), formatDate(entry.modified)].filter(Boolean).join(' · ');
    main.append(name, meta);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn ghost';
    copy.textContent = t('copy');
    copy.addEventListener('click', async () => {
      const value = entry.text || '';
      try {
        await navigator.clipboard.writeText(value);
        copy.textContent = t('copied');
        setTimeout(() => { copy.textContent = t('copy'); }, 1400);
      } catch (error) {
        copy.textContent = t('copy');
      }
    });
    card.append(icon, main, copy);
    li.append(card);
    return li;
  }

  function rowFor(entry, root) {
    if (entry.kind === 'text') return textRowFor(entry);
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
    connEl.hidden = false;
    connEl.textContent = state.connected ? t('live') : t('offline');
    connEl.classList.toggle('is-offline', !state.connected);
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
      text: item.text || null,
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
  let wasDisconnected = false;
  let openCount = 0;

  function connectEvents() {
    if (source) source.close();
    source = new EventSource(BASE + '/api/events');
    source.addEventListener('update', event => {
      const lang = event.data;
      if ((lang === 'zh' || lang === 'en') && state.serverLang !== lang) {
        state.serverLang = lang;
        applyServerLang(lang);
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (!state.loading) load();
      }, 250);
    });
    source.onopen = () => {
      state.connected = true;
      openCount += 1;
      renderConn();
      if (openCount > 1 || wasDisconnected) {
        wasDisconnected = false;
        void refreshConfig();
      }
    };
    source.onerror = () => {
      state.connected = false;
      wasDisconnected = true;
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

  //#region 鉴权与内容
  function hideChrome(hidden) {
    toolbarEl.hidden = hidden;
    statusEl.hidden = hidden;
    listEl.hidden = hidden;
  }

  function authMessage(status) {
    if (status === 429) return t('authLocked');
    return t('authFailed');
  }

  function postJSON(path, body) {
    return fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-share-csrf': '1' },
      body: JSON.stringify(body)
    });
  }

  function showAuth(info) {
    hideChrome(true);
    authEl.hidden = false;
    clear(authEl);
    const card = document.createElement('form');
    card.className = 'auth-card';
    const title = document.createElement('h2');
    const hint = document.createElement('p');
    const error = document.createElement('p');
    error.className = 'auth-error';
    card.append(title, hint);
    let submit;
    if (info.protection === 'pin') {
      title.textContent = t('unlockTitle');
      hint.textContent = t('unlockHint');
      const input = document.createElement('input');
      input.type = 'password';
      input.inputMode = 'numeric';
      input.maxLength = 6;
      input.placeholder = t('pinPlaceholder');
      input.autocomplete = 'one-time-code';
      card.append(input);
      submit = async () => {
        const response = await postJSON('/api/unlock', { pin: input.value.trim() });
        if (!response.ok) {
          error.textContent = authMessage(response.status);
          return;
        }
        await boot();
      };
    } else {
      title.textContent = t('loginTitle');
      hint.textContent = t('loginHint');
      const username = document.createElement('input');
      username.placeholder = t('username');
      username.autocomplete = 'username';
      const password = document.createElement('input');
      password.type = 'password';
      password.placeholder = t('password');
      password.autocomplete = 'current-password';
      card.append(username, password);
      submit = async () => {
        const response = await postJSON('/api/login', {
          username: username.value.trim(),
          password: password.value
        });
        if (!response.ok) {
          error.textContent = authMessage(response.status);
          return;
        }
        await boot();
      };
    }
    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'btn primary';
    button.textContent = t('submit');
    card.append(error, button);
    card.addEventListener('submit', event => {
      event.preventDefault();
      void submit();
    });
    authEl.append(card);
    const first = card.querySelector('input');
    if (first) first.focus();
  }

  function hideAuth() {
    authEl.hidden = true;
    clear(authEl);
    hideChrome(false);
  }

  function renderSession(info) {
    clear(sessionEl);
    const permissions = info.permissions || {};
    const actions = [];
    if (permissions.upload) actions.push([t('upload'), openUpload]);
    if (permissions.text) actions.push([t('sendText'), openText]);
    if (info.account) {
      const name = document.createElement('span');
      name.className = 'session-name';
      name.textContent = info.account + ' · ' + t('loggedIn');
      sessionEl.append(name);
      actions.push([t('logout'), logout]);
    }
    actions.forEach(([label, handler]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = label;
      button.addEventListener('click', handler);
      sessionEl.append(button);
    });
    sessionEl.hidden = actions.length === 0;
  }

  async function logout() {
    await postJSON('/api/logout', {});
    await boot();
  }

  function showClosed() {
    hideChrome(true);
    statusEl.hidden = false;
    listEl.hidden = true;
    statusEl.className = 'status';
    statusEl.textContent = t('notOpen');
  }

  function showNoDownload() {
    hideChrome(true);
    statusEl.hidden = false;
    listEl.hidden = true;
    statusEl.className = 'status';
    statusEl.textContent = t('noDownload');
  }

  function applyServerLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    state.serverLang = lang;
    if (state.lang === lang) return;
    state.lang = lang;
    applyStatic();
    renderConn();
    renderList();
  }

  async function refreshConfig() {
    const info = await getJSON(BASE + '/api/state');
    state.auth = info;
    if (!info.authenticated) {
      sessionEl.hidden = true;
      if (info.protection === 'link' && !info.public) {
        showClosed();
      } else {
        showAuth(info);
      }
      return info;
    }
    hideAuth();
    applyServerLang(info.lang);
    renderSession(info);
    if (info.permissions && info.permissions.download) {
      syncFromUrl();
    } else {
      showNoDownload();
    }
    return info;
  }

  async function boot() {
    try {
      await refreshConfig();
      connectEvents();
    } catch (error) {
      hideChrome(true);
      statusEl.hidden = false;
      statusEl.className = 'status is-error';
      statusEl.textContent = t('loadError');
    }
  }


  function openSheet(titleText) {
    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    const card = document.createElement('div');
    card.className = 'sheet';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const title = document.createElement('h2');
    title.textContent = titleText;
    const error = document.createElement('p');
    error.className = 'sheet-error';
    const actions = document.createElement('div');
    actions.className = 'sheet-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn ghost';
    cancel.textContent = t('cancel');
    cancel.addEventListener('click', () => overlay.remove());
    actions.append(cancel);
    card.append(title, error, actions);
    overlay.append(card);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) overlay.remove();
    });
    document.body.append(overlay);
    return { overlay, card, error, actions };
  }

  function openUpload() {
    const { overlay, card, error, actions } = openSheet(t('upload'));
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    const progress = document.createElement('div');
    progress.className = 'progress';
    const bar = document.createElement('span');
    progress.append(bar);
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn primary';
    submit.textContent = t('upload');
    card.insertBefore(input, error);
    card.insertBefore(progress, actions);
    actions.append(submit);
    submit.addEventListener('click', () => {
      const files = Array.from(input.files || []);
      if (!files.length) {
        error.textContent = t('chooseFiles');
        return;
      }
      const form = new FormData();
      files.forEach(file => form.append('file', file, file.name));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', BASE + '/api/upload');
      xhr.setRequestHeader('x-share-csrf', '1');
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) bar.style.width = Math.round((event.loaded / event.total) * 100) + '%';
      };
      xhr.onload = () => {
        if (xhr.status === 200) {
          overlay.remove();
          load();
          return;
        }
        error.textContent = xhr.status === 413
          ? t('tooLarge')
          : xhr.status === 401 || xhr.status === 403
            ? t('authFailed')
            : t('uploadFailed');
        submit.disabled = false;
      };
      xhr.onerror = () => {
        error.textContent = t('uploadFailed');
        submit.disabled = false;
      };
      submit.disabled = true;
      xhr.send(form);
    });
  }

  function openText() {
    const { overlay, card, error, actions } = openSheet(t('sendText'));
    const textarea = document.createElement('textarea');
    textarea.placeholder = t('textPlaceholder');
    textarea.maxLength = 10000;
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn primary';
    submit.textContent = t('send');
    card.insertBefore(textarea, error);
    actions.append(submit);
    submit.addEventListener('click', async () => {
      const value = textarea.value.trim();
      if (!value) {
        error.textContent = t('textEmpty');
        return;
      }
      submit.disabled = true;
      const response = await postJSON('/api/text', { text: value });
      if (response.ok) {
        overlay.remove();
        load();
        return;
      }
      submit.disabled = false;
      error.textContent = response.status === 401 || response.status === 403
        ? t('authFailed')
        : t('sendFailed');
    });
  }
  //#endregion

  applyStatic();
  boot();
  //#endregion
})();
