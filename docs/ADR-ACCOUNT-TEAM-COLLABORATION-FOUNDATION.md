# ADR: Account, Team, Collaboration Foundation

Date: 2026-09-16

FastWrite keeps the workspace source tree as the authoritative manuscript. Collaboration state is an editing transport and must be flushed into a versioned workspace revision before compile, review, agent, ChangeSet, history, or GitHub operations read it.

The initial implementation keeps `JsonDatabase` as the single-machine repository and introduces explicit identity, authorization, team, invitation, audit, and session records. These records form the repository boundary for a PostgreSQL implementation: application services do not infer ownership from browser state or email addresses. External identities use immutable `(issuer, subject)` keys; local login uses the `fastwrite:local` issuer. Email is a mutable contact attribute.

Local accounts use Argon2id through `Bun.password`. Session tokens are random 256-bit bearer credentials and only SHA-256 token hashes are persisted. A production deployment must move access and refresh tokens to short-lived, rotating HttpOnly cookies; the bearer API exists for desktop/loopback and integration clients. Disabling an account revokes all stored sessions.

Project authorization is capability based. Project roles map to capabilities in `AuthorizationService`; server routes must call that service rather than relying on hidden client controls. `FASTWRITE_SERVER_AUTH=true` enables authorization enforcement for existing project endpoints while installations migrate legacy projects. New account-created projects record a personal owner and an immutable owner membership.

Feature flags:

- `FASTWRITE_SERVER_AUTH`: require authenticated project access.
- `FASTWRITE_TEAMS`: expose team-owned project creation after the migration path is enabled.
- `FASTWRITE_SCOPED_HARNESS`: resolve system/team/personal profiles rather than legacy runtime settings.
- `FASTWRITE_REALTIME_V2`: use authenticated binary Yjs rooms and persistence.
- `FASTWRITE_COMMENTS_V2`: use account-based relative-position comment threads.
- `FASTWRITE_PWA_OFFLINE`: enable IndexedDB update queues after reconnect and authorization E2E validation.

OIDC and CAS remain adapters behind an `IdentityProvider` port. Neither protocol may be used directly by workspace, authorization, or Harness services. PostgreSQL/object storage, Redis fan-out, and persisted Yjs update logs replace the single-process JSON and WebSocket prototypes only behind their corresponding repository/provider interfaces.
