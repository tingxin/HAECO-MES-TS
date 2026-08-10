import { defineStore } from 'pinia';
import { sessionApi } from '../api/sessionApi.js';

export const usePermissionStore = defineStore('permission', {
  state: () => ({ permissions: [] }),
  getters: {
    permissionSet: (state) => new Set(state.permissions),
    hasPermission() {
      return (permission) => this.permissionSet.has(permission);
    },
    canBatchReplace() {
      return this.permissionSet.has('batch_replace');
    },
    canWriteConfig() {
      return this.permissionSet.has('config_write');
    },
    canWriteCapabilities() {
      return this.permissionSet.has('capability_write');
    },
  },
  actions: {
    async load() {
      const values = await sessionApi.getPermissions();
      this.permissions = [...new Set(values.filter((value) => typeof value === 'string'))];
      return this.permissions;
    },
    reset() {
      this.permissions = [];
    },
  },
});
