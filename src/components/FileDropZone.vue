<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{
  chooseFiles: [];
  chooseDirectory: [];
  dropFiles: [files: File[]];
}>();
const dragging = ref(false);

function handleDrop(event: DragEvent): void {
  dragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 0) emit('dropFiles', files);
}
</script>

<template>
  <section
    class="drop-zone"
    :class="{ 'drop-zone--dragging': dragging, 'drop-zone--busy': busy }"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="handleDrop"
  >
    <div class="drop-zone__mark" aria-hidden="true">↥</div>
    <h2>{{ dragging ? '松开鼠标开始压缩' : '把图片拖到这里' }}</h2>
    <p>支持 PNG、JPG、JPEG、WebP，图片默认在本机处理</p>
    <div class="drop-zone__actions">
      <button type="button" :disabled="busy" @click="emit('chooseFiles')">选择图片</button>
      <button type="button" class="secondary" :disabled="busy" @click="emit('chooseDirectory')">选择文件夹</button>
    </div>
  </section>
</template>

<style scoped>
.drop-zone {
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: clamp(30px, 7vw, 72px) 24px;
  border: 1px dashed #93a4bc;
  border-radius: 24px;
  background: linear-gradient(145deg, #ffffff, #f2f6fb);
  text-align: center;
  transition: border-color 160ms ease, transform 160ms ease, background 160ms ease;
}
.drop-zone--dragging {
  border-color: #2563eb;
  background: #eff6ff;
  transform: scale(1.01);
}
.drop-zone--busy {
  opacity: 0.7;
}
.drop-zone__mark {
  display: grid;
  width: 64px;
  height: 64px;
  place-items: center;
  border-radius: 20px;
  background: #dbeafe;
  color: #2563eb;
  font-size: 42px;
  line-height: 1;
}
h2 {
  margin: 0;
  color: #172033;
  font-size: clamp(20px, 3vw, 28px);
}
p {
  margin: 0;
  color: #64748b;
}
.drop-zone__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: 10px;
}
button {
  min-height: 44px;
  padding: 0 18px;
  border: 0;
  border-radius: 12px;
  background: #2563eb;
  color: white;
  cursor: pointer;
  font-weight: 700;
}
button.secondary {
  background: #e2e8f0;
  color: #1e293b;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
