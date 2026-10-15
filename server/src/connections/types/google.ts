import type { ConnectionService, ConnectionType } from '../types.js'
import { grantedGoogleServices, parseCalendarIds, parseGoogleCredentials, parseGoogleServices } from '../google-client.js'
import { tr } from '../../i18n.js'

export function createGoogleType(services: ConnectionService[]): ConnectionType {
  return {
    id: 'google', name: 'Google', icon: 'mail',
    description: { en: 'Gmail metadata and Google Calendar, authorized separately for each account.', fr: 'Métadonnées Gmail et Google Agenda, autorisés séparément pour chaque compte.' },
    fields: [
      { key: 'clientId', label: { en: 'Desktop OAuth client ID', fr: 'Identifiant client OAuth pour ordinateur' }, required: true },
      { key: 'services', label: { en: 'Selected services', fr: 'Services sélectionnés' }, required: true },
      { key: 'calendarIds', label: { en: 'Calendar IDs (JSON array)', fr: 'Identifiants des agendas (tableau JSON)' } },
      { key: 'color', label: { en: 'Colour', fr: 'Couleur' }, color: true },
      { key: 'credentials', label: 'OAuth', secret: true },
    ],
    services,
    async test(fields, secrets) {
      try {
        const selected = parseGoogleServices(fields.services)
        parseCalendarIds(fields.calendarIds)
        const bundle = parseGoogleCredentials(secrets.credentials)
        if (!bundle || bundle.clientId !== fields.clientId) return { ok: false, error: tr(undefined, 'google.reconnect') }
        if (grantedGoogleServices(bundle, selected).length !== selected.length) return { ok: false, error: tr(undefined, 'google.partial') }
        return { ok: true, detail: tr(undefined, 'google.stored') }
      } catch { return { ok: false, error: tr(undefined, 'google.malformed') } }
    },
  }
}
