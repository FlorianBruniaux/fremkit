import { execFile } from 'node:child_process'
import { z } from 'zod'

function accountEmail(email: string | undefined): string | null {
  return email && email.length <= 320 && z.email().safeParse(email).success ? email : null
}

/** Always address the verified account explicitly; never use a browser account index. */
export function gmailThreadUrl(threadId: string, email: string | undefined): string | null {
  const account = accountEmail(email)
  if (!account || !/^[A-Za-z0-9_-]{1,256}$/.test(threadId)) return null
  const url = new URL('https://mail.google.com/mail/')
  url.searchParams.set('authuser', account)
  url.hash = 'all/' + threadId
  return url.href
}

/** Take the event token from Google's response, discarding unrelated query parameters. */
export function calendarEventUrl(value: string | undefined, email: string | undefined): string | null {
  const account = accountEmail(email)
  if (!account || !value || /[\x00-\x20\x7f\\]/.test(value)) return null
  try {
    const source = new URL(value)
    if (source.protocol !== 'https:' || !['calendar.google.com', 'www.google.com'].includes(source.hostname) || source.username || source.password || source.port || source.hash || !/^\/calendar\/(?:u\/\d+\/(?:r\/)?)?event$/.test(source.pathname)) return null
    const ids = source.searchParams.getAll('eid')
    if (ids.length !== 1 || !/^[A-Za-z0-9_-]{1,4096}={0,2}$/.test(ids[0]) || source.searchParams.getAll('authuser').length > 1) return null
    const url = new URL('https://calendar.google.com/calendar/event')
    url.searchParams.set('eid', ids[0])
    url.searchParams.set('authuser', account)
    return url.href
  } catch { return null }
}

export const openGoogleUrl = (url: string): Promise<void> => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', [url], { shell: false, timeout: 15000 }, error => error ? reject(new Error('offline')) : resolve())
})
