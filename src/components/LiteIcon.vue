<script setup lang="ts">
withDefaults(defineProps<{ name: 'image' | 'plus' | 'folder' | 'upload' | 'download' | 'close' | 'retry' | 'check' | 'replace' | 'settings' | 'link' }>(), { name: 'image' });
const paths = {
  image: 'M4 4h16v16H4z M4 15l5-5 5 5 3-3 3 3 M15 8h.01',
  plus: 'M12 5v14 M5 12h14',
  folder: 'M3 7V5h6l2 2h10v12H3z',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  download: 'M12 3v13 M7 11l5 5 5-5 M4 15v6h16v-6',
  close: 'M6 6l12 12 M6 18L18 6',
  retry: 'M3 11a9 9 0 1 1 2 7 M3 4v7h7',
  check: 'M5 12l4 4L19 6',
  replace: 'M4 4h10v16H4z M4 15l4-4 6 6 M17 8h5 M20 5l3 3-3 3 M22 16h-5 M19 13l-3 3 3 3',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.24.6.8 1 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'
};
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>
