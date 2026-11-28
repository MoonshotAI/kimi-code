import { ipcMain } from 'electron';
import { asSystemPermissionsQuery, isSystemPermissionId } from '@moonshot-ai/app-core/system-permissions';
import {
  getSystemPermissions,
  openSystemPermissionSettings,
  requestSystemPermission,
} from '../../system/permissions-service';
import { IPC } from '../ipc-channels';
import { isMainRendererSender } from '../sender';

export function registerSystemPermissionsIpc(): void {
  ipcMain.handle(IPC.systemPermissionsGetAll, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('system-permissions: unknown sender');
    return getSystemPermissions(asSystemPermissionsQuery(payload));
  });
  ipcMain.handle(IPC.systemPermissionsRequest, (event, id: unknown, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('system-permissions: unknown sender');
    if (!isSystemPermissionId(id)) throw new Error('system-permissions: invalid permission id');
    return requestSystemPermission(id, asSystemPermissionsQuery(payload));
  });
  ipcMain.handle(IPC.systemPermissionsOpenSettings, (event, id: unknown, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('system-permissions: unknown sender');
    if (!isSystemPermissionId(id)) throw new Error('system-permissions: invalid permission id');
    return openSystemPermissionSettings(id, asSystemPermissionsQuery(payload));
  });
}
