<script setup>
import AttachmentUploader from './AttachmentUploader.vue';
const props = defineProps({ modelValue: { type: Object, required: true }, readonly: Boolean });
const emit = defineEmits(['update:modelValue']);
function patch(value) { emit('update:modelValue', { ...props.modelValue, ...value }); }
function visualUploaded(file) { patch({ visualCue: { type: file.mimeType?.startsWith('video/') ? 'video' : 'image', attachmentId: file.id, url: file.url } }); }
</script>

<template>
  <section data-testid="safety-warning-editor">
    <el-form label-width="110px">
      <el-form-item label="安全警示"><el-input :model-value="modelValue.safetyWarning" type="textarea" :rows="2" :disabled="readonly" @update:model-value="patch({safetyWarning:$event})" /></el-form-item>
      <el-form-item label="视觉提示"><div class="visual-row"><span v-if="modelValue.visualCue?.url">{{ modelValue.visualCue.type }} · {{ modelValue.visualCue.url }}</span><AttachmentUploader v-if="!readonly" accept="image/*,video/*" label="上传图片/视频" @uploaded="visualUploaded" /></div></el-form-item>
      <el-form-item label="维修技巧"><el-input :model-value="modelValue.repairTips" type="textarea" :rows="2" :disabled="readonly" @update:model-value="patch({repairTips:$event})" /></el-form-item>
      <el-form-item label="关键标记"><el-checkbox :model-value="Boolean(modelValue.isCritical)" :disabled="readonly" @update:model-value="patch({isCritical:$event})">关键维修 / 易误操作（执行前必须确认）</el-checkbox></el-form-item>
    </el-form>
  </section>
</template>
<style scoped>.visual-row{display:flex;align-items:center;gap:12px}</style>
