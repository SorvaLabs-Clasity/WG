# GitHub OAuth

How a person signs in, and what their token is used for.

## The flow

```
Login page  →  github.com/login/oauth/authorize?client_id=…&login=<you>
            ←  redirect to /auth/callback?code=…
Backend     →  exchanges the code for an access token
            →  checks you are a member of the configured org
            →  issues an app JWT holding your login and that token
```

The `login=` parameter matters. Without it, GitHub signs you in as whichever
account its cookie currently holds — so "Continue with account A" could
cheerfully authenticate you as account B. Naming the account fixes that.

## Why writes use your token

Every repository write — creating a branch, changing protection, enabling
Dependabot — is made with the token of the person who clicked.

The consequence is that **the app has no authority of its own.** If you cannot
change branch protection on a repository, neither can the app on your behalf.
There is no service account with org-admin sitting behind a button.

This is also why there is no shared service credential. One credential for
everything would mean everyone who can reach the tool has the same power as
everyone else who can, and the audit trail would say "the tool did it" rather
than naming a person.

## Session storage

The app JWT lives in `sessionStorage`, not `localStorage` — closing the window
ends the session. Your login and avatar are kept in `localStorage` so the page
can offer "Continue as …" without holding a credential.

## Signing out

Clears the local token, and the desktop app clears GitHub's cookies for its
embedded browser session, so the next sign-in genuinely asks rather than
silently reusing the last account.
