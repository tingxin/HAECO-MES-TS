<script setup>
import { reactive, watch } from 'vue';

const STATUS_OPTIONS = Object.freeze([
  ['New', '新增'], ['UnderReview', '审核中'], ['Effective', '生效'],
  ['Superseded', '已被取代'], ['Void', '作废'],
]);
const STAGE_OPTIONS = Object.freeze(['CUS', 'DMY', 'MOD', 'NRC', 'RTN', 'SPC', 'WCC', 'WFD']);
const EMPTY_FILTERS = Object.freeze({ acType: '', taskNo: '', gearType: '', title: '', status: '', stage: '', cmm: '', processSkills: [], processDescription: '' });

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  loading: Boolean,
  disabled: Boolean,
});
const emit = defineEmits(['update:modelValue', 'search', 'reset']);
const form = reactive({ ...EMPTY_FILTERS, ...props.modelValue });

watch(() => props.modelValue, (value) => Object.assign(form, EMPTY_FILTERS, value || {}), { deep: true });

function cleanFilters() {
  return Object.fromEntries(Object.entries(form).map(([key, value]) => [key,
    Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : String(value ?? '').trim(),
  ]));
}
function search() {
  const filters = cleanFilters();
  emit('update:modelValue', filters);
  emit('search', filters);
}
function reset() {
  Object.assign(form, EMPTY_FILTERS);
  const filters = { ...EMPTY_FILTERS };
  emit('update:modelValue', filters);
  emit('reset', filters);
}
defineExpose({ form, search, reset });
</script>

<template>
  <el-form class="search-toolbar" :inline="true" :model="form" data-testid="search-toolbar">
    <span class="sr-only" data-testid="status-values">{{ STATUS_OPTIONS.map(([value]) => value).join(',') }}</span>
    <span class="sr-only" data-testid="stage-values">{{ STAGE_OPTIONS.join(',') }}</span>
    <el-form-item label="A/C Type"><el-input v-model="form.acType" data-testid="filter-ac-type" clearable /></el-form-item>
    <el-form-item label="Task No"><el-input v-model="form.taskNo" data-testid="filter-task-no" clearable /></el-form-item>
    <el-form-item label="Gear Type"><el-input v-model="form.gearType" data-testid="filter-gear-type" clearable /></el-form-item>

    <el-form-item label="标题"><el-input v-model="form.title" data-testid="filter-title" clearable /></el-form-item>
    <el-form-item label="状态"><el-select v-model="form.status" data-testid="filter-status" clearable placeholder="全部状态">
      <el-option v-for="([value, label]) in STATUS_OPTIONS" :key="value" :label="`${label} (${value})`" :value="value" />
    </el-select></el-form-item>
    <el-form-item label="Stage"><el-select v-model="form.stage" data-testid="filter-stage" clearable placeholder="全部 Stage">
      <el-option v-for="value in STAGE_OPTIONS" :key="value" :label="value === 'WFD' ? 'WFD（待删除）' : value" :value="value" />
    </el-select></el-form-item>
    <el-form-item label="CMM"><el-input v-model="form.cmm" data-testid="filter-cmm" clearable /></el-form-item>
    <el-form-item label="Process Skill"><el-select v-model="form.processSkills" multiple filterable allow-create default-first-option
      data-testid="filter-process-skills" placeholder="可多选 / 输入后回车"><el-option v-for="value in form.processSkills" :key="value" :label="value" :value="value" /></el-select></el-form-item>
    <el-form-item label="Process Description"><el-input v-model="form.processDescription" data-testid="filter-process-description" clearable /></el-form-item>
    <el-form-item class="search-actions">
      <el-button type="primary" :loading="loading" :disabled="disabled" data-testid="search-button" @click="search">查询</el-button>
      <el-button :disabled="disabled" data-testid="reset-button" @click="reset">重置</el-button>
    </el-form-item>
  </el-form>
</template>

<style scoped>
.search-toolbar { display: flex; align-items: flex-start; gap: 0 8px; flex-wrap: wrap; }
.search-toolbar :deep(.el-form-item) { margin-right: 4px; margin-bottom: 12px; }
.search-toolbar :deep(.el-input), .search-toolbar :deep(.el-select) { width: 155px; }
.search-actions { margin-left: auto; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
</style>