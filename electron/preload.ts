import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jdDownloader', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
  getOutputRoot: () => ipcRenderer.invoke('settings:get-output-root') as Promise<string>,
  selectOutputRoot: () => ipcRenderer.invoke('settings:select-output-root') as Promise<string>,
  listPlatforms: () => ipcRenderer.invoke('auth:list-platforms'),
  loginPlatform: (platformId: string) => ipcRenderer.invoke('auth:login', platformId),
  refreshPlatformAuth: (platformId: string) =>
    ipcRenderer.invoke('auth:refresh-status', platformId),
  clearPlatformAuth: (platformId: string) => ipcRenderer.invoke('auth:clear', platformId),
  importExcelLinks: (platformId: string, selectedTypes?: string[], downloadPolicy?: unknown, mode?: string) =>
    ipcRenderer.invoke('import:excel-links', platformId, selectedTypes, downloadPolicy, mode),
  exportExcelTemplate: () => ipcRenderer.invoke('import:export-template'),
  validateLinks: (platformId: string, rawInput: string) =>
    ipcRenderer.invoke('task:validate-links', platformId, rawInput) as Promise<{
      total: number;
      validLinks: string[];
    }>,
  addLinks: (platformId: string, rawInput: string, selectedTypes?: string[], downloadPolicy?: unknown, mode?: string) =>
    ipcRenderer.invoke('task:add-links', platformId, rawInput, selectedTypes, downloadPolicy, mode),
  listTasks: () => ipcRenderer.invoke('task:list'),
  startTasks: () => ipcRenderer.invoke('task:start'),
  retryFailed: () => ipcRenderer.invoke('task:retry-failed'),
  clearCompleted: () => ipcRenderer.invoke('task:clear-completed'),
  clearFailed: () => ipcRenderer.invoke('task:clear-failed'),
  removeTask: (taskId: string) => ipcRenderer.invoke('task:remove', taskId),
  openOutput: (taskId: string) =>
    ipcRenderer.invoke('task:open-output', taskId) as Promise<{
      ok: boolean;
      errorMessage?: string;
    }>,
});
