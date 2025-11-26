# CWO-AUTH-03 — Admin Role, Login, and User/Role Management Panel

## Context

Repo: Brain (CodeCrafter Office Manager)
Stack: Flask + Postgres (SQLAlchemy), sessions, existing login page + roles concept, admin key already set in environment:

```
ADMIN_KEY=...
SECRET_KEY=...          # or FLASK_SECRET_KEY
SUPERVISOR_KEY=...      # optional, already in use
```

Goal: Turn the “admin” concept into a working system:
- Logging in with ADMIN_KEY gives you Admin role.
- Admin can manage users and roles in Postgres.
- Create/update users with roles: admin, supervisor, refueler, viewer.
- Nav clearly shows when you’re logged in and as what.
- All admin/user routes protected with `@require_role("admin")`.

## Acceptance Criteria
- Admin login
  - Visiting `/login` and entering the correct `ADMIN_KEY` logs you in as:
    - `session["role"] == "admin"`
    - `session["display_name"] == "Admin (key)"`
  - Nav shows: Admin (admin) and a Logout link.
  - Nav shows an Admin link to `/admin/users`.
- User & role management
  - `/admin/users` lists all users and their roles (Admin only).
  - `/admin/users/new` allows Admin to create users with roles admin, supervisor, refueler, viewer.
  - `/admin/users/<id>/edit` allows Admin to:
    - Change role.
    - Set a new password (or leave empty to keep existing).
- Access control
  - Only admins (via key or DB user) can access `/admin/users*`.
  - Existing `@require_role("supervisor")` and similar checks are satisfied by both supervisor and admin.
  - Non-admins don’t see Admin nav link and are blocked if they type `/admin/users` directly.
- Integration
  - `current_user`, `current_role`, and `display_name` are available in templates.
  - `window.CURRENT_ROLE` is available in JS for role-aware voice commands later.
  - Voice, Know/Build/Fix, and other flows continue to work without regression.
