export type PreviewKind = 'image' | 'html' | 'code' | 'text';

const KIND_BY_EXTENSION: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image',
  html: 'html', htm: 'html',
  css: 'code', scss: 'code', less: 'code', js: 'code', mjs: 'code', cjs: 'code',
  jsx: 'code', ts: 'code', tsx: 'code', json: 'code', jsonl: 'code', py: 'code',
  java: 'code', kt: 'code', go: 'code', rs: 'code', rb: 'code', php: 'code',
  c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code', cs: 'code',
  swift: 'code', sh: 'code', bash: 'code', zsh: 'code', sql: 'code', yml: 'code',
  yaml: 'code', toml: 'code', xml: 'code', ini: 'code', vue: 'code', svelte: 'code',
  txt: 'text', md: 'text', markdown: 'text'
};

/** 扩展名与后端 preview_mime 允许范围保持一致，避免悬浮预览必然失败。 */
export function previewKind(name: string): PreviewKind | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(KIND_BY_EXTENSION, extension) ? KIND_BY_EXTENSION[extension] ?? null : null;
}