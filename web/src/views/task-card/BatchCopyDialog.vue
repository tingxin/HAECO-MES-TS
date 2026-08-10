<script setup>
import { reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { taskCardApi } from '../../api/taskCardApi.js';

const props = defineProps({ modelValue: Boolean, cards: { type: Array, default: () => [] } });
const emit = defineEmits(['update:modelValue', 'completed']);
const form = reactive({ prefix: '', suffix: '', startSeq: 1, step: 1 });
const submitting = ref(false);
const results = ref([]);
watch(() => props.modelValue, (opened) => { if (opened) results.value = []; });
async function submit() {
  submitting.value = true;
  try {
    const copied = await taskCardApi.copy({ ids: props.cards.map(({ id }) => id), numbering: { ...form } });
    results.value = copied.map((card) => ({ ...card, adjustedTaskNo: card.taskNo, adjusting: false, adjustmentMessage: '' }));
    ElMessage.success(`已复制 ${results.value.length} 张工卡`);
    emit('completed', copied);
  } catch (error) { ElMessage.error(error.message || '复制失败'); }
  finally { submitting.value = false; }
}
async function adjustTaskNo(row) {
  const taskNo = String(row.adjustedTaskNo ?? '').trim();
  row.adjustmentMessage = '';
  if (!taskNo) { row.adjustmentMessage = '调整后的编号必填'; return; }
  if (taskNo === row.taskNo) { row.adjustmentMessage = '编号未变更'; return; }
  row.adjusting = true;
  try {
    const adjusted = await taskCardApi.adjustCopiedTaskNo(row.id, taskNo);
    Object.assign(row, adjusted, { adjustedTaskNo: adjusted.taskNo, adjustmentMessage: '已保存' });
    ElMessage.success(`工卡编号已调整为 ${adjusted.taskNo}`);
    emit('completed', [adjusted]);
  } catch (error) { row.adjustmentMessage = error.message || '编号调整失败'; }
  finally { row.adjusting = false; }
}
defineExpose({ form, results, submit, adjustTaskNo });
</script>

<template>
  <el-dialog :model-value="modelValue" title="批量复制工卡" width="760px" @update:model-value="emit('update:modelValue', $event)">
    <el-form label-width="96px">
      <el-row :gutter="12">
        <el-col :span="6"><el-form-item label="前缀"><el-input v-model="form.prefix" data-testid="copy-prefix" /></el-form-item></el-col>
        <el-col :span="6"><el-form-item label="后缀"><el-input v-model="form.suffix" data-testid="copy-suffix" /></el-form-item></el-col>
        <el-col :span="6"><el-form-item label="起始序号"><el-input-number v-model="form.startSeq" :min="0" data-testid="copy-start" /></el-form-item></el-col>
        <el-col :span="6"><el-form-item label="步长"><el-input-number v-model="form.step" :min="1" data-testid="copy-step" /></el-form-item></el-col>
      </el-row>
    </el-form>
    <template v-if="results.length">
      <el-alert class="contract-alert" type="success" :closable="false"
        title="复制完成后可逐张调整新工卡编号；保存时仍会执行编号与版本唯一性校验。" />
      <el-table :data="results" size="small" data-testid="copy-results">
        <el-table-column prop="taskNo" label="当前编号" min-width="180" />
        <el-table-column label="逐张调整" min-width="220"><template #default="{ row }"><el-input v-model="row.adjustedTaskNo" :disabled="row.adjusting" /></template></el-table-column>
        <el-table-column label="保存结果" min-width="170"><template #default="{ row }">
          <el-button :loading="row.adjusting" data-testid="save-adjusted-task-no" @click="adjustTaskNo(row)">保存编号</el-button>
          <span class="adjustment-message">{{ row.adjustmentMessage }}</span>
        </template></el-table-column>
      </el-table>
    </template>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :loading="submitting" data-testid="copy-submit" @click="submit">执行复制</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.contract-alert { margin: 8px 0 14px; }
.adjustment-message { margin-left: 8px; color: #606266; font-size: 12px; }
</style>