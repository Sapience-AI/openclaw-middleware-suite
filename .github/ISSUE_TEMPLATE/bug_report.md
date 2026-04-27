---
name: Bug Report
about: Report a bug or unexpected behavior
title: '[BUG] Brief description'
labels: 'bug'
assignees: ''
---

## Description
A clear and concise description of what the bug is.

## Steps to Reproduce
Steps to reproduce the behavior:
1. Run command: `...`
2. Configure with: `...`
3. Perform action: `...`
4. Observe issue: `...`

## Expected Behavior
A clear and concise description of what you expected to happen.

## Actual Behavior
What actually happened instead.

## Environment
- **OS**: (Windows 10, macOS, Linux)
- **Node.js version**: `node --version`
- **npm version**: `npm --version`
- **OpenClaw version**: `openclaw --version`
- **Sapience AI Suite version**: `sai --version`

## Logs
```
Paste relevant logs here
```

## Minimal Reproduction
If possible, provide a minimal example to reproduce the issue:

```bash
# Commands to reproduce
sai init
sai hitl policy --module FileSystem --method write --action ASK
# ... etc
```

## Additional Context
Add any other context about the problem here (screenshots, error messages, etc.).

## Checklist
- [ ] I've verified this issue isn't already reported
- [ ] I've included steps to reproduce
- [ ] I've included environment information
- [ ] I've checked the troubleshooting guide: [docs/troubleshooting.md](../../docs/troubleshooting.md)
