<script setup>
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { execDocApi } from '../../api/execDocApi.js';

const props = defineProps({ modelValue: Boolean });
const emit = defineEmits(['update:modelValue', 'completed']);
const documents = ref([]);
const sourceId = ref('');
const newDocNo = ref('');
const loading = ref(false);
const submitting = ref(false);
const errorText = ref('');
const result = ref(null);
watch(() => props.modelValue, async (opened) => {
  if (!opened) return;
  sourceId.value = ''; newDocNo.value = ''; errorText.value = ''; result.value = null; loading.value = true;
  try {
    const response = await execDocApi.list({ execDocType: 'SW' });
    documents.value = response.list || [];
  } catch (error) { ElMessage.error(error.message || 'SWS 列表加载失败'); }
  finally { loading.value = false; }
});
async function submit() {
  errorText.value = '';
  if (!sourceId.value) { errorText.value = '请选择来源 SWS'; return; }
  if (!newDocNo.value.trim()) { errorText.value = '新编号必填'; return; }
  submitting.value = true;
  try {
    result.value = await execDocApi.copy({ id: sourceId.value, newDocNo: newDocNo.value.trim() });
    ElMessage.success(`SWS ${result.value.docNo} 复制成功`);
    emit('completed', result.value);
  } catch (error) { errorText.value = error.message || 'SWS 复制失败'; }
  finally { submitting.value = false; }
}
defineExpose({ documents, sourceId, newDocNo, result, submit });
</script>

<template>
  <el-dialog :model-value="modelValue" title="复制 SWS" width="620px" @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="SWS 是执行过程单据类型 SW；本功能仅复制，不提供 SWS 编制表单。" type="info" :closable="false" />
    <el-form v-loading="loading" label-width="110px" class="dialog-form">
      <el-form-item label="来源 SWS" required><el-select v-model="sourceId" filterable class="full-width" data-testid="sws-source">
        <el-option v-for="doc in documents" :key="doc.id" :label="`${doc.docNo} · ${doc.title || 'SWS'}`" :value="doc.id" />
      </el-select></el-form-item>
      <el-form-item label="新编号" required><el-input v-model="newDocNo" data-testid="sws-new-number" placeholder="请输入不重复的新编号" /></el-form-item>
      <p v-if="errorText" class="form-error" data-testid="sws-error">{{ errorText }}</p>
    </el-form>
    <el-result v-if="result" icon="success" title="复制成功" :sub-title="`${result.docNo} / New / Rev ${String(result.revision).padStart(2, '0')}`" data-testid="sws-result" />

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :loading="submitting" data-testid="sws-submit" @click="submit">复制 SWS</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-form { margin-top: 16px; }
.form-error { margin: -8px 0 12px 110px; color: #f56c6c; font-size: 13px; }
</style>