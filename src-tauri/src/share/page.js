(function () {
  const meta = document.querySelector('meta[name="share-base"]');
  const base = meta ? meta.content : '';
  const list = document.getElementById('files');

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
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

  function render(files) {
    if (!Array.isArray(files) || files.length === 0) {
      list.innerHTML = '<li class="empty">分享者还没有添加文件</li>';
      return;
    }
    const nodes = files.map(function (file) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'file-link';
      link.href = file.url;
      link.setAttribute('download', file.name);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = file.name;

      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatSize(file.size);

      link.append(name, size);
      item.append(link);
      return item;
    });
    list.replaceChildren.apply(list, nodes);
  }

  function fail(message) {
    list.innerHTML = '';
    const item = document.createElement('li');
    item.className = 'empty';
    item.textContent = message;
    list.append(item);
  }

  fetch(base + '/api/files', {
    headers: { accept: 'application/json' },
    cache: 'no-store'
  })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(render)
    .catch(function () {
      fail('加载失败，请刷新页面重试');
    });
})();
