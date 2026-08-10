import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus, { ElMessage } from 'element-plus';
import 'element-plus/dist/index.css';
import './styles/main.css';
import App from './App.vue';
import router from './router/index.js';
import { configureHttpErrorHandlers } from './api/http.js';
import { useAuthStore } from './stores/auth.js';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(ElementPlus);

const authStore = useAuthStore(pinia);
configureHttpErrorHandlers({
  onUnauthorized: async () => {
    const redirect = router.currentRoute.value.fullPath;
    authStore.clearIdentity();
    if (router.currentRoute.value.name !== 'identity') {
      await router.replace({ name: 'identity', query: { redirect } });
    }
  },
  onForbidden: (error) => ElMessage.error(error.message || '无权执行此操作'),
});

try {
  await authStore.initialize();
} catch {
  // 401 is normalized by the HTTP interceptor and redirects to identity selection.
}

await router.isReady();
app.mount('#app');
