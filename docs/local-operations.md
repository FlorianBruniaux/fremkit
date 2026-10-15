# Local Docker and model observations

Fremkit publishes two read-only channels only while a dashboard widget subscribes. Their widgets live in the registry. Neither channel starts a container or a model.

## Docker

`docker-local` resolves Docker from `/opt/homebrew/bin/docker`, `/usr/local/bin/docker` or `~/.docker/bin/docker`, then reads the selected context. Only a local Unix socket is accepted; TCP and SSH contexts return `remote-context`. A missing executable returns `unavailable`; a stopped daemon or failed query returns `offline`; malformed data returns `invalid`. The snapshot is `{data, stale, error, updatedAt}`. When no successful snapshot exists, `data` is null and `stale` is false. A later failure retains the previous data with `stale: true`.

`data.containers` contains at most 200 records. Each record has `id`, `name`, `image`, `state`, `status` and `stats`. The optional `stats` object contains Docker's `cpu`, `memory`, `memoryPercent`, `pids`, `netIO` and `blockIO` strings. It is null for stopped containers and whenever stats cannot be collected. A container that stops after listing does not blank the rest of the snapshot. No commands, environment, labels, mounts or ports are published.

The helper needs access to the local Docker socket. This channel cannot start, stop, remove or execute a container.

## Local models

`local-models` reads Ollama on `127.0.0.1:11434` and selected local MLX or oMLX server processes. Its snapshot has independent `installed`, `loaded` and `mlx` parts, each with `{data, stale, error, updatedAt}`. `installed` and `loaded` contain at most 200 Ollama model records with `name`, `size`, `size_vram`, `context_length` and `expires_at`. `mlx` contains at most 20 process records with `pid`, `backend`, a path-free `model` label, `port`, `cpu` and `memoryBytes`. A missing or stopped Ollama daemon returns `offline` on its two parts without hiding MLX processes. Invalid Ollama JSON returns `invalid`.

A listed model or process does not prove inference is running. HTTP responses are limited to 1 MiB, redirects are refused, and no prompts or responses are read.
