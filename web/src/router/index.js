import { createRouter, createWebHistory } from 'vue-router';
import { getSessionToken } from '../auth/token.js';
import IdentityView from '../views/IdentityView.vue';
import TaskCardListView from '../views/task-card/TaskCardListView.vue';
import TaskCardEditorView from '../views/task-card/TaskCardEditorView.vue';
import ProcessStepEditorView from '../views/task-card/ProcessStepEditorView.vue';

const JobViewerView = () => import('../views/job/JobViewerView.vue');
const ConfigMaintenanceView = () => import('../views/config/ConfigMaintenanceView.vue');

const routes = [
  { path: '/', redirect: '/task-card/list' },
  { path: '/identity', name: 'identity', component: IdentityView, meta: { public: true, title: '选择身份' } },
  { path: '/task-card/list', name: 'task-card-list', component: TaskCardListView, meta: { title: '工卡清单' } },
  { path: '/task-card/editor', name: 'task-card-editor', component: TaskCardEditorView, meta: { title: '工卡编制' } },
  { path: '/task-card/step', name: 'task-card-step', component: ProcessStepEditorView, meta: { title: '工序编辑' } },
  { path: '/job/:jobNo', name: 'job', component: JobViewerView, meta: { title: 'JOB 执行' } },
  { path: '/config', name: 'config', component: ConfigMaintenanceView, meta: { title: '系统配置' } },
  { path: '/:pathMatch(.*)*', redirect: '/task-card/list' },
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to) => {
  const hasToken = Boolean(getSessionToken());
  if (!to.meta.public && !hasToken) return { name: 'identity', query: { redirect: to.fullPath } };
  if (to.name === 'identity' && hasToken) return { name: 'task-card-list' };
  return true;
});

router.afterEach((to) => {
  document.title = `${to.meta.title ?? 'HAECO MES TS'} | HAECO MES TS`;
});

export default router;
