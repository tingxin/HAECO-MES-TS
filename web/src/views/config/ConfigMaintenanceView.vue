<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { configApi } from '../../api/configApi.js';
import { usePermissionStore } from '../../stores/permission.js';

const permissionStore = usePermissionStore();
const canWriteConfig = computed(() => permissionStore.hasPermission('config_write'));
const canWriteCapabilities = computed(() => permissionStore.hasPermission('capability_write'));
const loading = ref(false);
const saving = ref('');
const activeTab = ref('stage');
const enums = ref({});
const stage = reactive({ constraints: [], crosscut: [] });
const commercial = ref([]);
const priorities = ref([]);
const capabilities = ref([]);
function values(name) { return enums.value[name] || []; }
function clone(value) { return structuredClone(value); }
async function load() {
  loading.value = true;
  try {
    const [enumData, stageData, commercialData, priorityData, capabilityData] = await Promise.all([
      configApi.getEnums(), configApi.getStageConstraints(), configApi.getCommercialMap(),
      configApi.getDerivationPriority(), configApi.getCapabilities(),
    ]);
    enums.value = enumData; stage.constraints = clone(stageData.constraints || []); stage.crosscut = [...(stageData.crosscut || [])];
    commercial.value = clone(commercialData || []); priorities.value = clone(priorityData.all || priorityData || []); capabilities.value = clone(capabilityData || []);
  } catch (error) { ElMessage.error(error.message || '配置加载失败'); }
  finally { loading.value = false; }
}
async function saveGroup(name, writer) {
  saving.value = name;
  try { await writer(); await load(); ElMessage.success('保存成功：改配置即生效，无需改代码'); }
  catch (error) { ElMessage.error(error.message || '配置保存失败'); }
  finally { saving.value = ''; }
}
function addStage() { stage.constraints.push({ cardType: values('cardType')[0] || '01', allowedStage: values('stage')[0] || 'CUS', isAutoFill: false }); }
function addCommercial() { commercial.value.push({ cardType: values('cardType')[0] || '01', commercialClassification: values('commercialClassification')[0] || '' }); }
function addPriority() { priorities.value.push({ tierCode: values('derivationPriority')[0] || '', tierOrder: priorities.value.length + 1, enabled: true }); }
function addCapability() { capabilities.value.push({ acType: values('acType')[0] || '', gearType: values('gearType')[0] || '', skill: values('skill')[0] || '', revision: 1, effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: null }); }
const saveStage = () => saveGroup('stage', () => configApi.updateStageConstraints({ constraints: stage.constraints, crosscut: stage.crosscut }));
const saveCommercial = () => saveGroup('commercial', () => configApi.updateCommercialMap({ mappings: commercial.value }));
const savePriority = () => saveGroup('priority', () => configApi.updateDerivationPriority({ tiers: priorities.value }));
const saveCapabilities = () => saveGroup('capability', () => configApi.updateCapabilities({ capabilities: capabilities.value }));
onMounted(load);
defineExpose({ activeTab, canWriteConfig, canWriteCapabilities, stage, commercial, priorities, capabilities, load, saveStage, saveCommercial, savePriority, saveCapabilities });
</script>

