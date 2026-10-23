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
      footer: '由 shrinkdrop 分享 · 文件只在你的设备与这台电脑之间传输',
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
      textItem: '文字',
      preview: '预览',
      collapse: '收起',
      openImage: '查看大图',
      imagePreview: '图片预览',
      closePreview: '关闭预览',
      audioPreview: '音频',
      videoPreview: '视频',
      previewLoading: '正在加载预览…',
      previewError: '预览加载失败，请重试',
      previewUnsupported: '当前浏览器不支持此文件的编码',
      retryPreview: '重新加载',
      downloadFile: '下载文件',
      previewUnavailable: '暂不预览',
      copyFull: '复制全文',
      copySource: '复制源码',
      markdownPreview: '预览',
      markdownSource: '源码',
      back15: '后退 15 秒',
      forward15: '前进 15 秒',
      play: '播放',
      pause: '暂停',
      mute: '静音',
      unmute: '取消静音',
      rate: '倍率',
      imageHint: '等比完整显示 · 点击查看大图',
      textLimit: '长文本可在框内滚动',
      prev: '上一张',
      next: '下一张',
      zoom: '原图尺寸',
      fit: '适配窗口',
      previewTooLarge: '文件超过 512 KB，请下载后查看'
    },
    en: {
      tagline: 'LAN sharing',
      footer: 'Shared by shrinkdrop · Files travel only between your device and this computer',
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
      textItem: 'Text',
      preview: 'Preview',
      collapse: 'Collapse',
      openImage: 'View large',
      imagePreview: 'Image preview',
      closePreview: 'Close preview',
      audioPreview: 'Audio',
      videoPreview: 'Video',
      previewLoading: 'Loading preview…',
      previewError: 'Preview failed to load. Try again.',
      previewUnsupported: 'This browser cannot play this encoding',
      retryPreview: 'Reload',
      downloadFile: 'Download file',
      previewUnavailable: 'No preview',
      copyFull: 'Copy all',
      copySource: 'Copy source',
      markdownPreview: 'Preview',
      markdownSource: 'Source',
      back15: 'Back 15 seconds',
      forward15: 'Forward 15 seconds',
      play: 'Play',
      pause: 'Pause',
      mute: 'Mute',
      unmute: 'Unmute',
      rate: 'Speed',
      imageHint: 'Full image, scaled to fit · tap for large view',
      textLimit: 'Long text scrolls inside the box',
      prev: 'Previous',
      next: 'Next',
      zoom: 'Actual size',
      fit: 'Fit to window',
      previewTooLarge: 'File exceeds 512 KB. Download it to view.'
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

  // 同一列表只展开一项；媒体在收起、切换目录或刷新时暂停并记住位置。
  const preview = {
    openKey: '',
    media: {},
    markdownMode: 'preview',
    fullImage: null
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
    chevron: svg('<path d="M9 6l6 6-6 6"/>'),
    rotateBack: svg('<path d="M4 11a8 8 0 1 1 2.3 6.7"/><path d="M4 5v6h6"/>'),
    rotateForward: svg('<path d="M20 11a8 8 0 1 0-2.3 6.7"/><path d="M20 5v6h-6"/>'),
    play: svg('<path d="M8 5l11 7-11 7z"/>'),
    pause: svg('<path d="M8 5v14M16 5v14"/>'),
    volume: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9a4 4 0 0 1 0 6"/>'),
    volumeOff: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l4 6M21 9l-4 6"/>')
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

  function previewUrl(id, path) {
    let url = BASE + '/api/preview?id=' + encodeURIComponent(id);
    if (path) url += '&path=' + encodeURIComponent(path);
    return url;
  }

  function entryKey(entry, root) {
    return (root ? 'root' : 'dir:' + state.itemId) + ':' + (entry.path || '') + ':' + entry.name;
  }

  function extensionOf(name) {
    const dot = (name || '').lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function previewKind(entry) {
    if (entry.kind === 'text') return 'text';
    if (entry.kind === 'dir') return '';
    const ext = extensionOf(entry.name);
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    if (entry.preview) {
      if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'image';
      if (['mp3', 'wav', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
      if (['mp4', 'm4v', 'webm', 'mov', 'mkv'].includes(ext)) return 'video';
      if (ext === 'txt') return 'textfile';
    }
    return '';
  }

  // 代码类预览：只在这些扩展名上启用，服务端同样按白名单返回 text/plain。
  const CODE_EXTENSIONS = new Set([
    'html', 'htm', 'css', 'scss', 'less',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonl',
    'py', 'java', 'kt', 'go', 'rs', 'rb', 'php',
    'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift',
    'sh', 'bash', 'zsh', 'sql', 'yml', 'yaml', 'toml', 'xml', 'ini',
    'vue', 'svelte'
  ]);

  const CODE_LANG = {
    html: 'xml', htm: 'xml', xml: 'xml', vue: 'xml', svelte: 'xml',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', jsonl: 'json',
    py: 'python', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', rb: 'ruby',
    php: 'php', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    swift: 'swift', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    css: 'css', scss: 'scss', less: 'less'
  };

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
    li.className = 'row row--expandable';
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

    const key = entryKey(entry, true);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn ghost';
    toggle.textContent = preview.openKey === key ? t('collapse') : t('preview');
    toggle.setAttribute('aria-expanded', String(preview.openKey === key));
    toggle.addEventListener('click', () => {
      preview.openKey = preview.openKey === key ? '' : key;
      renderList();
    });
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
    card.append(icon, main, toggle, copy);
    li.append(card);

    if (preview.openKey === key) {
      const panel = document.createElement('div');
      panel.className = 'preview';
      panel.id = 'preview-' + encodeURIComponent(key);
      const body = document.createElement('div');
      body.className = 'preview-text';
      body.tabIndex = 0;
      body.textContent = entry.text || '';
      panel.append(body);
      li.append(panel);
    }
    return li;
  }

  function rowFor(entry, root) {
    if (entry.kind === 'text') return textRowFor(entry);
    const li = document.createElement('li');
    const kind = previewKind(entry);
    li.className = 'row' + (entry.kind === 'dir' ? ' row--dir' : '');
    if (kind) li.className += ' row--expandable';

    const link = document.createElement(entry.kind === 'dir' ? 'button' : 'a');
    link.className = 'row-link';
    if (entry.kind === 'dir') {
      link.type = 'button';
      link.addEventListener('click', () => {
        navigate(root ? entry.id : state.itemId, root ? '' : entry.path);
      });
    } else if (kind) {
      // 有预览的类型：标题区域展开预览，下载仍由右侧按钮负责。
      link.type = 'button';
      link.setAttribute('aria-expanded', String(preview.openKey === entryKey(entry, root)));
      link.addEventListener('click', () => {
        const key = entryKey(entry, root);
        preview.openKey = preview.openKey === key ? '' : key;
        renderList();
      });
    } else {
      link.href = downloadUrl(root ? entry.id : state.itemId, root ? '' : entry.path);
      link.setAttribute('download', entry.name || '');
    }

    const icon = document.createElement('span');
    icon.className = 'icon';
    if ((entry.thumb || kind === 'image') && entry.kind === 'file') {
      const img = document.createElement('img');
      img.src = thumbUrl(root ? entry.id : state.itemId, root ? '' : entry.path);
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
    if (kind) {
      action.innerHTML = ICONS.chevron;
      action.classList.add('action--chevron');
    } else {
      action.innerHTML = entry.kind === 'dir' ? ICONS.chevron : ICONS.download;
    }

    link.append(icon, main, action);
    li.append(link);

    if (kind) {
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'btn ghost row-download';
      download.innerHTML = ICONS.download;
      download.setAttribute('aria-label', t('download') + ' ' + (entry.name || ''));
      download.addEventListener('click', () => {
        const anchor = document.createElement('a');
        anchor.href = downloadUrl(root ? entry.id : state.itemId, root ? '' : entry.path);
        anchor.setAttribute('download', entry.name || '');
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      });
      li.append(download);
    } else if (entry.kind === 'file') {
      // 不支持预览的文件明确标注，避免用户误以为点击无反应。
      const badge = document.createElement('span');
      badge.className = 'preview-unavailable';
      badge.textContent = t('previewUnavailable');
      link.insertBefore(badge, action);
    }

    if (preview.openKey === entryKey(entry, root) && kind) {
      li.append(previewPanel(entry, root, kind));
    }
    return li;
  }

  /** 条目展开后的预览容器；只在这里按需加载媒体。 */
  function previewPanel(entry, root, kind) {
    const id = root ? entry.id : state.itemId;
    const path = root ? '' : entry.path;
    const key = entryKey(entry, root);
    const panel = document.createElement('div');
    panel.className = 'preview';
    panel.id = 'preview-' + encodeURIComponent(key);

    if (kind === 'text' || kind === 'textfile') {
      const body = document.createElement('div');
      body.className = 'preview-text';
      body.tabIndex = 0;
      if (kind === 'text') {
        body.textContent = entry.text || '';
      } else {
        body.textContent = t('previewLoading');
        void fetch(previewUrl(id, path), { cache: 'no-store' })
          .then(response => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.text();
          })
          .then(text => { if (body.isConnected) body.textContent = text; })
          .catch(() => { if (body.isConnected) panel.replaceChildren(previewError(entry, id, path)); });
      }
      panel.append(body);
      return panel;
    }
    if (kind === 'markdown') {
      return markdownPanel(entry, id, path, panel);
    }
    if (kind === 'code') {
      return codePanel(entry, id, path, panel);
    }
    if (kind === 'image') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preview-image';
      button.setAttribute('aria-label', t('openImage') + ' ' + (entry.name || ''));
      const img = document.createElement('img');
      img.src = previewUrl(id, path);
      img.alt = entry.name || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => button.replaceWith(previewError(entry, id, path)));
      button.append(img);
      const hint = document.createElement('span');
      hint.className = 'preview-hint';
      hint.textContent = t('imageHint');
      button.append(hint);
      button.addEventListener('click', () => openFullImage(entry, id, path));
      const caption = document.createElement('p');
      caption.className = 'preview-caption';
      caption.textContent = t('imageHint');
      panel.append(button, caption);
      return panel;
    }
    if (kind === 'audio') {
      return audioPanel(entry, id, path, panel);
    }
    if (kind === 'video') {
      const video = document.createElement('video');
      video.className = 'preview-video';
      video.src = previewUrl(id, path);
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.setAttribute('aria-label', t('videoPreview') + ' ' + (entry.name || ''));
      video.addEventListener('error', () => panel.replaceChildren(previewError(entry, id, path)));
      panel.append(video);
      return panel;
    }
    return panel;
  }

  function previewError(entry, id, path, reason) {
    const box = document.createElement('div');
    box.className = 'preview-error';
    box.setAttribute('role', 'status');
    const message = document.createElement('span');
    message.textContent = reason || t('previewUnsupported');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn ghost';
    retry.textContent = t('retryPreview');
    retry.addEventListener('click', () => {
      const fresh = box.cloneNode(false);
      fresh.textContent = t('previewLoading');
      box.replaceWith(fresh);
      renderList();
    });
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'btn ghost';
    download.textContent = t('downloadFile');
    download.addEventListener('click', () => {
      const anchor = document.createElement('a');
      anchor.href = downloadUrl(id, path);
      anchor.setAttribute('download', entry.name || '');
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    });
    box.append(message, retry, download);
    return box;
  }

  function audioPanel(entry, id, path, panel) {
    const key = preview.openKey;
    const saved = preview.media[key] || { time: 0, rate: 1, volume: 0.8 };
    const box = document.createElement('div');
    box.className = 'preview-audio';
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = previewUrl(id, path);
    audio.volume = saved.volume;
    audio.playbackRate = saved.rate;

    const seek = document.createElement('input');
    seek.type = 'range';
    seek.className = 'preview-range';
    seek.min = '0';
    seek.max = '1';
    seek.step = '0.1';
    seek.value = '0';
    seek.setAttribute('aria-label', t('audioPreview') + ' ' + (entry.name || ''));
    const timeRow = document.createElement('div');
    timeRow.className = 'preview-time-row';
    const currentLabel = document.createElement('span');
    currentLabel.textContent = '00:00';
    const durationLabel = document.createElement('span');
    durationLabel.textContent = '--:--';
    timeRow.append(currentLabel, durationLabel);

    const controls = document.createElement('div');
    controls.className = 'preview-controls';
    const back = iconButton(ICONS.rotateBack, t('back15'));
    const play = iconButton(ICONS.play, t('play'));
    play.classList.add('preview-play');
    const forward = iconButton(ICONS.rotateForward, t('forward15'));
    const rate = document.createElement('button');
    rate.type = 'button';
    rate.className = 'preview-rate';
    rate.textContent = saved.rate + '×';
    rate.setAttribute('aria-label', t('rate') + ' ' + saved.rate + '×');
    const mute = iconButton(ICONS.volume, t('mute'));
    controls.append(back, play, forward, rate, mute);

    const formatTime = seconds => {
      if (!Number.isFinite(seconds)) return '--:--';
      const total = Math.floor(seconds);
      return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
    };
    const sync = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      seek.max = String(duration || 1);
      seek.value = String(audio.currentTime);
      seek.style.setProperty('--value', (duration ? audio.currentTime / duration * 100 : 0) + '%');
      currentLabel.textContent = formatTime(audio.currentTime);
      durationLabel.textContent = formatTime(duration);
    };

    audio.addEventListener('loadedmetadata', () => {
      if (saved.time) audio.currentTime = Math.min(saved.time, audio.duration || 0);
      sync();
    });
    audio.addEventListener('timeupdate', sync);
    audio.addEventListener('play', () => setPlayIcon(play, true));
    audio.addEventListener('pause', () => setPlayIcon(play, false));
    audio.addEventListener('error', () => panel.replaceChildren(previewError(entry, id, path)));
    play.addEventListener('click', () => {
      if (audio.paused) void audio.play().catch(() => {});
      else audio.pause();
    });
    back.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); sync(); });
    forward.addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15); sync(); });
    seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); sync(); });
    rate.addEventListener('click', () => {
      const rates = [1, 1.5, 2, 2.5, 3];
      const next = rates[(rates.indexOf(audio.playbackRate) + 1) % rates.length];
      audio.playbackRate = next;
      rate.textContent = next + '×';
      rate.setAttribute('aria-label', t('rate') + ' ' + next + '×');
      preview.media[key] = {
        time: audio.currentTime,
        rate: next,
        volume: audio.volume
      };
    });
    mute.addEventListener('click', () => {
      audio.muted = !audio.muted;
      mute.innerHTML = audio.muted ? ICONS.volumeOff : ICONS.volume;
      mute.setAttribute('aria-label', audio.muted ? t('unmute') : t('mute'));
    });

    panel.addEventListener('preview-hide', () => {
      preview.media[key] = {
        time: audio.currentTime,
        rate: audio.playbackRate,
        volume: audio.volume
      };
      audio.pause();
    }, { once: true });

    box.append(audio, seek, timeRow, controls);
    panel.append(box);
    return panel;
  }

  function setPlayIcon(button, playing) {
    button.innerHTML = playing ? ICONS.pause : ICONS.play;
    button.setAttribute('aria-label', playing ? t('pause') : t('play'));
  }

  function iconButton(icon, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preview-icon-button';
    button.innerHTML = icon;
    button.setAttribute('aria-label', label);
    return button;
  }

  function markdownPanel(entry, id, path, panel) {
    const toolbar = document.createElement('div');
    toolbar.className = 'preview-markdown-bar';
    const modes = document.createElement('div');
    modes.className = 'preview-modes';
    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.textContent = t('markdownPreview');
    const sourceButton = document.createElement('button');
    sourceButton.type = 'button';
    sourceButton.textContent = t('markdownSource');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn ghost';
    copy.textContent = t('copySource');
    modes.append(previewButton, sourceButton);
    toolbar.append(modes, copy);

    const body = document.createElement('div');
    body.className = 'preview-markdown';
    let text = entry.text || '';
    const apply = mode => {
      preview.markdownMode = mode;
      previewButton.setAttribute('aria-pressed', String(mode === 'preview'));
      sourceButton.setAttribute('aria-pressed', String(mode === 'source'));
      body.className = 'preview-markdown' + (mode === 'source' ? ' preview-markdown--source' : '');
      if (mode === 'source' || !text) {
        body.textContent = text;
        return;
      }
      body.innerHTML = renderMarkdown(text);
    };
    previewButton.addEventListener('click', () => apply('preview'));
    sourceButton.addEventListener('click', () => apply('source'));
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(text).catch(() => {});
    });
    panel.append(toolbar, body);
    apply(preview.markdownMode);

    // 分享的 .md 文件没有内联文本，按需读取同一预览路由，避免整目录预取。
    if (!text) {
      body.textContent = t('previewLoading');
      void fetch(previewUrl(id, path), { cache: 'no-store' })
        .then(response => {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.text();
        })
        .then(value => {
          text = value;
          if (body.isConnected) apply(preview.markdownMode);
        })
        .catch(() => {
          if (body.isConnected) panel.replaceChildren(previewError(entry, id, path));
        });
    }
    return panel;
  }

  function renderMarkdown(text) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return '';
    const clean = DOMPurify.sanitize(marked.parse(text, { gfm: true }), {
      FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'object', 'embed'],
      FORBID_ATTR: ['style', 'onerror', 'onclick']
    });
    const holder = document.createElement('div');
    holder.innerHTML = clean;
    // 分享范围外的相对图片不能读取；保留占位提示，避免静默空白。
    holder.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (!/^(https?:|data:image\/)/i.test(src)) {
        const note = document.createElement('span');
        note.className = 'preview-image-note';
        note.textContent = '[图片：' + (img.getAttribute('alt') || '需从分享列表下载') + ']';
        img.replaceWith(note);
      }
    });
    holder.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#)/i.test(href)) link.removeAttribute('href');
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });
    if (typeof hljs !== 'undefined') {
      holder.querySelectorAll('pre code').forEach(block => {
        try {
          hljs.highlightElement(block);
        } catch (error) {
          // 高亮失败时保留纯文本。
        }
      });
    }
    return holder.innerHTML;
  }

  function codePanel(entry, id, path, panel) {
    const lang = CODE_LANG[extensionOf(entry.name)] || 'plaintext';
    const bar = document.createElement('div');
    bar.className = 'preview-code-bar';
    const label = document.createElement('span');
    label.className = 'preview-code-lang';
    label.textContent = lang;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn ghost';
    copy.textContent = t('copyFull');
    bar.append(label, copy);

    const pre = document.createElement('pre');
    pre.className = 'preview-code';
    const code = document.createElement('code');
    code.className = 'hljs';
    pre.append(code);
    panel.append(bar, pre);

    const apply = text => {
      code.textContent = text;
      if (typeof hljs !== 'undefined') {
        code.removeAttribute('data-highlighted');
        try {
          hljs.highlightElement(code);
        } catch (error) {
          // 高亮失败时保留纯文本，不影响阅读。
        }
      }
    };
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(code.textContent || '').catch(() => {});
    });

    code.textContent = t('previewLoading');
    void fetch(previewUrl(id, path), { cache: 'no-store' })
      .then(response => {
        if (response.status === 413) throw new Error('too-large');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      })
      .then(text => { if (code.isConnected) apply(text); })
      .catch(error => {
        if (!code.isConnected) return;
        const reason = error && error.message === 'too-large'
          ? t('previewTooLarge')
          : t('previewError');
        panel.replaceChildren(previewError(entry, id, path, reason));
      });
    return panel;
  }

  function openFullImage(entry, id, path) {
    const dialog = document.createElement('dialog');
    dialog.className = 'preview-full';
    const header = document.createElement('div');
    header.className = 'preview-full-head';
    const title = document.createElement('strong');
    title.textContent = entry.name || t('imagePreview');
    const actions = document.createElement('div');
    actions.className = 'preview-full-actions';
    const sizeButton = document.createElement('button');
    sizeButton.type = 'button';
    sizeButton.className = 'btn ghost';
    sizeButton.textContent = t('zoom');
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'btn ghost';
    closeButton.textContent = t('closePreview');
    actions.append(sizeButton, closeButton);
    header.append(title, actions);
    const stage = document.createElement('div');
    stage.className = 'preview-full-stage';
    const img = document.createElement('img');
    img.src = previewUrl(id, path);
    img.alt = entry.name || '';
    stage.append(img);
    dialog.append(header, stage);
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    sizeButton.addEventListener('click', () => {
      stage.classList.toggle('is-actual');
      sizeButton.textContent = stage.classList.contains('is-actual') ? t('fit') : t('zoom');
    });
    document.body.append(dialog);
    preview.fullImage = dialog;
    dialog.showModal();
  }

  function hideOpenPreview() {
    if (!preview.openKey) return;
    const panel = document.getElementById('preview-' + encodeURIComponent(preview.openKey));
    if (panel) panel.dispatchEvent(new Event('preview-hide'));
    preview.openKey = '';
  }

  function renderList() {
    // 首次加载才显示骨架；后续刷新保留现有行，避免销毁播放器。
    if (state.loading && !listEl.querySelector('.row')) {
      clear(listEl);
      for (let index = 0; index < 3; index += 1) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton';
        listEl.append(skeleton);
      }
      return;
    }
    if (state.error) { clear(listEl); return; }

    const entries = currentEntries();
    if (!entries.length) {
      if (state.loading) return;
      clear(listEl);
      const empty = document.createElement('div');
      empty.className = 'empty';
      if (state.query.trim()) empty.textContent = t('noMatch');
      else empty.textContent = state.view === 'root' ? t('emptyRoot') : t('emptyDir');
      listEl.append(empty);
      return;
    }

    const root = state.view === 'root';
    const existing = new Map();
    Array.from(listEl.children).forEach(child => {
      if (child.dataset.key) existing.set(child.dataset.key, child);
      else child.remove();
    });

    const wanted = new Set();
    const ordered = [];
    entries.forEach(entry => {
      const key = entryKey(entry, root);
      wanted.add(key);
      const current = existing.get(key);
      const playing = current && Array.from(current.querySelectorAll('audio, video'))
        .some(media => !media.paused && !media.ended);
      const reusable = current && (playing || !needsPreviewRebuild(current, entry, key));
      const node = reusable ? current : rowFor(entry, root);
      node.dataset.key = key;
      ordered.push({ node, playing: Boolean(playing) });
    });

    existing.forEach((node, key) => {
      if (wanted.has(key)) return;
      Array.from(node.querySelectorAll('audio, video')).forEach(media => media.pause());
      node.remove();
    });

    const keep = new Set(ordered.map(item => item.node));
    Array.from(listEl.children).forEach(child => {
      if (!keep.has(child)) child.remove();
    });

    // 只在没有媒体播放时重排，避免移动节点打断播放；新行追加到末尾。
    const anyPlaying = ordered.some(item => item.playing);
    ordered.forEach(item => {
      if (!item.node.isConnected) listEl.append(item.node);
    });
    if (!anyPlaying) {
      ordered.forEach(item => listEl.append(item.node));
    }
  }

  /** 行内容未变（名称、大小、时间、展开状态）时可原样复用，保留播放器实例。 */
  function needsPreviewRebuild(node, entry, key) {
    const link = node.querySelector('.row-link');
    if (!link) return true;
    if (link.getAttribute('aria-expanded') !== String(preview.openKey === key)) return true;
    const name = node.querySelector('.name');
    return !name || name.textContent !== (entry.text || entry.name || '');
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

  /** 刷新后条目仍存在时保留展开项；否则收起，避免指向已删除内容。 */
  function pruneOpenPreview() {
    if (!preview.openKey) return;
    const stillThere = state.entries.some(entry => {
      const root = state.view === 'root';
      return entryKey(entry, root) === preview.openKey;
    });
    if (!stillThere) hideOpenPreview();
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
      thumb: item.kind === 'file' && /\.(png|jpe?g|webp)$/i.test(item.name || ''),
      preview: Boolean(item.preview)
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
      pruneOpenPreview();
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
    hideOpenPreview();
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
