import { onBeforeUnmount, ref, type Ref } from 'vue';

export function useMediaQuery(query: string): Ref<boolean> {
  const mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : undefined;
  const matches = ref(mql?.matches ?? false);
  const update = (e: MediaQueryListEvent) => { matches.value = e.matches; };
  mql?.addEventListener('change', update);
  onBeforeUnmount(() => mql?.removeEventListener('change', update));
  return matches;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
