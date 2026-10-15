# Google accounts

Create one Google connection per account in **Administration → Connections**. Each connection keeps its own identity, service grants and credentials. Connecting opens the Mac’s system browser; the embedded dashboard does not handle Google sign-in. A desktop OAuth client is required before connecting.

## Prepare Google Cloud

1. Open [Google Cloud Console](https://console.cloud.google.com/), sign in, and create or select a project for your Fremkit installation. Keep this project selected throughout setup.
2. Under **APIs & Services → Library**, find **Gmail API** and **Google Calendar API** and enable the APIs for the services you intend to use.
3. Open **Google Auth Platform → Branding**. Configure the app name, user support email and developer contact information. Under **Audience**, choose the audience appropriate to your account. For a personal Gmail account, use **External**. While the app is in **Testing**, add each account you intend to connect as a test user. An **Internal** audience is limited to the relevant Google Workspace organization. Follow the [consent setup instructions](https://developers.google.com/workspace/guides/configure-oauth-consent).
4. Under **Data Access**, configure the service scopes listed below for your selected services. Leave unrelated permissions unselected.
5. Under **Clients → Create client**, select **Desktop app**, give the client a recognizable name and create it. Copy the client ID. If Google supplies a client secret, copy that too. The optional downloaded JSON contains credentials: keep it private. The [desktop credential instructions](https://developers.google.com/workspace/guides/create-credentials#desktop-app) describe this client type.

Fremkit uses a temporary loopback callback on `127.0.0.1`, with an available port selected per attempt. The consent flow uses PKCE and expires after five minutes. Google documents the [installed application flow](https://developers.google.com/identity/protocols/oauth2/native-app), including loopback callbacks and system-browser requirements.

## Choose services and connect

In Administration, add **Google**, enter a name, paste the desktop client ID and enter its client secret if supplied. Select Gmail, Calendar or both. Press **Connect with Google**, select the intended account in the system browser and review the permissions. Return to Administration to check the verified email and the services actually granted.

| Selection | OAuth scopes |
| --- | --- |
| Account identity | `openid`, `email` |
| Gmail | `https://www.googleapis.com/auth/gmail.metadata` |
| Calendar | `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events.readonly` |

Gmail metadata grants access to headers and labels without message bodies or attachments. Google classifies this scope as restricted, so public distribution has verification requirements. See [Gmail scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes). Calendar grants cover the calendar list and event reads; see [Calendar scope definitions](https://developers.google.com/workspace/calendar/api/auth).

After authorization, **Calendars to display** lists this account’s calendars with checkboxes. Select calendars and press **Save**. No selection uses the primary calendar. The advanced **Calendar IDs** field also accepts a JSON array. `[]` selects the primary calendar. For another calendar, copy its ID from Google Calendar settings and enter, for example, `["team@example.com"]`. Choosing calendars controls which calendars Fremkit reads; the OAuth event scope itself covers calendars the account can access.

For a second account, create another Google connection and repeat consent. The desktop client can be reused. Reconnecting an existing connection requires the same verified Google subject. Choosing another account produces an explicit error and preserves the existing credentials.

Google’s installed-app flow does not support incremental authorization. To add a service, select the complete desired set and reconnect. A partial grant is displayed as partial; refused services remain unavailable. **Authorization stored** confirms a saved grant, while each provider checks service availability when it reads data.

## Renewal, cancellation and removal

**Cancel authorization** closes the temporary listener. Closing the form also cancels an attempt still shown as pending. Restarting Fremkit discards pending attempts; saved credentials remain in SecretStore. The service client coordinates refreshes across Gmail and Calendar for the same account.

External apps with publishing status **Testing** receive refresh tokens that expire after seven days when requesting these service scopes. The identity-only exception does not apply. Reconnect after expiry. Publishing status, verification requirements and Workspace approval are separate considerations; see Google’s [refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

Workspace policy can refuse authorization even when Cloud setup is correct. Ask the Workspace administrator about the configured OAuth client and requested scopes. A refused consent, expired grant, unavailable service or rate limit is an error, not an empty account.

**Disconnect locally** removes the access token, refresh token and desktop client secret from Fremkit and stops authorized API access for that connection. Its verified identity remains in the same secret item, so reconnecting still requires the original account. Re-enter the desktop client secret if Google supplied one. Delete and recreate the connection to choose a different account. It does not revoke the grant at Google. To revoke access remotely, use your Google Account’s third-party access controls. Revocation can affect other installations or connections using the same account and OAuth client. Delete the Fremkit connection when you want its configured account and service data removed.

Credentials, including verified identity, tokens and the desktop client secret, occupy one SecretStore item. The normal connections API and configuration exports contain no credential values. Tests use fake Google responses and temporary data. Actual consent, Workspace behavior and renewal across real accounts require an explicit live validation with a user-provided desktop client.
