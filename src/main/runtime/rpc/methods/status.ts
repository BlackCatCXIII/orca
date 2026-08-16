import { defineMethod, type RpcMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime, pairedDeviceId, operatorRecipeCatalog }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      return {
        ...runtime.getStatus(),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        ...(operatorRecipeCatalog ? { operatorRecipeCatalog: operatorRecipeCatalog.status } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  })
]
