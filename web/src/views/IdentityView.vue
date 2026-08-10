<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../stores/auth.js';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const staffNo = ref('');
const loading = ref(false);

async function selectIdentity() {
  const value = staffNo.value.trim();
  if (!value) return ElMessage.warning('请输入 Staff No');
  loading.value = true;
  try {
    await authStore.selectIdentity(value);
    ElMessage.success(`已选择身份：${authStore.user.name}`);
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect
      : '/task-card/list';
    await router.replace(redirect);
  } catch (error) {
    ElMessage.error(error.message || '身份选择失败');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="identity-page">
    <el-card class="identity-card" shadow="always">
      <template #header><strong>HAECO MES TS · 身份选择</strong></template>
      <el-alert title="演示环境：请输入已启用用户的 Staff No" type="info" :closable="false" />
      <el-form label-position="top" @submit.prevent="selectIdentity">
        <el-form-item label="Staff No">
          <el-input v-model="staffNo" autofocus clearable @keyup.enter="selectIdentity" />
        </el-form-item>
        <el-button type="primary" :loading="loading" class="full-width" @click="selectIdentity">进入系统</el-button>
      </el-form>
    </el-card>
  </main>
</template>
