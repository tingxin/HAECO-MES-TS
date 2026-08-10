<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const showShell = computed(() => !route.meta.public);

async function logout() {
  await authStore.logout();
  await router.replace({ name: 'identity' });
}
</script>

<template>
  <router-view v-if="!showShell" />
  <el-container v-else class="app-shell">
    <el-header class="app-header">
      <div class="brand">HAECO MES TS</div>
      <nav>
        <router-link to="/task-card/list">工卡清单</router-link>
        <router-link to="/task-card/editor">工卡编制</router-link>
        <router-link to="/config">配置</router-link>
      </nav>
      <div class="user-area">
        <span>{{ authStore.user?.name ?? authStore.user?.staffNo }}</span>
        <el-button link type="primary" @click="logout">退出</el-button>
      </div>
    </el-header>
    <el-main><router-view /></el-main>
  </el-container>
</template>
