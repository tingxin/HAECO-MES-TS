<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { attachmentApi } from '../../api/attachmentApi.js';
const props = defineProps({ accept: { type: String, default: 'image/*,video/*,audio/*' }, disabled: Boolean, label: { type: String, default: '上传附件' } });
const emit = defineEmits(['uploaded', 'error']);
const input = ref(); const uploading = ref(false);
async function uploadFile(file) {
  if (!file || props.disabled) return null;
  uploading.value = true;
  try { const result = await attachmentApi.upload(file); emit('uploaded', { ...result, mimeType: file.type, name: file.name }); return result; }
  catch (error) { emit('error', error); ElMessage.error(error.message || '附件上传失败，已有内容已保留'); return null; }
  finally { uploading.value = false; if (input.value) input.value.value = ''; }
}
function choose() { input.value?.click(); }
function onChange(event) { uploadFile(event.target.files?.[0]); }
defineExpose({ uploadFile });
</script>

<template>
  <span class="attachment-uploader" data-testid="attachment-uploader">
    <input ref="input" class="native-file" type="file" :accept="accept" :disabled="disabled" @change="onChange" />
    <el-button :disabled="disabled" :loading="uploading" @click="choose">{{ label }}</el-button>
  </span>
</template>
<style scoped>.native-file{display:none}</style>