<template>
  <section class="config-view" data-testid="config-maintenance-view" v-loading="loading">
    <el-card shadow="never"><template #header><div class="heading"><div><h1>配置维护</h1><p>配置写入后立即生效，无需修改代码</p></div><el-tag type="info">Runtime Configuration</el-tag></div></template>
      <el-alert v-if="!canWriteConfig" title="当前身份无 config_write 权限：Stage、商务分类映射和优先级链只读" type="warning" :closable="false" show-icon data-testid="config-readonly-warning" />
      <el-alert v-if="!canWriteCapabilities" title="当前身份无 capability_write 权限：能力清单只读（该权限与 config_write 独立）" type="warning" :closable="false" show-icon data-testid="capability-readonly-warning" />
      <el-tabs v-model="activeTab">
        <el-tab-pane label="Stage × 工卡类型" name="stage">
          <div class="toolbar"><b>横切 Stage 取值</b><el-select v-model="stage.crosscut" multiple :disabled="!canWriteConfig" data-testid="stage-crosscut"><el-option v-for="item in values('stage')" :key="item" :label="item" :value="item" /></el-select><el-button :disabled="!canWriteConfig" @click="addStage">新增约束</el-button><el-button type="primary" :disabled="!canWriteConfig" :loading="saving === 'stage'" data-testid="save-stage" @click="saveStage">保存</el-button></div>
          <el-table :data="stage.constraints" data-testid="stage-table"><el-table-column label="工卡类型"><template #default="{ row }"><el-select v-model="row.cardType" :disabled="!canWriteConfig"><el-option v-for="item in values('cardType')" :key="item" :label="item" :value="item" /></el-select></template></el-table-column><el-table-column label="允许 Stage"><template #default="{ row }"><el-select v-model="row.allowedStage" :disabled="!canWriteConfig"><el-option v-for="item in values('stage')" :key="item" :label="item" :value="item" /></el-select></template></el-table-column><el-table-column label="默认自动填充" width="140"><template #default="{ row }"><el-switch v-model="row.isAutoFill" :disabled="!canWriteConfig" /></template></el-table-column><el-table-column label="操作" width="90"><template #default="{ $index }"><el-button link type="danger" :disabled="!canWriteConfig" @click="stage.constraints.splice($index, 1)">删除</el-button></template></el-table-column></el-table>
        </el-tab-pane>

        <el-tab-pane label="工卡类型 → 商务分类" name="commercial">
          <div class="toolbar"><el-button :disabled="!canWriteConfig" @click="addCommercial">新增映射</el-button><el-button type="primary" :disabled="!canWriteConfig" :loading="saving === 'commercial'" data-testid="save-commercial" @click="saveCommercial">保存</el-button></div>
          <el-table :data="commercial" data-testid="commercial-table"><el-table-column label="工卡类型"><template #default="{ row }"><el-select v-model="row.cardType" :disabled="!canWriteConfig"><el-option v-for="item in values('cardType')" :key="item" :label="item" :value="item" /></el-select></template></el-table-column><el-table-column label="商务分类"><template #default="{ row }"><el-select v-model="row.commercialClassification" :disabled="!canWriteConfig" filterable><el-option v-for="item in values('commercialClassification')" :key="item" :label="item" :value="item" /></el-select></template></el-table-column><el-table-column label="操作" width="90"><template #default="{ $index }"><el-button link type="danger" :disabled="!canWriteConfig" @click="commercial.splice($index, 1)">删除</el-button></template></el-table-column></el-table>
        </el-tab-pane>

        <el-tab-pane label="商务分类派生优先级" name="priority">
          <div class="toolbar"><el-button :disabled="!canWriteConfig" @click="addPriority">新增层级</el-button><el-button type="primary" :disabled="!canWriteConfig" :loading="saving === 'priority'" data-testid="save-priority" @click="savePriority">保存</el-button></div>
          <el-table :data="priorities" data-testid="priority-table"><el-table-column label="层级代码"><template #default="{ row }"><el-select v-model="row.tierCode" :disabled="!canWriteConfig"><el-option v-for="item in values('derivationPriority')" :key="item" :label="item" :value="item" /></el-select></template></el-table-column><el-table-column label="tier_order" width="150"><template #default="{ row }"><el-input-number v-model="row.tierOrder" :min="1" :disabled="!canWriteConfig" /></template></el-table-column><el-table-column label="enabled" width="120"><template #default="{ row }"><el-switch v-model="row.enabled" :disabled="!canWriteConfig" /></template></el-table-column><el-table-column label="操作" width="90"><template #default="{ $index }"><el-button link type="danger" :disabled="!canWriteConfig" @click="priorities.splice($index, 1)">删除</el-button></template></el-table-column></el-table>
        </el-tab-pane>

        <el-tab-pane label="能力清单" name="capability">
          <div class="toolbar"><span>独立权限：capability_write</span><el-button :disabled="!canWriteCapabilities" @click="addCapability">新增能力</el-button><el-button type="primary" :disabled="!canWriteCapabilities" :loading="saving === 'capability'" data-testid="save-capability" @click="saveCapabilities">保存</el-button></div>
          <el-table :data="capabilities" data-testid="capability-table"><el-table-column label="A/C Type"><template #default="{ row }"><el-select v-model="row.acType" :disabled="!canWriteCapabilities"><el-option v-for="item in values('acType')" :key="item" :label="item" :value="item" /></el-select></template></el-table-column><el-table-column label="Gear Type"><template #default="{ row }"><el-select v-model="row.gearType" :disabled="!canWriteCapabilities"><el-option v-for="item in values('gearType')" :key="item" :label="item" :value="item" /></el-select></template></el-table-column><el-table-column label="Skill"><template #default="{ row }"><el-select v-model="row.skill" :disabled="!canWriteCapabilities"><el-option v-for="item in values('skill')" :key="item" :label="item" :value="item" /></el-select></template></el-table-column><el-table-column label="Revision" width="130"><template #default="{ row }"><el-input-number v-model="row.revision" :min="1" :disabled="!canWriteCapabilities" /></template></el-table-column><el-table-column label="生效日期" width="160"><template #default="{ row }"><el-date-picker v-model="row.effectiveFrom" value-format="YYYY-MM-DD" :disabled="!canWriteCapabilities" /></template></el-table-column><el-table-column label="失效日期" width="160"><template #default="{ row }"><el-date-picker v-model="row.effectiveTo" value-format="YYYY-MM-DD" clearable :disabled="!canWriteCapabilities" /></template></el-table-column><el-table-column label="操作" width="90"><template #default="{ $index }"><el-button link type="danger" :disabled="!canWriteCapabilities" @click="capabilities.splice($index, 1)">删除</el-button></template></el-table-column></el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </section>
</template>

<style scoped>.config-view{min-width:980px}.heading,.toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px}.heading h1{margin:0;color:#12395b;font-size:22px}.heading p{margin:4px 0 0;color:#909399}.el-alert{margin-bottom:10px}.toolbar{justify-content:flex-end;margin:10px 0}.toolbar>b,.toolbar>span{margin-right:auto}.toolbar .el-select{width:360px}.el-table :deep(.el-select),.el-table :deep(.el-date-editor){width:100%}</style>
