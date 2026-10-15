import { expect, it } from 'vitest'
import { ConnectionManager } from '../src/connections/manager.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { createGoogleType } from '../src/connections/types/google.js'

it('guards OAuth commit within the manager queue against A-B-A and recreation', async () => {
  const values = new Map<string,string>()
  const manager = new ConnectionManager({ registry:new ProviderRegistry(()=>{}), types:new ConnectionTypeRegistry([createGoogleType([{ id:'gmail',channelPrefix:'gmail',createProvider:ctx=>({channel:ctx.channel}) }])]), secrets:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v)},delete:async k=>{values.delete(k)}} })
  const c = { id:'a',type:'google',name:'A',fields:{clientId:'test.apps.googleusercontent.com',services:'["gmail"]'} }
  await manager.sync([c]); const old = manager.captureGeneration('a')
  await manager.sync([{...c,fields:{...c.fields,services:'["calendar"]'}}]); await manager.sync([c])
  let quarantined = 0
  const transaction = { quarantine:async()=>{quarantined++},commit:async()=>{},rollback:async()=>{} }
  await expect(manager.updateSecretsIfCurrent(c,old,{credentials:'late'},transaction,()=>true)).rejects.toThrow('retired')
  expect(quarantined).toBe(0);expect(values.size).toBe(0)
  const recreated = manager.captureGeneration('a');await manager.forget(c);await manager.sync([c])
  await expect(manager.updateSecretsIfCurrent(c,recreated,{credentials:'late'},transaction,()=>true)).rejects.toThrow('retired')
  const live = manager.captureGeneration('a')
  await manager.updateSecretsIfCurrent(c,live,{credentials:'current'},transaction,()=>true)
  expect(quarantined).toBe(1);expect(values.get('a/credentials')).toBe('current')
})
