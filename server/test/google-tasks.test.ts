import { describe, expect, it } from 'vitest'
import { createGoogleTasksProvider, googleTaskUrl } from '../src/providers/google-tasks.js'
import { createGoogleClient, GOOGLE_SCOPES, parseGoogleServices, type GoogleApiClient, type GoogleIdentity } from '../src/connections/google-client.js'
import type { ConnectionServiceContext } from '../src/connections/types.js'
function context(): ConnectionServiceContext {
  const controller = new AbortController()
  return { id: 'a', serviceId: 'google-tasks', channel: 'google-tasks:a', fields: {}, secrets: {}, account: { signal: controller.signal, request: async op => op({ revision: 1, secrets: {} }, controller.signal), refresh: async () => ({ revision: 2, secrets: {} }) } }
}
const task = (id = 't1') => ({ id, title: 'Task <title>', status: 'needsAction', due: '2026-10-12T00:00:00Z', position: '1', webViewLink: 'https://tasks.google.com/task/' + id })
function harness() {
  let now = 10000, identity: GoogleIdentity | null = { subject: 'a', email: 'a@example.com', services: ['tasks'] }
  const calls: any[] = [], opened: string[] = [], responses: Record<string, unknown> = { '/users/@me/lists': { items: [{ id: 'l1', title: 'Work' }] }, '/lists/l1/tasks': { items: [task()] }, '/lists/l1/tasks/t1': task() }
  const client: GoogleApiClient = { identity: () => identity, get: async (service, path, query) => { calls.push({ service, path, query }); const value = responses[path + (query?.pageToken ? '?' + query.pageToken : '')]; if (value instanceof Error) throw value; return value } }
  const p = createGoogleTasksProvider(context(), { client, now: () => now, openUrl: async url => { opened.push(url) } })
  return { p, calls, opened, responses, tick: (ms = 1000) => { now += ms }, identity: (i: GoogleIdentity | null) => { identity = i } }
}
describe('read-only Google Tasks', () => {
  it('normalizes tasks, dates, hidden completed and subtasks without publishing remote links', async () => {
    const h = harness(); h.responses['/lists/l1/tasks'] = { items: [{ ...task(), notes: 'PRIVATE TASK NOTE' }, { ...task('child'), parent: 't1', position: '2', status: 'completed', hidden: true }, { ...task('deleted'), deleted: true }] }
    const s = await h.p.poll!()
    expect(s).toMatchObject({ connectionId: 'a', freshness: 'fresh', account: { email: 'a@example.com' }, lists: [{ id: 'l1', tasks: [{ dueDate: '2026-10-12', open: { available: true } }, { parent: 't1', position: '2', status: 'completed' }] }] })
    expect(s.lists![0].tasks).toHaveLength(2); expect(JSON.stringify(s)).not.toContain('webViewLink'); expect(JSON.stringify(s)).not.toContain('PRIVATE TASK NOTE'); expect(h.calls[1].query.fields).not.toContain('notes')
    expect(h.calls[1]).toMatchObject({ service: 'tasks', query: { showCompleted: 'true', showHidden: 'true', showDeleted: 'false', showAssigned: 'true' } })
    expect(Object.keys(h.p.commands!)).toEqual(['open'])
  })
  it('deduplicates list and task pages and discloses repeated pagination', async () => {
    const h = harness(); h.responses['/users/@me/lists'] = { items: [{ id: 'l1', title: 'Work' }], nextPageToken: 'again' };h.responses['/users/@me/lists?again'] = { items: [{ id: 'l1', title: 'Work' }], nextPageToken: 'again' }
    h.responses['/lists/l1/tasks'] = { items: [task()], nextPageToken: 'p2' };h.responses['/lists/l1/tasks?p2'] = { items: [task(), task('t2')], nextPageToken: 'p2' }
    const s = await h.p.poll!();expect(s.lists).toHaveLength(1);expect(s.lists![0].tasks).toHaveLength(2);expect(s.truncated).toBe(true);expect(s.lists![0].truncated).toBe(true)
  })
  it('preserves healthy lists and per-list stale data after one failure', async () => {
    const h = harness(); h.responses['/users/@me/lists'] = { items: [{ id: 'l1', title: 'Work' }, { id: 'l2', title: 'Personal' }] };h.responses['/lists/l2/tasks'] = { items: [task('other')] };await h.p.poll!();h.tick();h.responses['/lists/l1/tasks'] = Object.assign(new Error('PRIVATE'), { code: 'timeout' })
    const s = await h.p.poll!();expect(s.lists![0]).toMatchObject({ freshness: 'stale', error: 'timeout', tasks: [{ id: 't1', open: { available: false } }] });expect(s.lists![1].freshness).toBe('fresh');expect(JSON.stringify(s)).not.toContain('PRIVATE')
  })
  it('does not fetch missing Tasks grants and never reports unknown data as empty', async () => {
    const h = harness();h.identity({ subject: 'a', email: 'a@example.com', services: ['gmail','calendar'] });expect(await h.p.poll!()).toMatchObject({ error: 'forbidden', lists: null });expect(h.calls).toEqual([])
  })
  it('clears previous data on account identity replacement and retains stale on offline', async () => {
    const h = harness();await h.p.poll!();h.responses['/users/@me/lists'] = new Error('PRIVATE');expect(await h.p.poll!()).toMatchObject({ freshness: 'stale', lists: [{ id: 'l1' }] });h.identity({ subject: 'b', email: 'b@example.com', services: ['tasks'] });expect(await h.p.poll!()).toMatchObject({ account: { email: 'b@example.com' }, lists: null })
  })
  it('refuses remote, unknown, cross-account, arbitrary URL and stale opening; revalidates the resource', async () => {
    const h = harness();await h.p.poll!();const payload = { connectionId: 'a', listId: 'l1', taskId: 't1' }
    for (const invalid of [{ ...payload, connectionId: 'b' }, { ...payload, taskId: 'unknown' }, { ...payload, url: 'https://evil.example' }]) expect(await h.p.commands!.open(invalid, { loopback: true })).toMatchObject({ ok: false })
    expect(await h.p.commands!.open(payload, { loopback: false })).toMatchObject({ ok: false });expect(await h.p.commands!.open(payload, { loopback: true })).toEqual({ ok: true });expect(new URL(h.opened[0]).searchParams.get('authuser')).toBe('a@example.com')
    h.responses['/lists/l1/tasks/t1'] = task('different');expect(await h.p.commands!.open(payload, { loopback: true })).toMatchObject({ ok: false });h.tick(120001);expect(await h.p.commands!.open(payload, { loopback: true })).toMatchObject({ ok: false });expect(h.opened).toHaveLength(1)
  })
  it('coalesces concurrent polls and discards a late response after stop or identity change', async () => {
    for (const stop of [true,false]) {
      let release!: (v: unknown) => void, subject = 'a', calls = 0
      const p = createGoogleTasksProvider(context(), { client: { identity: () => ({ subject, email: subject+'@example.com', services: ['tasks'] }), get: async () => {calls++;return new Promise(r=>{release=r})} } })
      const one = p.poll!(), two = p.poll!();if(stop)p.stop!();else subject='b';release({items:[]});expect((await one).lists).toBeNull();expect(await two).toEqual(await one);expect(calls).toBe(1)
    }
  })
  it('uses only the read-only scope and closed Tasks API GET routes; Gmail remains granted independently', async () => {
    expect(parseGoogleServices('["gmail","calendar","tasks"]')).toEqual(['gmail','calendar','tasks']);expect(GOOGLE_SCOPES.tasks).toEqual(['https://www.googleapis.com/auth/tasks.readonly'])
    const ctx=context();ctx.fields={clientId:'test.apps.googleusercontent.com',services:'["gmail","tasks"]'};ctx.secrets={credentials:JSON.stringify({version:1,clientId:ctx.fields.clientId,accessToken:'fixture',refreshToken:'fixture',expiresAt:9999999999999,subject:'a',email:'a@example.com',scopes:GOOGLE_SCOPES.gmail})};ctx.account.request=async op=>op({revision:1,secrets:ctx.secrets},ctx.account.signal)
    const urls:string[]=[];const client=createGoogleClient(ctx,{fetch:async(input:string|URL|Request)=>{urls.push(String(input));return Response.json({items:[]})}})
    expect(client.identity()?.services).toEqual(['gmail']);await expect(client.get('tasks','/users/@me/lists')).rejects.toMatchObject({code:'forbidden'});expect(urls).toEqual([])
    const b=JSON.parse(ctx.secrets.credentials);b.scopes.push(...GOOGLE_SCOPES.tasks);ctx.secrets={credentials:JSON.stringify(b)}
    await client.get('tasks','/users/@me/lists');expect(urls[0]).toBe('https://tasks.googleapis.com/tasks/v1/users/@me/lists')
    for(const path of ['/users/me/messages','/lists/../tasks','https://evil.example/tasks','/lists/l1/clear']) await expect(client.get('tasks',path)).rejects.toMatchObject({code:'malformed'})
  })
  it('caps task pagination at three pages and list requests at fifty lists',async()=>{
    const h=harness();h.responses['/users/@me/lists']={items:Array.from({length:50},(_,i)=>({id:'l'+i,title:'List '+i})),nextPageToken:'more'}
    for(let i=0;i<50;i++)h.responses['/lists/l'+i+'/tasks']={items:[]}
    h.responses['/lists/l1/tasks']={items:Array.from({length:100},(_,i)=>task('t'+i)),nextPageToken:'p2'}
    h.responses['/lists/l1/tasks?p2']={items:Array.from({length:100},(_,i)=>task('t'+(i+100))),nextPageToken:'p3'}
    h.responses['/lists/l1/tasks?p3']={items:Array.from({length:100},(_,i)=>task('t'+(i+200))),nextPageToken:'p4'}
    const s=await h.p.poll!();expect(s.lists).toHaveLength(50);expect(s.truncated).toBe(true);expect(s.lists!.find(l=>l.id==='l1')).toMatchObject({truncated:true});expect(s.lists!.find(l=>l.id==='l1')!.tasks).toHaveLength(300);expect(h.calls).toHaveLength(53)
  })
  it('accepts only trusted Google Tasks UI links', () => {
    expect(googleTaskUrl('https://tasks.google.com/task/t1?authuser=0','a@example.com')).toContain('authuser=a%40example.com')
    expect(googleTaskUrl('https://calendar.google.com/calendar/u/0/r/tasks/task/t1?authuser=0','a@example.com')).toBe('https://calendar.google.com/calendar/r/tasks/task/t1?authuser=a%40example.com')
    expect(googleTaskUrl('https://tasks.google.com/u/0/task/t1','a@example.com')).toBe('https://tasks.google.com/task/t1?authuser=a%40example.com')
    for(const url of ['http://tasks.google.com/task/t1','https://tasks.google.com.evil.example/task/t1','https://a:secret@tasks.google.com/task/t1','https://calendar.google.com/calendar/r/eventedit','https://tasks.google.com:444/task/t1','javascript:alert(1)'])expect(googleTaskUrl(url,'a@example.com')).toBeNull()
  })
})
