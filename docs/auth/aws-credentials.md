# AWS credentials

The app needs AWS before it can do anything, because its configuration and its
GitHub secrets live there.

## Desktop

Three ways in, offered on the sign-in page:

| Method | What it does |
|---|---|
| **SSO** | Runs `aws sso login --profile <name>` and waits for the browser |
| **Profile** | Uses an existing profile from `~/.aws/config` |
| **Access keys** | Pasted directly, held in memory for the session. A **region is required** |

The chosen profile is remembered in `~/.github-control-hub/desktop.json` and
restored at startup, so a still-valid SSO session simply connects.

What is remembered, and what is not:

- **Only profiles that worked.** Written after DynamoDB actually answered, not
  when the name was typed, otherwise a typo becomes the suggestion forever.
- **Forgotten on sign-out**, so the next launch does not silently reconnect to
  an account you deliberately left.
- **Never any secret.** A profile name is the name of a section in a file you
  already have. Keys and tokens are not written there, and a test asserts it.
- **An explicit `AWS_PROFILE` wins**, because someone setting it is being
  deliberate.

## Lambda

No profiles. Each function, `webhook-receiver`, `webhook-worker`, the
guardrail engine, gets its own execution role and reads its own credentials
from the Lambda runtime, scoped to exactly what that function needs. See
[Lambda](../infrastructure/lambda.md).

## What AWS access buys

Reading DynamoDB (the app's own tables) and Secrets Manager (GitHub secrets).
It is *not* how the AWS guardrails reach other accounts. Those assume a role.
See [AWS guardrails](../aws-guardrails/).

## Access keys need a region

A key pair carries no region, and the block the AWS access portal puts on your
clipboard does not include one either — its "Command line or programmatic
access" dialog gives the key id, the secret and the session token and stops.

Underneath the field there is only `BOOT_REGION`, the region the process was
launched with, and that is undefined on every desktop launch. So a blank region
meant the SDK had none at all and the first call failed with

```
Region is missing
```

which names the SDK rather than the empty box on the form. Both forms require
it now, and the paste form has the field at all, which it did not.

It is filled in rather than merely demanded: a block copied out of a
credentials file carries `region` and that is read, and a process that has
already connected offers the region it connected to. Neither overwrites
something typed.

A process *launched* with `AWS_REGION` may still omit it — that is a choice the
operator made for the machine, and it is the same answer they would have got
without switching accounts.

## Which config file

Not always `~/.aws/config`. `AWS_CONFIG_FILE` moves it, and
`AWS_SHARED_CREDENTIALS_FILE` moves the other one — both are resolved the way
every AWS SDK and the CLI resolve them, in `services/awsConfigFile.ts`, and
every part of this app that lists, reads or writes a profile goes through it.

That is not tidiness. When the list and the writer used `~/.aws/config` while
the region lookup honoured the variable, a machine with it set listed profiles
from one file and *wrote* new ones into it while the CLI read another. The
profile existed, the screen said so, and `aws sso login --profile <it>` could
not find it.

The sign-in page names the file it read, under "No SSO profiles on this
machine yet". If that path is not the one you expect, that is the answer.

## "No SSO profiles" on Windows

Three causes, and the sign-in page now tells them apart rather than showing the
same empty list for all of them.

**The file is UTF-16.** PowerShell 5.1 — still the default `powershell.exe` —
writes UTF-16LE for `> config` and for `Set-Content` with no `-Encoding`. Read
as UTF-8 that is mojibake rather than an error, so no section header matches
and the honest report is "no profiles". The AWS CLI cannot read it either, and
says so in the one message that names nothing useful:

```
aws: [ERROR]: Unable to parse config file: C:\Users\<name>/.aws/config
```

(The mixed separators in that path are normal. botocore expands its default
`~/.aws/config` with `os.path.expanduser`, which keeps the forward slashes. It
looks like the bug and is not one.)

The app decodes UTF-16 now, so the profiles appear — but it will refuse to
*write* a new one into such a file, because appending UTF-8 to it makes things
worse. Re-save it first:

```powershell
Get-Content "$env:USERPROFILE\.aws\config" | Set-Content -Encoding utf8 "$env:USERPROFILE\.aws\config.fixed"
```

then replace the original.

**One bad line.** `configparser`, which the CLI uses, refuses the *whole* file
for a setting above the first `[section]`, a line that is neither a header nor
`key = value`, a header missing its `]`, or the same section declared twice. One
stray line therefore stops every profile in the file from working. The app
checks for all four and quotes the offending line with its number, rather than
adding a correct profile to a file nothing can read.

**The file is somewhere else.** See above.

## When the session expires

SSO tokens expire on your organization's schedule. The app cannot renew them;
it will ask you to sign in again. That is SSO working as designed.
