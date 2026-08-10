import { defineStore } from 'pinia';
import { sessionApi } from '../api/sessionApi.js';
import { clearSessionToken, getSessionToken, setSessionToken } from '../auth/token.js';
import { usePermissionStore } from './permission.js';

export const useAuthStore = defineStore('auth', {
  state: () => ({ token: getSessionToken(), user: null, initialized: false }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token && state.user),
  },
  actions: {
    async refreshIdentity() {
      const permissionStore = usePermissionStore();
      const [user] = await Promise.all([sessionApi.getMe(), permissionStore.load()]);
      this.user = user;
      this.initialized = true;
      return user;
    },
    async initialize() {
      if (!this.token) {
        this.initialized = true;
        return false;
      }
      await this.refreshIdentity();
      return true;
    },
    async selectIdentity(staffNo) {
      const session = await sessionApi.create(staffNo);
      this.token = session.token;
      this.user = session.user;
      setSessionToken(session.token);
      await this.refreshIdentity();
      return this.user;
    },
    clearIdentity() {
      this.token = null;
      this.user = null;
      this.initialized = true;
      clearSessionToken();
      usePermissionStore().reset();
    },
    async logout() {
      try {
        if (this.token) await sessionApi.remove();
      } finally {
        this.clearIdentity();
      }
    },
  },
});
