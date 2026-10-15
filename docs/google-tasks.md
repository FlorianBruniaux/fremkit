# Google Tasks service

The Google connection can request the read-only Tasks scope alongside Gmail and Calendar. Enable the Google Tasks API in the same Google Cloud project and add the Tasks scope in the OAuth consent configuration. Reconnect each account to grant the new service; an existing Gmail or Calendar grant does not silently authorize Tasks.

Each connected account publishes `google-tasks:<connectionId>` only when Tasks was selected and granted. The provider reads task lists and their tasks with bounded pagination and exposes a separate snapshot for every account. It distinguishes a successful empty list from unavailable data, preserves the last good snapshot as stale after an error, and never publishes task notes. The service cannot create, update or complete tasks.

The provider validates task IDs and a fresh account snapshot before an optional Open command. Opening uses a supported Google Tasks URL only; unsupported destinations return a reason instead of guessing a browser account. The API and destination tests use controlled responses. Real account consent, browser-account routing and XENEON touch behavior require validation on a connected installation.
