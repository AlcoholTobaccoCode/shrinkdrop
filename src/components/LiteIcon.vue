<script setup lang="ts">
withDefaults(defineProps<{ name: 'image' | 'plus' | 'folder' | 'upload' | 'download' | 'close' | 'retry' | 'check' }>(), { name: 'image' });
const paths = {
  image: 'M4 4h16v16H4z M4 15l5-5 5 5 3-3 3 3 M15 8h.01',
  plus: 'M12 5v14 M5 12h14',
  folder: 'M3 7V5h6l2 2h10v12H3z',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  download: 'M12 3v13 M7 11l5 5 5-5 M4 15v6h16v-6',
  close: 'M6 6l12 12 M6 18L18 6',
  retry: 'M3 11a9 9 0 1 1 2 7 M3 4v7h7',
  check: 'M5 12l4 4L19 6'
};
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>
