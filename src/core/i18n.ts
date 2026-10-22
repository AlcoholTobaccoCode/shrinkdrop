import { reactive } from 'vue';

export type Lang = 'zh' | 'en';
export type LanguageSetting = 'auto' | 'zh' | 'en';

/**
 * 以中文原文为 key 的轻量词典：模板里直接 t('压缩')，避免维护两套 key。
 * 带占位符的文案用 {name}，由第二个参数替换。
 */
const en: Record<string, string> = {
  '压缩': 'Compress',
  '分享': 'Share',
  '上传自动压缩': 'Auto-compress',
  '开启后，添加图片就会自动上传压缩': 'New images upload and compress automatically',
  '关闭时，添加后需手动开始压缩': 'Turn off to start compression manually',
  '添加图片': 'Add images',
  '添加文件夹': 'Add folder',
  '正在准备': 'Preparing',
  '选择文件': 'Choose files',
  '添加文件': 'Add files',
  '正在停止': 'Stopping',
  '停止分享': 'Stop sharing',
  '设置': 'Settings',
  '当前为浏览器预览。压缩和保存图片请使用桌面版。': 'Browser preview. Use the desktop app to compress and save.',
  '关闭提示': 'Dismiss',
  '图片列表': 'Image list',
  '松手即可添加': 'Drop to add',
  '拖入图片或文件夹': 'Drop images or folders',
  '拖入图片，或点击添加': 'Drop images, or click to add',
  'PNG、JPEG、WebP · 单张不超过 20 MB': 'PNG, JPEG, WebP · up to 20 MB each',
  '自动压缩已开启，添加后立即上传处理': 'Auto-compress is on; new images upload immediately',
  '添加后，点击「开始压缩」': 'Add images, then click Start',
  '拖入更多图片或文件夹': 'Drop more images or folders',
  '单张 ≤ 20 MB': 'Up to 20 MB each',
  '图片': 'Images',
  '原始大小': 'Original',
  '压缩后': 'Compressed',
  '变化': 'Change',
  '操作': 'Actions',
  '原始': 'Original',
  '取消': 'Cancel',
  '重试': 'Retry',
  '保存': 'Save',
  '保存中': 'Saving',
  '重试保存': 'Retry save',
  '覆盖': 'Overwrite',
  '已覆盖': 'Overwritten',
  '重试覆盖': 'Retry overwrite',
  '覆盖中': 'Overwriting',
  '移除': 'Remove',
  '图片会上传至 TinyPNG 进行压缩；除非手动覆盖，原图不会被修改。':
    'Images are uploaded to TinyPNG. Originals are untouched unless you overwrite them.',
  '{n} 张图片': '{n} images',
  '{n} 张完成': '{n} done',
  '{n} 张进行中': '{n} in progress',
  '{n} 张失败': '{n} failed',
  '{n} 张取消': '{n} canceled',
  '准备好了，点击开始压缩': 'Ready — click Start',
  '添加图片后自动上传压缩': 'New images upload automatically',
  '添加图片，开始轻装': 'Add images to get started',
  '清空': 'Clear',
  '正在清空': 'Clearing',
  '保存全部': 'Save all',
  '批量覆盖': 'Overwrite all',
  '开始压缩': 'Start',
  '正在压缩': 'Compressing',
  '大小不变': 'No change',
  '共减少 {size}': 'Saved {size}',
  '共增加 {size}': 'Added {size}',
  '当前为浏览器预览。局域网分享需要桌面版。': 'Browser preview. LAN sharing requires the desktop app.',
  '正在分享': 'Sharing',
  '分享未开始': 'Not sharing',
  '已分享 {n} 项，手机扫码即可下载': '{n} items shared — scan to download',
  '手机与电脑连同一个 Wi-Fi，选择文件或文件夹后扫码下载':
    'Same Wi-Fi: choose files and scan to download',
  '端口 {port}': 'Port {port}',
  '分享链接': 'Share link',
  '已复制': 'Copied',
  '复制链接': 'Copy link',
  '分享二维码': 'Share QR code',
  '二维码生成失败，请用链接访问': 'QR failed — use the link',
  '正在生成二维码…': 'Generating QR…',
  '已分享内容': 'Shared items',
  '文件夹': 'Folder',
  '文字': 'Text',
  '列表已清空，点右上角「添加文件」继续。': 'List cleared. Use “Add files” to continue.',
  '正在准备分享链接': 'Preparing link',
  '选择内容，立即开始分享': 'Choose items to start sharing',
  '桌面版才能开启分享': 'Desktop app required',
  '文件或文件夹 · 单次最多 200 项': 'Files or folders · up to 200 items',
  '链接只在分享期间有效，停止后立即失效': 'Links expire when sharing stops',
  '文件只在同一局域网内传输；停止分享后链接立即失效。':
    'Files stay on your LAN; links expire when sharing stops.',
  '{n} 项': '{n} items',
  '同一 Wi-Fi 下可访问 · 停止后链接失效': 'Reachable on the same Wi-Fi · expires on stop',
  '选择内容后自动生成链接与二维码': 'Link and QR appear once you choose items',
  'TinyPNG Lite · 图片压缩': 'TinyPNG Lite · Image Compression',
  'File Share · 局域网分享': 'File Share · LAN Share',
  '关闭设置': 'Close settings',
  '设置分组': 'Settings sections',
  '通用': 'General',
  '关于': 'About',
  '启动时显示': 'Open on launch',
  '上次使用': 'Last used',
  '跟随系统': 'Follow system',
  '访客页会立即切换语言；桌面端双语界面正在接入。':
    'Visitor page switches immediately; the desktop UI follows along.',
  '默认开启「上传自动压缩」': 'Auto-compress on upload by default',
  '同时处理图片数': 'Concurrent images',
  '保存目录': 'Save folder',
  '未设置（每次询问）': 'Not set (ask every time)',
  '选择': 'Choose',
  '清除': 'Clear',
  '端口': 'Port',
  '0 表示自动：优先 5421，被占用时退回随机端口。':
    '0 = auto: try 5421, fall back to a random port.',
  '接收上传的目录': 'Upload folder',
  '访问保护': 'Access protection',
  '链接访问': 'Link access',
  '链接 + PIN': 'Link + PIN',
  '账号登录': 'Account login',
  '已设置 PIN，修改后访客需要重新解锁。':
    'PIN is set; changing it requires visitors to unlock again.',
  '还没有设置 PIN。': 'No PIN set yet.',
  '6 位数字': '6 digits',
  '保存 PIN': 'Save PIN',
  '启用': 'Enabled',
  '删除': 'Delete',
  '下载': 'Download',
  '上传': 'Upload',
  '还没有账号，添加后访客需要登录。': 'No accounts yet; visitors must sign in after you add one.',
  '用户名': 'Username',
  '密码（至少 4 位）': 'Password (4+ characters)',
  '添加账号': 'Add account',
  '允许访客上传文件': 'Allow uploads',
  '允许访客发布文字': 'Allow text posts',
  '分享运行中修改端口或保护方式会自动重启服务，旧链接随即失效。':
    'Changing port or protection while sharing restarts the server and invalidates the old link.',
  '设置保存在应用配置目录；PIN 与账号口令只保存哈希，不写入日志。':
    'Settings live in the app config folder; PIN is hashed and account passwords are stored locally.',
  '压缩使用匿名 TinyPNG 接口；分享服务只在同一个 Tauri 进程内运行。':
    'Compression uses TinyPNG anonymously; sharing runs in the Tauri process.',
  '正在保存…': 'Saving…',
  '修改后立即生效': 'Changes apply immediately',
  '完成': 'Done',
  '大小': 'Size',
  '切换压缩与分享': 'Switch between compress and share',
  '拖放暂时不可用，请使用「添加图片」选择文件。': 'Drag and drop is unavailable; use “Add images”.',
  '压缩进度': 'compression progress',
  '待压缩图片': 'Images to compress',
  '已用压缩结果覆盖原图': 'Original replaced with compressed result',
  '确认后用压缩结果替换原图': 'Replace original with compressed result',
  '选择文件夹': 'Choose folder',
  '语言': 'Language',
  '语言修改会立即同步到桌面端与访客页。':
    'Language changes apply to the desktop and visitor page immediately.',
  '设置保存在应用配置目录；PIN 使用哈希，账号口令明文保存在本地。':
    'Settings live in the app config folder; PIN is hashed and account passwords are stored in plain text locally.',
  '正在取消': 'Canceling',
  '正在上传': 'Uploading',
  '正在下载': 'Downloading',
  '正在校验': 'Verifying',
  '正在确认并覆盖': 'Confirming overwrite',
  '已覆盖原图': 'Original overwritten',
  '已保存': 'Saved',
  '待开始': 'Ready',
  '等待压缩': 'Queued',
  '已完成': 'Completed',
  '已取消': 'Canceled',
  '压缩失败': 'Failed',
  '允许公开访问': 'Allow public access',
  '未开启公开访问时，链接模式下的访客无法打开分享。':
    'With public access off, link-mode visitors cannot open the share.',
  '发文字': 'Send text',
  '文字内容': 'Message',
  '发布': 'Post',
  '端口修改后会重启分享': 'Saving a new port restarts sharing',
  '切换网卡': 'Switch interface',
  '分组': 'Groups',
  '默认分组在根路径；自定义分组在 /g/路径，文件互不共享，可独立设置访问保护。':
    'The default group lives at the root; custom groups live under /g/ with isolated files and independent access protection.',
  '还没有自定义分组，默认分组始终可用。': 'No custom groups yet; the default group is always available.',
  '分组名称': 'Group name',
  '路径（留空随机，仅小写字母/数字/短横线）': 'Path (blank = random; lowercase letters, digits, dashes)',
  '添加分组': 'Add group',
  '根路径': 'Root',
  '默认分组': 'Default',
  '接收目录': 'Upload folder',
  '分享中': 'Sharing',
  '开启服务': 'Start sharing',
  '打开分享开关开始，或先选择内容': 'Turn on sharing to start, or choose items first',
  '不选文件也可以直接开始分享，链接只在分享期间有效':
    'You can start sharing without picking a file; the link is only valid while sharing.',
  '已停止': 'Stopped',
  '只有一个可用网卡': 'Only one LAN interface is available',
  '当前网络没有可用的 IPv6 地址': 'No usable IPv6 address on this network',
  '上传后自动保存到下载目录': 'Auto-save uploads to Downloads',
  '默认手动：访客上传的文件只在列表中高亮，由你选择保存；开启后会自动复制到系统下载目录。':
    'Manual by default: uploaded files are highlighted in the list for you to save. Turn on to copy them to Downloads automatically.',
  '访客上传': 'From visitor',
  '下载所选': 'Download selected',
  '全部下载': 'Download all',
  '当前未开放访问：在设置里开启「允许公开访问」，或改用 PIN/账号保护':
    'Access is closed. Enable “Allow public access” in Settings, or use PIN/account protection.',
  '没有检测到局域网地址，目前只能在本机访问':
    'No LAN address detected; the share is only reachable on this machine.'
};

export const i18n = reactive({ lang: 'zh' as Lang });

export function resolveLanguage(setting: LanguageSetting): Lang {
  if (setting === 'zh') return 'zh';
  if (setting === 'en') return 'en';
  if (typeof navigator === 'undefined') return 'zh';
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function setLanguage(setting: LanguageSetting) {
  i18n.lang = resolveLanguage(setting);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = i18n.lang === 'zh' ? 'zh-CN' : 'en';
  }
}

export function t(text: string, params?: Record<string, string | number>): string {
  let output = i18n.lang === 'en' ? en[text] ?? text : text;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      output = output.split(`{${key}}`).join(String(value));
    }
  }
  return output;
}
