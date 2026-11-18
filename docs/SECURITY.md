# Security and private data

This repository is public. It contains code, the database schema, generic formulas and fictional examples only.

- **Access.** Team members sign in with Google. Only approved accounts get a session, and approval is checked on every request, so removing someone takes effect immediately. If the app is not fully configured, it refuses every request; there is no anonymous mode.
- **Data.** Partner records, prices, costs, revenue, contacts and file locations are stored in a private database. They are never in the repository or the browser bundle. Each build runs an automated check that fails if it finds private values.
- **Automated inputs.** The order collector and the Slack scanner each use their own credential, which works only for its own import. Imports are validated, logged and safe to repeat.
- **Uploads.** Spreadsheet and CSV uploads are size-checked and validated, and the user previews them before saving. Files are never executed or stored.
- **Audit.** Every change records who made it and when.

Configuration, limits, data migration and rollback steps are kept in the team's private operator guide. Report a security concern to the repository owner privately rather than in a public issue.
