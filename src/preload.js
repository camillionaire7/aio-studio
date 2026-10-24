'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  // converter
  convert: (text, groupName) => ipcRenderer.invoke('convert', { text, groupName }),
  save: () => ipcRenderer.invoke('save'),
  // history + launching Hayha / Polar
  historyGet: call('history:get'),
  historyClear: call('history:clear'),
  historyShow: call('history:show'),
  historyEditor: call('history:editor'),
  appsStatus: call('apps:status'),
  appsLaunch: call('apps:launch'),
  appsChoose: call('apps:choose'),
  appsClear: call('apps:clear'),
  // backup / restore / wipe (Settings)
  dataBackup: call('data:backup'),
  dataRestorePrepare: call('data:restorePrepare'),
  dataRestoreApply: call('data:restoreApply'),
  dataRestoreCancel: call('data:restoreCancel'),
  dataWipe: call('data:wipe'),
  // vault
  states: call('meta:states'),
  vaultGet: call('vault:get'),
  vaultAddAddress: call('vault:addAddress'),
  vaultUpdateAddress: call('vault:updateAddress'),
  vaultDeleteAddress: call('vault:deleteAddress'),
  vaultAddCard: call('vault:addCard'),
  vaultBulkCards: call('vault:bulkCards'),
  vaultDeleteCard: call('vault:deleteCard'),
  vaultSetUsed: call('vault:setUsed'),
  vaultAddDomain: call('vault:addDomain'),
  vaultDeleteDomain: call('vault:deleteDomain'),
  vaultAddAccount: call('vault:addAccount'),
  vaultBulkAccounts: call('vault:bulkAccounts'),
  vaultDeleteAccount: call('vault:deleteAccount'),
  vaultExportAccounts: call('vault:exportAccounts'),
  vaultSetAccountUsed: call('vault:setAccountUsed'),
  vaultRemoveJig: call('vault:removeJig'),
  vaultClearJigs: call('vault:clearJigs'),
  vaultReorder: call('vault:reorder'),
  vaultRenameGroup: call('vault:renameGroup'),
  vaultDeleteAll: call('vault:deleteAll'),
  vaultDeleteGroup: call('vault:deleteGroup'),
  // editor
  editorImport: call('editor:import'),
  editorJig: call('editor:jig'),
  editorUpdateProfile: call('editor:updateProfile'),
  editorReset: call('editor:reset'),
  editorFix: call('editor:fix'),
  editorDeleteProfile: call('editor:deleteProfile'),
  editorMerge: call('editor:merge'),
  editorRename: call('editor:rename'),
  editorSetSite: call('editor:setSite'),
  editorDelete: call('editor:delete'),
  editorExport: call('editor:export'),
  builderToEditor: call('builder:toEditor'),
  // builder
  builderGenerate: call('builder:generate'),
  builderExport: call('builder:export'),
});
