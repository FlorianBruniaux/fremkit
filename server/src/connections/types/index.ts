import { azureDevOpsType } from './azure-devops.js'
import { bambuType } from './bambu.js'
import { githubType } from './github.js'
import { createGoogleType } from './google.js'
import { createGmailProvider } from '../../providers/gmail.js'
import { createGoogleCalendarProvider } from '../../providers/google-calendar.js'
import { createGoogleTasksProvider } from '../../providers/google-tasks.js'
import { icsType } from './ics.js'
import { synologyType } from './synology.js'
import type { ConnectionType } from '../types.js'

/** Every connection type the server ships with. */
export function defaultConnectionTypes(): ConnectionType[] {
  return [azureDevOpsType, bambuType, githubType, icsType, synologyType, createGoogleType([
    { id: 'gmail', channelPrefix: 'gmail', createProvider: createGmailProvider },
    { id: 'google-calendar', channelPrefix: 'google-calendar', createProvider: createGoogleCalendarProvider },
    { id: 'google-tasks', channelPrefix: 'google-tasks', createProvider: createGoogleTasksProvider },
  ])]
}
