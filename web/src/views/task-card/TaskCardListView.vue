<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { taskCardApi } from '../../api/taskCardApi.js';
import { usePermissionStore } from '../../stores/permission.js';
import { useTaskCardStore } from '../../stores/taskCard.js';
import SearchToolbar from './SearchToolbar.vue';
import TaskCardTable from './TaskCardTable.vue';
import ColumnSettingsDialog from './ColumnSettingsDialog.vue';
import BatchCopyDialog from './BatchCopyDialog.vue';
import BatchReplaceDialog from './BatchReplaceDialog.vue';
import VoidDialog from './VoidDialog.vue';
import ExecDocCopyDialog from './ExecDocCopyDialog.vue';
import MigrationImportDialog from './MigrationImportDialog.vue';
import { printTriples } from '../output/printRenderer.js';
import { loadColumns } from './columnSettings.js';

const router = useRouter();
const permissionStore = usePermissionStore();
const taskCardStore = useTaskCardStore();
const permissions = computed(() => ({
  read: permissionStore.hasPermission('card_read'), edit: permissionStore.hasPermission('card_edit'),
  void: permissionStore.hasPermission('card_void'), output: permissionStore.hasPermission('card_print_export'),
  replace: permissionStore.hasPermission('batch_replace'), migration: permissionStore.hasPermission('migration_run'),
}));
const filters = reactive({ acType: '', taskNo: '', gearType: '', title: '', status: '', stage: '', ...taskCardStore.filters });
const rows = ref([]); const total = ref(0); const page = ref(1); const pageSize = ref(20); const loading = ref(false);
const selectedRows = ref([]); const columns = ref(loadColumns());
const dialogs = reactive({ columns: false, copy: false, replace: false, void: false, sws: false, migration: false });
const selectedIds = computed(() => selectedRows.value.map(({ id }) => id));
const selectedOne = computed(() => selectedRows.value.length === 1 ? selectedRows.value[0] : null);
const editText = computed(() => selectedOne.value?.status === 'Effective' ? '升版后编辑' : '编辑');

function normalizeFilters(value) { Object.assign(filters, value || {}); taskCardStore.filters = { ...filters }; }
async function search(value = filters) {
  normalizeFilters(value); loading.value = true;
  try {
    const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => String(value ?? '').trim() !== ''));
    const response = await taskCardApi.list({ ...activeFilters, page: page.value, pageSize: pageSize.value });
    rows.value = response.list || []; total.value = response.total || 0;
    page.value = response.page || page.value; pageSize.value = response.pageSize || pageSize.value;
  } catch (error) { ElMessage.error(error.message || '工卡清单加载失败'); }
  finally { loading.value = false; }
}
function onSelectionChange(value) { selectedRows.value = value; taskCardStore.setSelectedRows(value); }
function requireSelection(action) {
  if (!selectedRows.value.length) { ElMessage.warning('请先选择工卡'); return false; }
  action(); return true;
}
function requireSingle(action) {
  if (!requireSelection(() => {})) return false;
  if (selectedRows.value.length !== 1) { ElMessage.warning('请选择一张工卡'); return false; }
  action(selectedRows.value[0]); return true;
}
function openEditor(mode, card) { router.push({ name: 'task-card-editor', query: { mode, ...(card ? { id: card.id } : {}) } }); }
function addCard() { openEditor('add'); }
function selectCard(card) { if (card) onSelectionChange([card]); }
function detail(card = selectedOne.value) { selectCard(card); requireSingle((selected) => openEditor('view', selected)); }
function edit(card = selectedOne.value) {
  selectCard(card);
  requireSingle((selected) => selected.status === 'Effective' ? revise() : openEditor('edit', selected));
}
async function executeRevise(reason) {
  try {
    const created = await taskCardApi.revise({ ids: selectedIds.value, reason });
    ElMessage.success(`已升版 ${created.length} 张工卡`);
    if (created.length === 1) openEditor('edit', created[0]);
    await search();
  } catch (error) { ElMessage.error(error.message || '升版失败'); }
}
function revise(card) {
  selectCard(card);
  requireSelection(async () => {
    const reason = globalThis.prompt?.('请输入升版原因')?.trim();
    if (!reason) { ElMessage.warning('升版原因必填'); return; }
    await executeRevise(reason);
  });
}
function openCopy(card) { selectCard(card); requireSelection(() => { dialogs.copy = true; }); }
function openReplace() { requireSelection(() => { dialogs.replace = true; }); }
function openVoid(card) { selectCard(card); requireSelection(() => { dialogs.void = true; }); }
async function exportCards(mode) {
  requireSelection(async () => {
    try {
      const blob = await taskCardApi.exportCsv(selectedIds.value, mode);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `task-cards-${mode}.csv`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) { ElMessage.error(error.message || '导出失败'); }
  });
}
function printCards(card) {
  selectCard(card);
  requireSelection(async () => {
    try {
      const models = await Promise.all(selectedIds.value.map((id) => taskCardApi.getPrintModel(id)));
      printTriples(models);
      ElMessage.success(`已渲染 ${models.length} 张工卡并发送至浏览器打印`);
    } catch (error) { ElMessage.error(error.message || '打印失败'); }
  });
}
function changePage(value) { page.value = value; search(); }
function changePageSize(value) { pageSize.value = value; page.value = 1; search(); }
onMounted(() => { if (permissions.value.read) search(); });
defineExpose({ filters, rows, selectedRows, dialogs, search, onSelectionChange, detail, edit, revise, openCopy, openReplace, openVoid, exportCards, printCards });
</script>

