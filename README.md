# averyrpeterson-plugins

Claude Code plugin marketplace.

```
/plugin marketplace add AveryRPeterson/claude-plugins
/plugin install escalation-ladder@averyrpeterson-plugins
```

## Plugins
- **escalation-ladder** — tiered model escalation (scout → worker → senior → oracle) with loop detection,
  circuit breakers and review passes. `/ladder pane` opens a live status pane.

## Development
The dev working copy lives in `~/.claude/dev-mods/*/escalation-ladder` until testing moves here.
`scripts/sync-from-dev.sh` mirrors it in (excluding `node_modules` and generated types);
`scripts/sync-from-dev.sh --check` reports drift.

## License
MIT © Avery R. Peterson — copyright notice must be retained in copies and derivatives.
