# Local Docker and model observations

Fremkit publishes two optional read-only channels when a dashboard widget subscribes to them. Their widgets are distributed through the registry, not bundled with the core. Neither channel starts a container or a model.

## Docker

`docker-local` reads the currently selected Docker context through the fixed local CLI path `/usr/local/bin/docker`. It accepts only a Unix socket endpoint. A TCP or SSH context returns `remote-context` and no container list. The channel lists up to 200 containers and requests one bounded stats sample for running containers. CPU and memory fields come from Docker; missing stats remain absent. A failed refresh keeps the last successful snapshot marked stale.

The helper needs access to the local Docker socket. This channel does not issue start, stop, remove or exec commands.

## Local models

`local-models` asks the Ollama daemon on `127.0.0.1:11434` for installed and currently loaded models. It also lists selected local MLX or oMLX server processes with their observed CPU and resident memory. A loaded model or detected server process does not prove that inference is currently running. Each source has its own freshness and error state, so an unavailable Ollama daemon does not hide an observed MLX process.

The HTTP response is bounded to 1 MiB, redirected responses are refused, and the process list is capped. No model prompts or responses are read.
