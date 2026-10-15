/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import GoogleConnectionForm from '../src/admin/GoogleConnectionForm.vue'
import { setLocale } from '../src/shared/i18n'
const save = vi.hoisted(()=>vi.fn(async()=>{}))
vi.mock('../src/admin/connections',async original=>({...await original<typeof import('../src/admin/connections')>(),useConnectionsStore:()=>({save,state:{busy:false,error:''}})}))
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
it('connects through system-browser endpoint with masked secret and no credential editor',async()=>{
  setLocale('en')
  const calls:Array<{url:string;body?:string}>=[]
  vi.stubGlobal('fetch',async(url:string,init?:RequestInit)=>{calls.push({url,body:init?.body as string});return Response.json({state:url.endsWith('/connect')?'pending':'disconnected'})})
  const w=mount(GoogleConnectionForm,{props:{id:'a',connection:null}})
  expect(w.find('[name="credentials"]').exists()).toBe(false)
  await w.get('[name="clientId"]').setValue('test.apps.googleusercontent.com')
  await w.get('[name="clientSecret"]').setValue('fake-client-secret')
  expect(w.get('[name="clientSecret"]').attributes('type')).toBe('password')
  await w.get('[data-action="connect"]').trigger('click');await flushPromises()
  expect(save.mock.calls[0]).toMatchObject(['a',{type:'google',fields:{services:'["gmail","calendar"]'}}])
  expect(JSON.stringify(save.mock.calls)).not.toContain('fake-client-secret')
  expect(JSON.parse(calls.find(c=>c.url.endsWith('/connect'))!.body!)).toEqual({clientSecret:'fake-client-secret'})
  expect((w.get('[name="clientSecret"]').element as HTMLInputElement).value).toBe('')
  expect(w.text()).toContain('Waiting for Google')
  await w.get('[data-action="cancel-oauth"]').trigger('click');await flushPromises()
  expect(calls.some(c=>c.url.endsWith('/cancel'))).toBe(true)
  w.unmount()
})
it.each(['en','fr'] as const)('renders partial grants and explicit local disconnect in %s',async language=>{
  setLocale(language)
  vi.stubGlobal('fetch',async()=>Response.json({state:'partial',email:'a@example.com',services:['gmail'],error:'partial'}))
  const w=mount(GoogleConnectionForm,{props:{id:'a',connection:{id:'a',type:'google',name:'A',fields:{clientId:'test.apps.googleusercontent.com',services:'["gmail","calendar"]'},secrets:{credentials:true}}}})
  await flushPromises()
  expect(w.text()).toContain('a@example.com');expect(w.text()).not.toContain('google.error.')
  expect(w.find('[data-action="disconnect"]').exists()).toBe(true)
  expect(w.get('[data-action="connect"]').text()).toMatch(/Reconnect/)
  w.unmount()
})

it('cancels consent when the form closes before the start response arrives',async()=>{
  let release!:(r:Response)=>void
  const pending=new Promise<Response>(r=>{release=r})
  const calls:string[]=[]
  vi.stubGlobal('fetch',async(url:string)=>{calls.push(url);return url.endsWith('/connect')?pending:Response.json({state:'disconnected'})})
  const w=mount(GoogleConnectionForm,{props:{id:'a',connection:null}})
  await w.get('[name="clientId"]').setValue('test.apps.googleusercontent.com')
  await w.get('[data-action="connect"]').trigger('click');await flushPromises()
  w.unmount();release(Response.json({state:'pending'}));await flushPromises()
  expect(calls).toContain('/api/connections/a/google/cancel')
})
