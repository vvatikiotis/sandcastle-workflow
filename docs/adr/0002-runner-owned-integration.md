# Runner-owned Integration; agents never mount the main working tree

No agent mounts the Consumer Repository's main working tree. The runner owns Integration: it rebases, verifies, fast-forwards the Base Branch and closes the issue. When Integration fails, the Reporter only explains why and a human decides. We chose this over an agent that resolves conflicts and fixes failures. It trades autonomy for a main checkout that no agent can damage, and for verification the runner runs itself instead of taking an agent's word for it.
