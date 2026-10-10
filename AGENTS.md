# Repository notes

- `flowstate/` and `flowtasks/` are independent Paseo plugins. Keep their runtime code and dependencies separate.
- The example workflow lives in `.paseo/flowstate.yml`.
- Run `npm run typecheck` and relevant tests (`npm test`) in each changed plugin directory. Reload changed plugins with `paseo plugin reload <id>`; do not restart the daemon.
- Keep plugin UI compatible with React Native and use Paseo theme colors.