<template>
  <section class="task-card-list-view" data-testid="task-card-list-view">
    <el-card shadow="never">
      <template #header><div class="page-heading"><div><h1>工卡清单</h1><p>Task Card List</p></div><el-button :disabled="!permissions.read" data-testid="column-settings" @click="dialogs.columns = true">列设置</el-button></div></template>
      <SearchToolbar :model-value="filters" :loading="loading" :disabled="!permissions.read" @update:model-value="normalizeFilters" @search="search" @reset="search" />
      <el-alert v-if="!permissions.read" title="当前身份无工卡读取权限" type="warning" :closable="false" show-icon />
      <div class="action-bar">
        <el-button type="primary" :disabled="!permissions.edit" data-testid="action-add" @click="addCard">新增</el-button>
        <el-button :disabled="!permissions.edit" data-testid="action-edit" @click="edit()">{{ editText }}</el-button>
        <el-button :disabled="!permissions.edit" data-testid="action-copy" @click="openCopy()">复制</el-button>
        <el-button :disabled="!permissions.edit" data-testid="action-revise" @click="revise()">升版</el-button>
        <el-button :disabled="!permissions.read" data-testid="action-detail" @click="detail()">查看详情</el-button>
        <el-button :disabled="!permissions.output" data-testid="action-key-export" @click="exportCards('key')">关键信息导出</el-button>
        <el-button :disabled="!permissions.output" data-testid="action-all-export" @click="exportCards('full')">全量导出</el-button>
        <el-button :disabled="!permissions.output" data-testid="action-print" @click="printCards()">打印</el-button>
        <el-button type="danger" plain :disabled="!permissions.void" data-testid="action-void" @click="openVoid()">作废</el-button>
        <el-button type="warning" plain :disabled="!permissions.replace" data-testid="action-batch-replace" @click="openReplace">批量替换</el-button>
        <el-button type="success" plain :disabled="!permissions.edit" data-testid="action-sws-copy" @click="dialogs.sws = true">SWS 复制</el-button>
        <el-button type="primary" plain :disabled="!permissions.migration" data-testid="action-migration" @click="dialogs.migration = true">迁移导入</el-button>
        <span class="selection-count">已选 {{ selectedRows.length }} 张</span>
      </div>
      <TaskCardTable :rows="rows" :columns="columns" :loading="loading" :can-read="permissions.read" :can-edit="permissions.edit"
        :can-void="permissions.void" :can-print="permissions.output" @selection-change="onSelectionChange" @edit="edit" @copy="openCopy"
        @revise="revise" @detail="detail" @print="printCards" @void="openVoid" />
      <el-pagination v-if="total" class="pagination" :current-page="page" :page-size="pageSize" :total="total"
        :page-sizes="[10, 20, 50, 100]" layout="total, sizes, prev, pager, next" @current-change="changePage" @size-change="changePageSize" />
    </el-card>
    <ColumnSettingsDialog v-model="dialogs.columns" :columns="columns" @apply="columns = $event" />
    <BatchCopyDialog v-model="dialogs.copy" :cards="selectedRows" @completed="search" />
    <BatchReplaceDialog v-model="dialogs.replace" :cards="selectedRows" @completed="search" />
    <VoidDialog v-model="dialogs.void" :cards="selectedRows" @completed="search" />
    <ExecDocCopyDialog v-model="dialogs.sws" />
    <MigrationImportDialog v-model="dialogs.migration" @completed="search()" />
  </section>
</template>

<style scoped>
.task-card-list-view { min-width: 980px; }
.page-heading { display: flex; align-items: center; justify-content: space-between; }
h1 { margin: 0; color: #12395b; font-size: 22px; }
.page-heading p { margin: 3px 0 0; color: #909399; font-size: 12px; }
.action-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0 14px; padding-top: 12px; border-top: 1px solid #ebeef5; }
.action-bar .el-button + .el-button { margin-left: 0; }
.selection-count { margin-left: auto; color: #606266; font-size: 13px; }
.pagination { justify-content: flex-end; margin-top: 16px; }
</style>
