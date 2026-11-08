# Install Rerun: a guide for AI assistants

You are helping someone install Rerun, an open source app where AI coworkers do work for a team.
This file tells you how to get them from nothing to the Foreman, Rerun's guide, answering in their
browser. The full human guide is https://docs.rerun.build/self-host/install: read it when a step
here is not enough.

## How to work

- **If you can run commands on their machine** (Claude Code, Codex, Cursor, a terminal agent): run
  the steps yourself, read every output, and only stop for what only the person can do: create an
  account, copy a key, choose a password, click in a dashboard.
- **If you are a chat in a browser** (claude.ai, chatgpt.com): you cannot touch their machine.
  Give one step at a time, with the exact command in a code block, and ask them to paste the
  output back before the next one. Never give the whole list at once.
- Keep it short. One question at a time, plain words, no jargon they did not use first.
- Never ask them to paste a secret key in the chat. Tell them which line of `.env` to put it on.

## 1. Ask three questions first

1. **Where should Rerun run?** On this computer, to try it alone, or on a server, for a team.
2. **Which Supabase?** Rerun keeps its data in Supabase. Offer the one that fits:
   - *On this computer*: Supabase started by `npx supabase start`. Nothing to sign up for. The
     simplest path, recommended for a first try.
   - *A free project on supabase.com*: recommended on a server.
   - *Open source Supabase on their own server*: only if they ask for everything on their
     machines. Follow the "Open source Supabase on your server" tab of the human guide.
3. **Do they have an OpenRouter key?** It runs the Foreman's guided onboarding. They get one at
   https://openrouter.ai/keys. Without it the Foreman skips the onboarding and runs on the AI they
   connect in the app, their Claude or ChatGPT subscription included.

## 2. Check the machine

They need Git, Node.js 22 or newer, and Docker with Docker Compose running. Docker needs at least
6 GB of memory and 60 GB of free disk: the first build uses about 40.

```bash
git --version && node --version && docker compose version && docker info --format '{{.MemTotal}}'
```

Help them install what is missing before going on. On macOS, Docker Desktop's memory is in
**Settings > Resources**.

## 3. Get the code

```bash
git clone https://github.com/rerun-build/rerun.git && cd rerun
cp .env.example .env
```

Every command below runs from this folder.

## 4. Set up Supabase

**On this computer:**

```bash
npx supabase start
npx supabase status
```

Put the API URL and keys in `.env`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54421
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<Publishable key from supabase status>
SUPABASE_SECRET_KEY=<Secret key from supabase status>
```

Sign-in codes land in Mailpit, at http://localhost:54424. Tell them: this setup is for one person on
one computer, never for a server reachable from the internet.

**Fedora with SELinux enforcing:** the Supabase CLI mounts the templates in
`supabase/templates/` without relabeling them, so they keep the `user_home_t` label
from the checkout and the container cannot read them. Kong answers 403, Auth falls
back to its default email, and the sign-in email arrives without the six-digit code.
Relabel the three files, from the repository root:

```bash
chcon -t container_file_t supabase/templates/confirmation.html supabase/templates/email_change.html supabase/templates/magic_link.html
```

`node scripts/self-host-check.mjs` fails with this fix while the labels are wrong, so
run it again after relabeling. Reapply the labels if a checkout or relabel resets
the files.

**A project on supabase.com:** walk them through it, they do the clicks.

1. Create a free project on https://supabase.com and note the database password.
2. In **Project settings > API keys**, copy the project URL, the publishable key and the secret key
   into `.env` (same three lines as above, with the project URL).
3. Apply the schema. `link` asks for the database password:

   ```bash
   npx supabase link --project-ref <the part before .supabase.co in the URL>
   npx supabase db push --include-seed
   ```

4. In **Authentication > Sign In / Providers**, turn on **Allow anonymous sign-ins**.
5. In **Authentication > Emails > SMTP Settings**, turn on **Custom SMTP** with their SMTP server.
   Do not skip it: on the Free plan, a project that keeps Supabase's own mailer cannot edit its
   templates, so the email arrives without the code, and that mailer sends 2 emails an hour, only
   to members of their Supabase organization.
6. Once SMTP is saved, in **Authentication > Email Templates**, paste
   `supabase/templates/magic_link.html` into **Magic Link**, **Confirm signup** and **Change Email
   Address**. Rerun signs in with a 6-digit code, and the default templates only carry a link. Set
   **Email OTP Expiration** to `900`.
7. In **Authentication > URL Configuration**, set the **Site URL** to `NEXT_PUBLIC_APP_URL`.

## 5. Fill the rest of `.env`

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000
OPENROUTER_API_KEY=sk-or-...
ADMIN_EMAILS=<their email>
```

On a server, `NEXT_PUBLIC_APP_URL` is the https address the team opens, and
`RERUN_ENGINE_BROWSER_URL` the https address of the engine, on a second domain. Both are baked in
by the build, so set them now. See "On a server" in the human guide for the reverse proxy and the
firewall: Docker publishes ports past `ufw`, so they must close 3000, 3001, 5432, 6543 and 8000
at their provider.

## 6. Check and start

```bash
node scripts/self-host-check.mjs
```

It generates the remaining secrets, asks Supabase whether the schema is in place and the secret
key is the right one, and prints the exact start command. When it stops, its message says what to
fix: do that and run it again. Then run the start command. With
Supabase on this computer it is:

```bash
docker compose --profile local-supabase up -d --build
```

Otherwise `docker compose up -d --build`. The first build takes several minutes: say so, and wait.

## 7. Verify

```bash
docker compose ps
curl -s http://localhost:3000/api/version
docker compose exec engine curl -s http://localhost:3000/health
```

`app` and `engine` are running, and both answer. If not, read `docker compose logs --tail 200 app
engine`, fix what it says, and check https://docs.rerun.build/self-host/troubleshooting.

## 8. Hand over

Tell them to open `NEXT_PUBLIC_APP_URL`, sign in with their email and the 6-digit code, and say
hi to the Foreman: it asks what they need done and builds the team. Their coworkers use the AI
they connect in the app: an Anthropic, OpenAI, Gemini or OpenRouter key, or their Claude or ChatGPT
subscription.

To update later:

```bash
git pull && docker compose up -d --build
```

and `npx supabase db push` (or `npx supabase migration up` for Supabase on this computer) when a
release adds database migrations.

Versions follow one rule: a patch (`v0.5.1`) only asks to pull, a minor (`v0.6.0`) has an
`Upgrade` section in its [release notes](https://github.com/rerun-build/rerun/releases) to read
first. The engine image `ghcr.io/rerun-build/rerun-engine:0.5` follows the patches of `0.5`.
